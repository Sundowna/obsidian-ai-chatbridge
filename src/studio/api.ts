// The ONLY place that talks to Google AI Studio.
// Rules: only the two read calls below (list prompts, read a prompt), no retries, stop on anything odd.
// Requests run inside a hidden aistudio.google.com window of the account's own Google login.
// They are signed the way AI Studio's own page signs them: a hash of the login cookie plus the
// public API key in the page. Both are read in the page and never leave it.

import { StopError } from '../api';
import { openReadyPage, type LoginRef, type ReadyPage } from '../login';
import { googleLogin } from '../gemini/api';
import { ShapeError } from '../schema';
import type { StudioPrompt } from '../gemini/types';
import type { ListItem } from '../types';
import { promptFileId, readPrompt, readPromptList } from './wire';

const START = 'https://aistudio.google.com/library';
const ORIGIN = 'https://aistudio.google.com';
const SERVICE = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
const ALLOWED = new Set(['ListPrompts', 'ResolveDriveResource']);
const OPEN_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 300;

const KEY_IN_PAGE = String.raw`(document.documentElement.innerHTML.match(/"WIu0Nc":"(AIza[\w-]{35})"/) || [])[1]`;
const READY = `location.origin === ${JSON.stringify(ORIGIN)} && /(?:^|; )SAPISID=/.test(document.cookie) && !!${KEY_IN_PAGE}`;

export class StudioApi {
	private constructor(private readonly page: ReadyPage) {}

	/** With no login in the login window, uses the pasted Google cookies (`fallback`) instead. */
	static async connect(login: LoginRef, fallback: string | null = null): Promise<StudioApi> {
		const pasted = await googleLogin(login, fallback);
		const page = await openReadyPage(login, START, READY, OPEN_TIMEOUT_MS, pasted);
		if (!page) {
			throw new StopError(pasted
				? 'AI Studio did not open signed in with the pasted cookies. They may have expired: paste fresh ones, or log in instead.'
				: 'AI Studio did not open signed in. Open aistudio.google.com once in the login window to accept its terms, or log in again.');
		}
		return new StudioApi(page);
	}

	close(): void {
		this.page.close();
	}

	async listPrompts(wait: () => Promise<void>, progress: (page: number) => void): Promise<ListItem[]> {
		const byId = new Map<string, ListItem>();
		let token: string | null = null;
		for (let page = 1; page <= MAX_PAGES; page++) {
			progress(page);
			await wait();
			const r = readPromptList(await this.call('ListPrompts', token ? [PAGE_SIZE, token] : [PAGE_SIZE]));
			for (const it of r.items) if (!byId.has(it.uuid)) byId.set(it.uuid, it);
			if (!r.next || r.next === token) return [...byId.values()];
			token = r.next;
		}
		throw new StopError('The AI Studio prompt list did not end. Nothing was saved.');
	}

	/** Null when the prompt is gone (deleted from Drive since the list was read). */
	async prompt(name: string, wait: () => Promise<void>): Promise<StudioPrompt | null> {
		await wait();
		const payload = await this.call('ResolveDriveResource', [promptFileId(name)]);
		return payload === null ? null : readPrompt(payload, name);
	}

	/** The single request used by everything above, sent by the page itself. */
	private async call(method: string, body: unknown[]): Promise<unknown> {
		if (!ALLOWED.has(method)) throw new StopError('Blocked an AI Studio call the plugin does not use.');
		const code = `(async () => {
			const key = ${KEY_IN_PAGE};
			const sid = (document.cookie.match(/(?:^|; )SAPISID=([^;]+)/) || [])[1];
			if (!key || !sid) return JSON.stringify({ status: 401, text: '' });
			const ts = Math.floor(Date.now() / 1000);
			const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sid + ' ' + ${JSON.stringify(ORIGIN)}));
			const h = ts + '_' + Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
			const r = await fetch(${JSON.stringify(SERVICE + method)}, { method: 'POST', credentials: 'include', headers: {
				'Content-Type': 'application/json+protobuf', 'X-Goog-Api-Key': key, 'X-Goog-AuthUser': '0',
				Authorization: 'SAPISIDHASH ' + h + ' SAPISID1PHASH ' + h + ' SAPISID3PHASH ' + h,
			}, body: ${JSON.stringify(JSON.stringify(body))} });
			return JSON.stringify({ status: r.status, text: await r.text() });
		})()`;
		let res: { status: number; text: string };
		try {
			res = JSON.parse(await this.page.run(code)) as { status: number; text: string };
		} catch {
			throw new StopError('Network error while talking to AI Studio.');
		}
		if (res.status === 401 || res.status === 403) throw new StopError(`AI Studio answered ${res.status} (not logged in). Log in to Google again in the plugin settings.`);
		if (res.status === 404 && method === 'ResolveDriveResource') return null;
		if (res.status === 429) throw new StopError('AI Studio is rate limiting this account. Try again later.');
		if (res.status !== 200) throw new StopError(`AI Studio answered ${res.status}, so the sync stopped.`);
		try {
			return JSON.parse(res.text);
		} catch {
			throw new ShapeError('AI Studio reply is not JSON');
		}
	}
}
