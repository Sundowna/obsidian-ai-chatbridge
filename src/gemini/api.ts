// The ONLY place that talks to gemini.google.com.
// Rules: only the two read calls below (list chats, read a chat), no retries, stop on anything odd.
// Requests run inside a hidden window of the account's own Google login, so the page supplies
// its own cookies and request token; the plugin never sees or stores them. Without a login
// there, the cookies pasted in the settings go into a separate in-memory window instead.

import { StopError } from '../api';
import { googleCookies } from '../cookies';
import { GEMINI_SIGNED_IN, isLoggedIn, openReadyPage, type LoginRef, type PastedCookies, type ReadyPage } from '../login';
import { batchPayload, checkChatId, readChatPage, readListPage } from './wire';
import type { GeminiListItem } from './types';

const START = 'https://gemini.google.com/app';
const OPEN_TIMEOUT_MS = 45_000;
const LIST_CHATS = 'MaZiqc';
const READ_CHAT = 'hNvQHb';
const ALLOWED = new Set([LIST_CHATS, READ_CHAT]);
const LIST_PAGE = 50;
const TURN_PAGE = 20;
const MAX_PAGES = 300; // a guard against an endless paging loop

/**
 * Undefined when the login window is signed in (it is used as it is); otherwise the pasted
 * cookies to use. Stops if there are neither, or the pasted text is not a Google login.
 */
export async function googleLogin(login: LoginRef, fallback: string | null): Promise<PastedCookies | undefined> {
	if (await isLoggedIn(login)) return undefined;
	if (!fallback) throw new StopError('Not logged in to Google. Select "Log in" for this account in the plugin settings.');
	const pairs = googleCookies(fallback);
	if (!pairs) throw new StopError('The Google cookies in the plugin settings do not look right. Paste the whole Cookie header of a gemini.google.com request (it must include __Secure-1PSID and SAPISID), or log in instead.');
	return { pairs, domain: '.google.com' };
}

export class GeminiApi {
	private constructor(private readonly page: ReadyPage) {}

	/** With no login in the login window, uses the pasted Google cookies (`fallback`) instead. */
	static async connect(login: LoginRef, fallback: string | null = null): Promise<GeminiApi> {
		const pasted = await googleLogin(login, fallback);
		const page = await openReadyPage(login, START, GEMINI_SIGNED_IN, OPEN_TIMEOUT_MS, pasted);
		if (!page) {
			throw new StopError(pasted
				? 'Gemini did not open signed in with the pasted cookies. They may have expired: paste fresh ones, or log in instead.'
				: 'Gemini did not open signed in. Log in to Google again in the plugin settings.');
		}
		return new GeminiApi(page);
	}

	close(): void {
		this.page.close();
	}

	/** Every chat: the pinned ones and the rest. */
	async listChats(wait: () => Promise<void>, progress: (page: number) => void): Promise<GeminiListItem[]> {
		const byId = new Map<string, GeminiListItem>();
		let page = 0;
		for (const pinned of [true, false]) {
			let cursor: string | null = null;
			const seen = new Set<string>();
			do {
				if (++page > MAX_PAGES) throw new StopError('The Gemini chat list did not end. Nothing was saved.');
				progress(page);
				await wait();
				const r = readListPage(await this.call(LIST_CHATS, [LIST_PAGE, cursor, [pinned ? 1 : 0, null, 1]]), pinned);
				for (const item of r.items) if (!byId.has(item.uuid)) byId.set(item.uuid, item);
				if (r.next && seen.has(r.next)) break;
				cursor = r.next;
				if (cursor) seen.add(cursor);
			} while (cursor);
		}
		return [...byId.values()];
	}

	/** Every turn of a chat, newest first, as Google sends them. */
	async chatTurns(id: string, wait: () => Promise<void>): Promise<unknown[][]> {
		checkChatId(id);
		const turns: unknown[][] = [];
		let cursor: string | null = null;
		for (let page = 1; page <= MAX_PAGES; page++) {
			await wait();
			const r = readChatPage(await this.call(READ_CHAT, [id, TURN_PAGE, cursor, 1, [1], [4], null, 1]));
			turns.push(...r.turns);
			if (!r.next || r.next === cursor || !r.turns.length) return turns;
			cursor = r.next;
		}
		throw new StopError('A Gemini chat did not end. Nothing more was saved.');
	}

	/** The single request used by everything above, sent by the page itself. */
	private async call(rpcId: string, args: unknown[]): Promise<unknown> {
		if (!ALLOWED.has(rpcId)) throw new StopError('Blocked a Gemini call the plugin does not use.');
		const code = `(async () => {
			const w = window.WIZ_global_data || {};
			if (typeof w.SNlM0e !== 'string') return JSON.stringify({ status: 401, text: '' });
			const q = new URLSearchParams({ rpcids: ${JSON.stringify(rpcId)}, 'source-path': '/app', bl: w.cfb2h || '', 'f.sid': w.FdrFJe || '', hl: 'en', _reqid: String(100000 + Math.floor(Math.random() * 900000)), rt: 'c' });
			const body = new URLSearchParams({ 'f.req': JSON.stringify([[[${JSON.stringify(rpcId)}, ${JSON.stringify(JSON.stringify(args))}, null, 'generic']]]), at: w.SNlM0e });
			const r = await fetch('/_/BardChatUi/data/batchexecute?' + q, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' }, body });
			return JSON.stringify({ status: r.status, text: await r.text() });
		})()`;
		let res: { status: number; text: string };
		try {
			res = JSON.parse(await this.page.run(code)) as { status: number; text: string };
		} catch {
			throw new StopError('Network error while talking to Gemini.');
		}
		if (res.status === 401 || res.status === 403) throw new StopError(`Gemini answered ${res.status} (not logged in). Log in to Google again in the plugin settings.`);
		if (res.status === 429) throw new StopError('Gemini is rate limiting this account. Try again later.');
		if (res.status !== 200) throw new StopError(`Gemini answered ${res.status}, so the sync stopped.`);
		return batchPayload(res.text, rpcId);
	}
}
