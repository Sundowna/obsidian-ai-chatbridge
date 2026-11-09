// Login windows: you sign in on the real website, in a window inside Obsidian.
// The login cookies stay in that window's own Electron storage (outside the vault,
// encrypted by Windows) – never in data.json, never in a note, never logged.
// The plugin reads them in memory only, when it needs them for a sync.

export type Provider = 'claude' | 'chatgpt' | 'lumo';

/** Which login window: the account's id picks its own separate cookie storage. */
export interface LoginRef {
	provider: Provider;
	id: string;
}

interface Site {
	start: string;
	origin: string;
	partition: string;
	title: string;
	/** Cookie that proves you are logged in (null = not known yet; you close the window yourself). */
	loginCookie: string | null;
	/** The login cookie's name only starts with `loginCookie` (Proton adds the session's ID). */
	loginCookieIsPrefix?: boolean;
	/** Read cookies by domain, for sites that scope them to a path below the origin. */
	cookieDomain?: string;
	/** Runs in the login window; the login is finished once it returns true. */
	loginDoneInPage?: string;
}

export const SITES: Record<Provider, Site> = {
	claude: {
		start: 'https://claude.ai/login',
		origin: 'https://claude.ai',
		partition: 'persist:claude-chat-sync-claude',
		title: 'Log in to claude.ai',
		loginCookie: 'sessionKey',
	},
	chatgpt: {
		// The dedicated sign-in page, not the chat screen (checked 2026-11-09).
		start: 'https://chatgpt.com/auth/login',
		origin: 'https://chatgpt.com',
		partition: 'persist:claude-chat-sync-chatgpt',
		title: 'Log in to ChatGPT',
		// Seen in the login window's cookies (2026-11-06); ChatGPT splits it into .0 and .1.
		loginCookie: '__Secure-next-auth.session-token',
	},
	lumo: {
		// Proton's sign-in page for Lumo (checked 2026-11-09). It hands over to lumo.proton.me.
		start: 'https://account.proton.me/lumo',
		origin: 'https://lumo.proton.me',
		partition: 'persist:ai-chatbridge-lumo',
		title: 'Log in to Lumo',
		loginCookie: 'AUTH-',
		loginCookieIsPrefix: true,
		cookieDomain: 'lumo.proton.me',
		// The cookie comes first; the sync also needs the session Proton then saves in the page.
		// account.proton.me keeps "ps-" entries too, so the page must be Lumo's own.
		loginDoneInPage: `location.origin === 'https://lumo.proton.me' && Object.keys(localStorage).some((k) => k.startsWith('ps-'))`,
	},
};

// --- the small part of Electron we use (through Obsidian's electron.remote) ---
interface Cookie {
	name: string;
	value: string;
}
interface Session {
	fetch?(url: string, init: RequestInit): Promise<Response>;
	cookies: { get(filter: { url: string } | { domain: string }): Promise<Cookie[]> };
	clearStorageData(): Promise<void>;
	setUserAgent(ua: string): void;
	getUserAgent(): string;
	webRequest: {
		onSendHeaders(filter: { urls: string[] }, listener: (d: { id: number; requestHeaders: Record<string, string> }) => void): void;
		onSendHeaders(listener: null): void;
		onCompleted(filter: { urls: string[] }, listener: (d: { id: number; url: string; statusCode: number }) => void): void;
		onCompleted(listener: null): void;
	};
}
interface Win {
	loadURL(url: string): Promise<void>;
	isDestroyed(): boolean;
	close(): void;
	focus(): void;
	webContents: {
		removeAllListeners(event: string): void;
		setWindowOpenHandler(handler: (details: { url: string }) => unknown): void;
		executeJavaScript(code: string): Promise<unknown>;
	};
}
interface Remote {
	BrowserWindow: new (options: Record<string, unknown>) => Win;
	session: { fromPartition(partition: string): Session };
}

function remote(): Remote | null {
	const r = (window as unknown as { electron?: { remote?: Partial<Remote> } }).electron?.remote;
	return r?.BrowserWindow && r.session ? (r as Remote) : null;
}

