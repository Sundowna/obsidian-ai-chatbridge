// The ONLY place that talks to gemini.google.com.
// Rules: only the two read calls below (list chats, read a chat), no retries, stop on anything odd.
// Requests run inside a hidden window of the account's own Google login, so the page supplies
// its own cookies and request token; the plugin never sees or stores them. Without a login
// there, the cookies pasted in the settings go into a separate in-memory window instead.

import { RateLimitError, StopError } from '../api';
import { googleCookies } from '../cookies';
import type { LoginRef, PastedCookies } from '../login';
import { recordError, type ErrorSource } from '../error-log';
import { transportFor, type PageAnswer, type SitePage, type Transport } from '../transport';
import { googleAccountId } from './save';
import { NetworkFailure, sendWithRetry, triedText } from '../net-retry';
import { retryDeadline } from '../rate-limit';
import { BrowserLinkUnavailable } from '../link/errors';
import { batchPayload, checkChatId, readChatPage, readListPage } from './wire';
import type { GeminiListItem } from './types';

const START = 'https://gemini.google.com/app';
const OPEN_TIMEOUT_MS = 45_000;
const LIST_CHATS = 'MaZiqc';
const READ_CHAT = 'hNvQHb';
/** Gems: [2, [lang], 0] = your own (AI memory), seen 2026-11-27. */
const LIST_GEMS = 'CNgdBe';
const ALLOWED = new Set([LIST_CHATS, READ_CHAT, LIST_GEMS]);
const LIST_PAGE = 50;
const TURN_PAGE = 20;
const MAX_PAGES = 300; // a guard against an endless paging loop

/**
 * Undefined when the login window is signed in (it is used as it is); otherwise the pasted
 * cookies to use. Stops if there are neither, or the pasted text is not a Google login.
 */
export async function googleLogin(login: LoginRef, fallback: string | null): Promise<PastedCookies | undefined> {
	if (await transportFor(login).isLoggedIn()) return undefined;
	if (!fallback) throw new StopError('Not logged in to Google. Select "Log in" for this account in the plugin settings.');
	const pairs = googleCookies(fallback);
	if (!pairs) throw new StopError('The Google cookies in the plugin settings do not look right. Paste the whole Cookie header of a gemini.google.com request (it must include __Secure-1PSID and SAPISID), or log in instead.');
	return { pairs, domain: '.google.com' };
}

/** The answer's Retry-After header (a page's fetch gives header names in lower case), or ''. */
const retryAfter = (headers: Record<string, string> | undefined): string => headers?.['retry-after'] ?? headers?.['Retry-After'] ?? '';

export class GeminiApi {
	private constructor(private readonly page: SitePage, private readonly source: ErrorSource, private readonly transport?: Transport) {}

	/** With no login in the login window, uses the pasted Google cookies (`fallback`) instead. */
	static async connect(login: LoginRef, fallback: string | null = null): Promise<GeminiApi> {
		const pasted = await googleLogin(login, fallback);
		const page = await transportFor(login).openPage(START, 'gemini-signed-in', OPEN_TIMEOUT_MS, pasted);
		if (!page) {
			recordError({ provider: 'gemini', accountId: login.id }, { service: 'Gemini', method: 'OPEN', url: START, status: null, message: 'the Gemini page did not open signed in' });
			throw new StopError(pasted
				? 'Gemini did not open signed in with the pasted cookies. They may have expired: paste fresh ones, or log in instead.'
				: 'Gemini did not open signed in. Log in to Google again in the plugin settings.');
		}
		return new GeminiApi(page, { provider: 'gemini', accountId: login.id }, transportFor(login));
	}

	close(): void {
		this.page.close();
	}

	/** Google's number for the signed-in account (not secret), or '' when the page does not say. Seen 2026-11-27. */
	async accountId(): Promise<string> {
		try {
			return googleAccountId(await this.page.read('google-account-id'));
		} catch {
			return '';
		}
	}

