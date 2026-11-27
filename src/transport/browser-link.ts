// The Browser link transport: requests and pages go through the owner's own browser, where
// they are logged in, by way of the ChatBridge extension and the link server on 127.0.0.1.
// The plugin never sees a cookie or a login value here. When the browser cannot be reached
// this throws BrowserLinkUnavailable, which a sync shows as "skipped", not as an error.

import type { RequestUrlResponse } from 'obsidian';
import { BrowserLinkUnavailable } from '../link/errors';
import type { LinkServer } from '../link/server';
import type { PastedCookies } from '../login';
import type { PageAnswer, PageCall, PageValue, ReadyCheck, SitePage, SiteRequest, Transport } from './types';

/** The site's name in messages ("Not logged in to Gemini in your browser"). */
function siteName(url: string): string {
	try {
		const host = new URL(url).host;
		if (host === 'gemini.google.com') return 'Gemini';
		if (host === 'aistudio.google.com') return 'AI Studio';
		if (host === 'chatgpt.com') return 'ChatGPT';
		if (host === 'claude.ai') return 'claude.ai';
		return host;
	} catch {
		return 'this site';
	}
}

function answer(status: number, headers: Record<string, string>, body: Uint8Array): RequestUrlResponse {
	const arrayBuffer = new Uint8Array(body).buffer;
	let text: string | undefined;
	const readText = () => (text ??= new TextDecoder().decode(body));
	return {
		status,
		headers,
		arrayBuffer,
		get text() { return readText(); },
		get json(): unknown {
			const value: unknown = JSON.parse(readText());
			return value;
		},
	};
}

export class BrowserLinkTransport implements Transport {
	readonly kind = 'browser-link' as const;

	constructor(private readonly server: () => LinkServer | null) {}

	/** The link, or why it cannot be used right now. */
	private live(): LinkServer {
		const s = this.server();
		if (!s || !s.paired) throw new BrowserLinkUnavailable('not-paired');
		if (!s.linked) throw new BrowserLinkUnavailable('browser-closed');
		return s;
	}

	async request(req: SiteRequest): Promise<RequestUrlResponse> {
		const s = this.live();
		// The browser adds its own cookies and browser name; headers that only carried the login
		// window's login are left out (the browser would refuse some of them anyway).
		const drop = new Set((req.loginOnly ?? []).map((h) => h.toLowerCase()));
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) if (!drop.has(k.toLowerCase())) headers[k] = v;
		if (req.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = req.contentType;
		const r = await s.fetch(req.url, req.method, headers, req.body);
		return answer(r.status, r.headers, r.body);
	}

	canFetchInBrowser(): boolean {
		return true;
	}

	async fetchInBrowser(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
		const s = this.live();
		const method = (init.method ?? 'GET').toUpperCase();
		if (method !== 'GET' && method !== 'POST') throw new Error(`The Browser link sends only GET and POST, not ${method}.`);
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
		const body = typeof init.body === 'string' || init.body instanceof ArrayBuffer ? init.body : undefined;
		const r = await s.fetch(url, method, headers, body, init.redirect === 'manual' ? 'manual' : 'follow', timeoutMs);
		// A redirect the caller wanted to see comes back from the page as status 0 (opaque).
		const status = r.status >= 200 && r.status <= 599 ? r.status : 302;
		const empty = status === 204 || status === 205 || status === 304 || r.body.length === 0;
		return new Response(empty ? null : (r.body as unknown as BodyInit), { status, headers: r.headers });
	}

	isLoggedIn(): Promise<boolean> {
		// Whether the browser is logged in to the site shows only when its page opens; here it is
		// enough that the link is up (otherwise this says why not).
		try {
			this.live();
			return Promise.resolve(true);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : new Error(String(e)));
		}
	}

	async openPage(url: string, ready: ReadyCheck, timeoutMs: number, _pasted?: PastedCookies): Promise<SitePage | null> {
		const s = this.live();
		let page: string;
		try {
			page = await s.open(url, ready, timeoutMs);
		} catch (e) {
			if (e instanceof BrowserLinkUnavailable && e.reason === 'not-logged-in') throw new BrowserLinkUnavailable('not-logged-in', siteName(url));
			throw e;
		}
		return {
			call: (c: PageCall): Promise<PageAnswer> => s.call(page, c),
			read: (v: PageValue): Promise<string> => s.read(page, v),
			close: () => void s.closePage(page),
		};
	}
}