/** The first account keeps the storage it always had, so upgrading does not log you out. */
function partition(login: LoginRef): string {
	const base = SITES[login.provider].partition;
	return login.id === 'default' ? base : `${base}-${login.id}`;
}

function session(login: LoginRef): Session {
	const r = remote();
	if (!r) throw new Error('Login windows are not available in this Obsidian (desktop only).');
	return r.session.fromPartition(partition(login));
}

/** Obsidian's browser name without the "Electron/…" and "obsidian/…" parts (some logins refuse those). */
function plainUserAgent(ses: Session): string {
	return ses.getUserAgent().replace(/\s(obsidian|Electron)\/\S+/gi, '');
}

/** The browser name the login window uses – requests must send the same one (Cloudflare checks it). */
export function loginUserAgent(login: LoginRef): string {
	return plainUserAgent(session(login));
}

/** Use the login window's Chromium transport with redirects under caller control. */
export async function loginFetch(login: LoginRef, url: string, init: RequestInit): Promise<Response> {
	const ses = session(login);
	if (!ses.fetch) throw new Error('This Obsidian build does not support controlled downloads.');
	return ses.fetch(url, init);
}

const open = new Map<string, Win>();
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const MAX_WAIT_MS = 15 * 60_000;

export type LoginResult = 'logged-in' | 'closed';

async function loginDone(win: Win, site: Site): Promise<boolean> {
	if (!site.loginDoneInPage) return true;
	try {
		return (await win.webContents.executeJavaScript(site.loginDoneInPage)) === true;
	} catch {
		return false; // the page is between navigations
	}
}

/**
 * Opens the website's login page in its own window and waits. Ends when the login
 * cookie appears (window closes itself) or when you close the window.
 */
export async function openLogin(login: LoginRef, accountLabel?: string): Promise<LoginResult> {
	const windowKey = partition(login);
	const existing = open.get(windowKey);
	if (existing && !existing.isDestroyed()) {
		existing.focus();
		return 'closed';
	}
	const r = remote();
	if (!r) throw new Error('Login windows are not available in this Obsidian (desktop only).');
	const site = SITES[login.provider];
	const ses = r.session.fromPartition(windowKey);
	ses.setUserAgent(plainUserAgent(ses));
	const win = new r.BrowserWindow({
		width: 1000,
		height: 800,
		title: accountLabel ? `${site.title} (${accountLabel})` : site.title,
		autoHideMenuBar: true,
		webPreferences: { partition: windowKey, nodeIntegration: false, contextIsolation: true, sandbox: true },
	});
	open.set(windowKey, win);
	// Obsidian hands every jump to another website to your default browser (it does this
	// for all its windows). Logins jump between sites (e.g. chatgpt.com -> auth.openai.com),
	// so this window – and only this one – keeps those jumps inside itself.
	win.webContents.removeAllListeners('will-navigate');
	// Links that would open a new window open in this window instead.
	// (Called back asynchronously, so Obsidian's main process gets no answer and blocks the popup.)
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https:\/\//i.test(url) && !win.isDestroyed()) win.loadURL(url).catch(() => undefined);
		return { action: 'deny' };
	});
	// Redirects during login make loadURL report "aborted"; that is normal.
	win.loadURL(site.start).catch(() => undefined);

	const started = Date.now();
	try {
		while (!win.isDestroyed()) {
			await sleep(1000);
			if (win.isDestroyed()) break;
			if (site.loginCookie && (await isLoggedIn(login)) && (await loginDone(win, site))) {
				win.close();
				return 'logged-in';
			}
			if (Date.now() - started > MAX_WAIT_MS) {
				win.close();
				break;
			}
		}
		return 'closed';
	} finally {
		open.delete(windowKey);
	}
}

/** A site opened invisibly with this account's login, once it has a working session. */
export interface HiddenPage {
	uid: string;
	appVersion: string;
	/** Runs code in the page; the code must produce a string. Never log the result. */
	run(code: string): Promise<string>;
	close(): void;
}

function requestHeader(headers: Record<string, string>, name: string): string {
	const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
	return key ? (headers[key] ?? '') : '';
}

/**
 * Opens `url` in a hidden window and waits until the page itself gets a 200 from a `ready`
 * API path, then keeps the identity headers that request used. Null if it never does.
 */