	/**
	 * Every chat: the pinned ones and the rest. `settled` is shown every page and may end that
	 * list early (quick-list.ts).
	 */
	async listChats(wait: () => Promise<void>, progress: (page: number) => void, settled?: (page: GeminiListItem[], pinned: boolean) => boolean): Promise<GeminiListItem[]> {
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
				if (settled?.(r.items, pinned) === true) break;
				if (r.next && seen.has(r.next)) break;
				cursor = r.next;
				if (cursor) seen.add(cursor);
			} while (cursor);
		}
		return [...byId.values()];
	}

	/**
	 * A picture Gemini made, full size, with the Google login (it answers 403 without one), or null
	 * when it cannot be fetched here (a pasted-cookie login, or Google refused it). Only Gemini's
	 * own picture addresses are asked for. Seen 2026-11-27: `=s0` gives the full size.
	 */
	async picture(url: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
		const full = pictureUrl(url);
		if (!full || !this.transport?.canFetchInBrowser()) return null;
		let res: Response;
		try {
			res = await this.transport.fetchInBrowser(full, { method: 'GET', credentials: 'include' }, 60_000);
		} catch (e) {
			if (e instanceof BrowserLinkUnavailable) throw e;
			return null;
		}
		const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
		if (res.status === 429) throw new RateLimitError('Gemini', retryDeadline(res.headers.get('retry-after') ?? ''));
		if (res.status !== 200 || !type.startsWith('image/')) return null;
		const bytes = await res.arrayBuffer();
		return bytes.byteLength ? { bytes, type } : null;
	}

	/** Your own Gems (name, description, instructions), as Gemini sends them. Read only. */
	async myGems(): Promise<unknown> {
		return this.call(LIST_GEMS, [2, ['en'], 0]);
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
		// The page adds its own request token (`at`) and build values (`bl`, `f.sid`).
		const q = new URLSearchParams({ rpcids: rpcId, 'source-path': '/app', hl: 'en', _reqid: String(100000 + Math.floor(Math.random() * 900000)), rt: 'c' });
		const body = new URLSearchParams({ 'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]) }).toString();
		let res: PageAnswer;
		try {
			res = await sendWithRetry(() => this.page.call({
				url: `https://gemini.google.com/_/BardChatUi/data/batchexecute?${q.toString()}`,
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
				body,
				sign: 'wiz-at',
			}));
		} catch (e) {
			// The Browser link went away (browser closed): the sync skips this account.
			if (e instanceof NetworkFailure && e.cause instanceof BrowserLinkUnavailable) throw e.cause;
			const tried = e instanceof NetworkFailure ? triedText(e.tries) : '';
			recordError(this.source, { service: 'Gemini', method: 'POST', url: `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=${rpcId}`, status: null, message: `Network error while talking to Gemini${tried}.` });
			throw new StopError(`Network error while talking to Gemini${tried}.`);
		}
		if (res.status !== 200) recordError(this.source, { service: 'Gemini', method: 'POST', url: `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=${rpcId}`, status: res.status, headers: res.headers, body: res.text, message: `Gemini answered ${res.status}` });
		if (res.status === 401 || res.status === 403) throw new StopError(`Gemini answered ${res.status} (not logged in). Log in to Google again in the plugin settings.`);
		if (res.status === 429) throw new RateLimitError('Gemini', retryDeadline(retryAfter(res.headers)));
		if (res.status !== 200) throw new StopError(`Gemini answered ${res.status}, so the sync stopped.`);
		return batchPayload(res.text, rpcId);
	}
}

/** A picture Gemini made, as its full-size address; null for any other address. */
export function pictureUrl(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' || u.host !== 'lh3.googleusercontent.com' || u.username || u.password) return null;
	const m = /^\/(gg|rd-gg)\/([\w-]+)(?:=[\w-]*)?$/.exec(u.pathname);
	return m ? `https://lh3.googleusercontent.com/${m[1]}/${m[2]}=s0` : null;
}
