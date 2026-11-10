// The ONLY place that talks to gemini.google.com.
// Rules: only the two read calls below (list chats, read a chat), no retries, stop on anything odd.
// Requests run inside a hidden window of the account's own Google login, so the page supplies
// its own cookies and request token; the plugin never sees or stores them.

import { StopError } from '../api';
import { GEMINI_SIGNED_IN, isLoggedIn, openReadyPage, type LoginRef, type ReadyPage } from '../login';
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

export class GeminiApi {
	private constructor(private readonly page: ReadyPage) {}

	static async connect(login: LoginRef): Promise<GeminiApi> {
		if (!(await isLoggedIn(login))) throw new StopError('Not logged in to Google. Select "Log in" for this account in the plugin settings.');
		const page = await openReadyPage(login, START, GEMINI_SIGNED_IN, OPEN_TIMEOUT_MS);
		if (!page) throw new StopError('Gemini did not open signed in. Log in to Google again in the plugin settings.');
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