export async function openHiddenPage(login: LoginRef, url: string, apiUrls: string, ready: RegExp, timeoutMs: number): Promise<HiddenPage | null> {
	const r = remote();
	if (!r) throw new Error('Login windows are not available in this Obsidian (desktop only).');
	const windowKey = partition(login);
	const ses = r.session.fromPartition(windowKey);
	ses.setUserAgent(plainUserAgent(ses));
	const sent = new Map<number, { uid: string; appVersion: string }>();
	let identity: { uid: string; appVersion: string } | null = null;
	ses.webRequest.onSendHeaders({ urls: [apiUrls] }, (d) => {
		sent.set(d.id, { uid: requestHeader(d.requestHeaders, 'x-pm-uid'), appVersion: requestHeader(d.requestHeaders, 'x-pm-appversion') });
	});
	ses.webRequest.onCompleted({ urls: [apiUrls] }, (d) => {
		const headers = sent.get(d.id);
		sent.delete(d.id);
		if (d.statusCode === 200 && headers?.uid && headers.appVersion && ready.test(new URL(d.url).pathname)) identity = headers;
	});
	const stopWatching = () => {
		ses.webRequest.onSendHeaders(null);
		ses.webRequest.onCompleted(null);
	};
	const win = new r.BrowserWindow({
		show: false,
		webPreferences: { partition: windowKey, nodeIntegration: false, contextIsolation: true, sandbox: true },
	});
	const key = `${windowKey}:hidden`;
	open.set(key, win);
	const close = () => {
		stopWatching();
		open.delete(key);
		if (!win.isDestroyed()) win.close();
	};
	win.webContents.removeAllListeners('will-navigate');
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	win.loadURL(url).catch(() => undefined);

	const started = Date.now();
	while (!identity && !win.isDestroyed() && Date.now() - started < timeoutMs) await sleep(250);
	if (!identity || win.isDestroyed()) {
		close();
		return null;
	}
	const { uid, appVersion } = identity as { uid: string; appVersion: string };
	stopWatching();
	return {
		uid,
		appVersion,
		close,
		run: async (code) => {
			if (win.isDestroyed()) throw new Error('The hidden window was closed.');
			return String(await win.webContents.executeJavaScript(code));
		},
	};
}

/** The site's cookies, read in memory. Never store or log the values. */
async function cookies(login: LoginRef): Promise<Cookie[]> {
	const site = SITES[login.provider];
	const list = await session(login).cookies.get(site.cookieDomain ? { domain: site.cookieDomain } : { url: site.origin });
	return Array.from(list, (c) => ({ name: String(c.name), value: String(c.value) }));
}

export async function cookieValue(login: LoginRef, name: string): Promise<string | null> {
	try {
		const c = (await cookies(login)).find((x) => x.name === name);
		return c?.value ? c.value : null;
	} catch {
		return null;
	}
}

/** Names only (not secret) – shown in settings so you can see what the login left. */
export async function cookieNames(login: LoginRef): Promise<string[]> {
	try {
		return (await cookies(login)).map((c) => c.name).sort();
	} catch {
		return [];
	}
}

/** "name=value; …" for a request to the site. In memory only. */
export async function cookieHeader(login: LoginRef): Promise<string> {
	return (await cookies(login)).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** The login cookie is there – also when the site splits it into parts ("name.0", "name.1"). */
export async function isLoggedIn(login: LoginRef): Promise<boolean> {
	const site = SITES[login.provider];
	const want = site.loginCookie;
	if (!want) return (await cookieNames(login)).length > 0;
	const prefix = site.loginCookieIsPrefix ? want : `${want}.`;
	try {
		return (await cookies(login)).some((c) => (c.name === want || c.name.startsWith(prefix)) && c.value !== '');
	} catch {
		return false;
	}
}

/** Forgets the login: clears that window's cookies and storage. */
export async function logout(login: LoginRef): Promise<void> {
	await session(login).clearStorageData();
}

export function closeLoginWindows(): void {
	for (const w of open.values()) if (!w.isDestroyed()) w.close();
	open.clear();
}
