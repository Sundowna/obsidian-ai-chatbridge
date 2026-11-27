// The login-window transport: today's behaviour, unchanged. Requests go out through
// Obsidian's requestUrl with the login headers the caller built; browser-storage requests and
// pages go through the account's login window (src/login.ts). Signed page calls are turned
// back into the same code the Gemini and AI Studio modules used to run in the page.

import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { cookieValue, GEMINI_SIGNED_IN, hasLoginFetch, isLoggedIn, loginFetch, openReadyPage, type LoginRef, type PastedCookies } from '../login';
import type { PageAnswer, PageCall, PageValue, ReadyCheck, SitePage, SiteRequest, SiteValue, Transport } from './types';

/** The cookie behind each named site value. */
export const SITE_VALUE_COOKIE: Record<SiteValue, string> = {
	'claude-org': 'lastActiveOrg',
	'chatgpt-device-id': 'oai-did',
	'chatgpt-workspace': '_account',
};

/** AI Studio's public API key, as its page carries it. */
const STUDIO_KEY_IN_PAGE = String.raw`(document.documentElement.innerHTML.match(/"WIu0Nc":"(AIza[\w-]{35})"/) || [])[1]`;

/** The page code for each named ready check. */
export const READY_CODE: Record<ReadyCheck, string> = {
	'gemini-signed-in': GEMINI_SIGNED_IN,
	'studio-ready': `location.origin === "https://aistudio.google.com" && /(?:^|; )SAPISID=/.test(document.cookie) && !!${STUDIO_KEY_IN_PAGE}`,
};

/** The page code for each named page value; it produces a string. */
export const READ_CODE: Record<PageValue, string> = {
	'google-account-id': `String((window.WIZ_global_data || {}).S06Grb || '')`,
};

/**
 * The code a login window runs for one signed call. It produces a JSON string
 * `{status, text, headers}`, or `{status: 401}` when the page holds no login values.
 */
export function pageCallCode(c: PageCall): string {
	const call = JSON.stringify(c);
	if (c.sign === 'wiz-at') {
		return `(async () => {
			const c = ${call};
			const w = window.WIZ_global_data || {};
			if (typeof w.SNlM0e !== 'string') return JSON.stringify({ status: 401, text: '' });
			const u = new URL(c.url, location.href);
			u.searchParams.set('bl', w.cfb2h || '');
			u.searchParams.set('f.sid', w.FdrFJe || '');
			const body = new URLSearchParams(c.body);
			body.set('at', w.SNlM0e);
			const r = await fetch(u.toString(), { method: c.method, credentials: 'same-origin', headers: c.headers, body });
			return JSON.stringify({ status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) });
		})()`;
	}
	return `(async () => {
		const c = ${call};
		const key = ${STUDIO_KEY_IN_PAGE};
		const sid = (document.cookie.match(/(?:^|; )SAPISID=([^;]+)/) || [])[1];
		if (!key || !sid) return JSON.stringify({ status: 401, text: '' });
		const ts = Math.floor(Date.now() / 1000);
		const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sid + ' ' + location.origin));
		const h = ts + '_' + Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
		const headers = Object.assign({}, c.headers, { 'X-Goog-Api-Key': key, Authorization: 'SAPISIDHASH ' + h + ' SAPISID1PHASH ' + h + ' SAPISID3PHASH ' + h });
		const r = await fetch(c.url, { method: c.method, credentials: 'include', headers, body: c.body });
		return JSON.stringify({ status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) });
	})()`;
}

/** A request through Obsidian's requestUrl with the headers as given (login headers included). */
export async function loginWindowRequest(req: SiteRequest): Promise<RequestUrlResponse> {
	const param: RequestUrlParam = { url: req.url, method: req.method, headers: req.headers, throw: false };
	if (req.contentType !== undefined) param.contentType = req.contentType;
	if (req.body !== undefined) param.body = req.body;
	return requestUrl(param);
}

export class LoginWindowTransport implements Transport {
	readonly kind = 'login-window' as const;

	constructor(private readonly login: LoginRef) {}

	request(req: SiteRequest): Promise<RequestUrlResponse> {
		return loginWindowRequest(req);
	}

	canFetchInBrowser(): boolean {
		return hasLoginFetch(this.login);
	}

	fetchInBrowser(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
		return loginFetch(this.login, url, init, timeoutMs);
	}

	isLoggedIn(): Promise<boolean> {
		return isLoggedIn(this.login);
	}

	siteValue(v: SiteValue): Promise<string | null> {
		return cookieValue(this.login, SITE_VALUE_COOKIE[v]);
	}

	async openPage(url: string, ready: ReadyCheck, timeoutMs: number, pasted?: PastedCookies): Promise<SitePage | null> {
		const page = await openReadyPage(this.login, url, READY_CODE[ready], timeoutMs, pasted);
		if (!page) return null;
		return {
			close: () => page.close(),
			call: async (c) => JSON.parse(await page.run(pageCallCode(c))) as PageAnswer,
			read: (v) => page.run(READ_CODE[v]),
		};
	}
}
