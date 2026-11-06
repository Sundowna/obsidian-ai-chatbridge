// Login windows: you sign in on the real website, in a window inside Obsidian.
// The login cookies stay in that window's own Electron storage (outside the vault,
// encrypted by Windows) – never in data.json, never in a note, never logged.
// The plugin reads them in memory only, when it needs them for a sync.

export type Account = 'claude' | 'chatgpt';

interface Site {
	start: string;
	origin: string;
	partition: string;
	title: string;
	/** Cookie that proves you are logged in (null = not known yet; you close the window yourself). */
	loginCookie: string | null;
}

export const SITES: Record<Account, Site> = {
	claude: {
		start: 'https://claude.ai/login',
		origin: 'https://claude.ai',
		partition: 'persist:claude-chat-sync-claude',
		title: 'Log in to claude.ai',
		loginCookie: 'sessionKey',
	},
	chatgpt: {
		start: 'https://chatgpt.com/',
		origin: 'https://chatgpt.com',
		partition: 'persist:claude-chat-sync-chatgpt',
		title: 'Log in to ChatGPT',
		// Seen in the login window's cookies (2026-11-06); ChatGPT splits it into .0 and .1.
		loginCookie: '__Secure-next-auth.session-token',
	},
};

// --- the small part of Electron we use (through Obsidian's electron.remote) ---
interface Cookie {
	name: string;
	value: string;
}
interface Session {
	cookies: { get(filter: { url: string }): Promise<Cookie[]> };
	clearStorageData(): Promise<void>;
	setUserAgent(ua: string): void;
	getUserAgent(): string;
}
interface Win {
	loadURL(url: string): Promise<void>;
	isDestroyed(): boolean;
	close(): void;
	focus(): void;
	webContents: {
		removeAllListeners(event: string): void;
		setWindowOpenHandler(handler: (details: { url: string }) => unknown): void;
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

function session(account: Account): Session {
	const r = remote();
	if (!r) throw new Error('Login windows are not available in this Obsidian (desktop only).');
	return r.session.fromPartition(SITES[account].partition);
}

/** Obsidian's browser name without the "Electron/…" and "obsidian/…" parts (some logins refuse those). */
function plainUserAgent(ses: Session): string {
	return ses.getUserAgent().replace(/\s(obsidian|Electron)\/\S+/gi, '');
}

/** The browser name the login window uses – requests must send the same one (Cloudflare checks it). */
export function loginUserAgent(account: Account): string {
	return plainUserAgent(session(account));
}

const open = new Map<Account, Win>();
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const MAX_WAIT_MS = 15 * 60_000;

export type LoginResult = 'logged-in' | 'closed';

/**
 * Opens the website's login page in its own window and waits. Ends when the login
 * cookie appears (window closes itself) or when you close the window.
 */
export async function openLogin(account: Account): Promise<LoginResult> {
	const existing = open.get(account);
	if (existing && !existing.isDestroyed()) {
		existing.focus();
		return 'closed';
	}
	const r = remote();
	if (!r) throw new Error('Login windows are not available in this Obsidian (desktop only).');
	const site = SITES[account];
	const ses = r.session.fromPartition(site.partition);
	ses.setUserAgent(plainUserAgent(ses));
	const win = new r.BrowserWindow({
		width: 1000,
		height: 800,
		title: site.title,
		autoHideMenuBar: true,
		webPreferences: { partition: site.partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
	});
	open.set(account, win);
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
			if (site.loginCookie && (await isLoggedIn(account))) {
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
		open.delete(account);
	}
}

/** The site's cookies, read in memory. Never store or log the values. */
async function cookies(account: Account): Promise<Cookie[]> {
	const list = await session(account).cookies.get({ url: SITES[account].origin });
	return Array.from(list, (c) => ({ name: String(c.name), value: String(c.value) }));
}

export async function cookieValue(account: Account, name: string): Promise<string | null> {
	try {
		const c = (await cookies(account)).find((x) => x.name === name);
		return c?.value ? c.value : null;
	} catch {
		return null;
	}
}

/** Names only (not secret) – shown in settings so you can see what the login left. */
export async function cookieNames(account: Account): Promise<string[]> {
	try {
		return (await cookies(account)).map((c) => c.name).sort();
	} catch {
		return [];
	}
}

/** "name=value; …" for a request to the site. In memory only. */
export async function cookieHeader(account: Account): Promise<string> {
	return (await cookies(account)).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** The login cookie is there – also when the site splits it into parts ("name.0", "name.1"). */
export async function isLoggedIn(account: Account): Promise<boolean> {
	const want = SITES[account].loginCookie;
	if (!want) return (await cookieNames(account)).length > 0;
	try {
		return (await cookies(account)).some((c) => (c.name === want || c.name.startsWith(`${want}.`)) && c.value !== '');
	} catch {
		return false;
	}
}

/** Forgets the login: clears that window's cookies and storage. */
export async function logout(account: Account): Promise<void> {
	await session(account).clearStorageData();
}

export function closeLoginWindows(): void {
	for (const w of open.values()) if (!w.isDestroyed()) w.close();
	open.clear();
}
