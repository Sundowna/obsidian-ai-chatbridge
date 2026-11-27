// The ONLY place that talks to Google AI Studio.
// Rules: only the two read calls below (list prompts, read a prompt), no retries, stop on anything odd.
// Requests run inside a hidden aistudio.google.com window of the account's own Google login.
// They are signed the way AI Studio's own page signs them: a hash of the login cookie plus the
// public API key in the page. Both are read in the page and never leave it.

import { RateLimitError, StopError } from '../api';
import type { LoginRef } from '../login';
import { recordError, type ErrorSource } from '../error-log';
import { transportFor, type PageAnswer, type SitePage } from '../transport';
import { NetworkFailure, sendWithRetry, triedText } from '../net-retry';
import { retryDeadline } from '../rate-limit';
import { BrowserLinkUnavailable } from '../link/errors';
import { googleLogin } from '../gemini/api';
import { ShapeError } from '../schema';
import type { StudioPrompt } from '../gemini/types';
import type { ListItem } from '../types';
import { promptFileId, readPrompt, readPromptList } from './wire';

const START = 'https://aistudio.google.com/library';
const SERVICE = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
const ALLOWED = new Set(['ListPrompts', 'ResolveDriveResource']);
const OPEN_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 300;

/** The answer's Retry-After header (a page's fetch gives header names in lower case), or ''. */
const retryAfter = (headers: Record<string, string> | undefined): string => headers?.['retry-after'] ?? headers?.['Retry-After'] ?? '';

export class StudioApi {
	private constructor(private readonly page: SitePage, private readonly source: ErrorSource) {}

	/** With no login in the login window, uses the pasted Google cookies (`fallback`) instead. */
	static async connect(login: LoginRef, fallback: string | null = null): Promise<StudioApi> {
		const pasted = await googleLogin(login, fallback);
		const page = await transportFor(login).openPage(START, 'studio-ready', OPEN_TIMEOUT_MS, pasted);
		if (!page) {
			recordError({ provider: 'gemini', accountId: login.id }, { service: 'AI Studio', method: 'OPEN', url: START, status: null, message: 'the AI Studio page did not open signed in' });
			throw new StopError(pasted
				? 'AI Studio did not open signed in with the pasted cookies. They may have expired: paste fresh ones, or log in instead.'
				: 'AI Studio did not open signed in. Open aistudio.google.com once in the login window to accept its terms, or log in again.');
		}
		return new StudioApi(page, { provider: 'gemini', accountId: login.id });
	}

	close(): void {
		this.page.close();
	}

	/** Every prompt of the library. `settled` is shown every page and may end the list early (quick-list.ts). */
	async listPrompts(wait: () => Promise<void>, progress: (page: number) => void, settled?: (page: ListItem[]) => boolean): Promise<ListItem[]> {
		const byId = new Map<string, ListItem>();
		let token: string | null = null;
		for (let page = 1; page <= MAX_PAGES; page++) {
			progress(page);
			await wait();
			const r = readPromptList(await this.call('ListPrompts', token ? [PAGE_SIZE, token] : [PAGE_SIZE]));
			for (const it of r.items) if (!byId.has(it.uuid)) byId.set(it.uuid, it);
			if (settled?.(r.items) === true || !r.next || r.next === token) return [...byId.values()];
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
		// The page adds the API key and the login hash itself.
		let res: PageAnswer;
		try {
			res = await sendWithRetry(() => this.page.call({
				url: SERVICE + method,
				method: 'POST',
				headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-AuthUser': '0' },
				body: JSON.stringify(body),
				sign: 'sapisidhash',
			}));
		} catch (e) {
			// The Browser link went away (browser closed): the sync skips this account.
			if (e instanceof NetworkFailure && e.cause instanceof BrowserLinkUnavailable) throw e.cause;
			const tried = e instanceof NetworkFailure ? triedText(e.tries) : '';
			recordError(this.source, { service: 'AI Studio', method: 'POST', url: SERVICE + method, status: null, message: `Network error while talking to AI Studio${tried}.` });
			throw new StopError(`Network error while talking to AI Studio${tried}.`);
		}
		if (res.status !== 200 && !(res.status === 404 && method === 'ResolveDriveResource')) {
			recordError(this.source, { service: 'AI Studio', method: 'POST', url: SERVICE + method, status: res.status, headers: res.headers, body: res.text, message: `AI Studio answered ${res.status}` });
		}
		if (res.status === 401 || res.status === 403) throw new StopError(`AI Studio answered ${res.status} (not logged in). Log in to Google again in the plugin settings.`);
		if (res.status === 404 && method === 'ResolveDriveResource') return null;
		if (res.status === 429) throw new RateLimitError('AI Studio', retryDeadline(retryAfter(res.headers)));
		if (res.status !== 200) throw new StopError(`AI Studio answered ${res.status}, so the sync stopped.`);
		try {
			return JSON.parse(res.text);
		} catch {
			recordError(this.source, { service: 'AI Studio', method: 'POST', url: SERVICE + method, status: res.status, headers: res.headers, body: res.text, message: 'AI Studio reply is not JSON' });
			throw new ShapeError('AI Studio reply is not JSON');
		}
	}
}
