// How a sync reaches a provider's site with the account's login. Sync code only talks to a
// Transport and never knows which one ran. Today there is one: the login window (Electron
// storage inside Obsidian). The Browser link (the owner's own browser, through a small
// extension) comes next and must answer the same way.

import type { RequestUrlResponse } from 'obsidian';
import type { PastedCookies } from '../login';

export type TransportKind = 'login-window' | 'browser-link';

/** A request to the provider's site. */
export interface SiteRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	contentType?: string;
	body?: string | ArrayBuffer;
	/**
	 * Header names in `headers` that only carry the login window's login (its cookies, its
	 * browser name). A route that uses the browser's own login drops them.
	 */
	loginOnly?: readonly string[];
}

/** How the page signs a call itself: values read inside the page, never handed out. */
export type PageSigning =
	/** Gemini batchexecute: `at` in the form body, `bl` and `f.sid` in the query. */
	| 'wiz-at'
	/** Google APIs (AI Studio): Authorization from SAPISID, X-Goog-Api-Key from the page. */
	| 'sapisidhash';

/** Named tests for "this page is open and signed in". No code strings travel. */
export type ReadyCheck = 'gemini-signed-in' | 'studio-ready';

/** Named values read from the page (not secret). No code strings travel. */
export type PageValue =
	/** Google's number for the signed-in account (`WIZ_global_data.S06Grb`), or ''. */
	| 'google-account-id';

/**
 * Named values read from the site with the account's login (not secret): small cookies the
 * site's own page can read. The login window reads them from its storage, the Browser link
 * from a tab of the site.
 */
export type SiteValue =
	/** claude.ai's organization of this login (`lastActiveOrg`). */
	| 'claude-org'
	/** ChatGPT's device ID (`oai-did`). */
	| 'chatgpt-device-id'
	/** ChatGPT's workspace (`_account`). */
	| 'chatgpt-workspace';

/** One signed request sent by the site's own page. */
export interface PageCall {
	url: string;
	method: 'POST';
	headers: Record<string, string>;
	body: string;
	sign: PageSigning;
}

export interface PageAnswer {
	status: number;
	text: string;
	headers?: Record<string, string>;
}

/** A page of the site, open and signed in. */
export interface SitePage {
	/** Sends one signed call from the page. Throws when the page is gone or the call failed below HTTP. */
	call(c: PageCall): Promise<PageAnswer>;
	/** Reads one named value from the page; '' when the page does not have it. */
	read(v: PageValue): Promise<string>;
	close(): void;
}

export interface Transport {
	readonly kind: TransportKind;
	/** A request to the site. Never throws for an HTTP status; throws on a network error. */
	request(req: SiteRequest): Promise<RequestUrlResponse>;
	/** True when `fetchInBrowser` can run here. */
	canFetchInBrowser(): boolean;
	/** A request through the login's own browser storage (cookies it sends back are kept), redirects left to the caller. */
	fetchInBrowser(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
	isLoggedIn(): Promise<boolean>;
	/** One named value from the site; null when the site has none (e.g. not logged in). */
	siteValue(v: SiteValue): Promise<string | null>;
	/** A page of the site once `ready` holds there; null if it never does (not signed in, or the site changed). */
	openPage(url: string, ready: ReadyCheck, timeoutMs: number, pasted?: PastedCookies): Promise<SitePage | null>;
}
