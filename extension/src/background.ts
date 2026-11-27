// AI ChatBridge Browser link: the extension's service worker. A remote hand for the Obsidian
// plugin in your own, logged-in browser. It connects to the plugin on 127.0.0.1 only, and does
// two things there: a request from a tab of a supported site (with the browser's cookies), and
// a signed call from a background tab it opened itself. It never parses, stores or logs what
// the sites answer, and talks to nothing but those sites and 127.0.0.1.

import { fetchFrames, fromBase64, MAX_BODY_BYTES, type LinkRequest } from '../../src/link/protocol';
import { isLinkImage, isLinkOpenPage, isLinkPage, isLinkTarget } from '../../src/link/sites';
import { pageCall, pageFetch, pageRead, readyCheck } from './page';

// Timers go through self: this is a service worker, which has no window.
const PING_MS = 20_000;
const READY_CHECKS = new Set(['gemini-signed-in', 'studio-ready', 'loaded']);
const PAGE_VALUES = new Set(['google-account-id']);
/** Site values and the one site each may be read from. */
const SITE_VALUES: Record<string, string> = { 'claude-org': 'https://claude.ai', 'chatgpt-device-id': 'https://chatgpt.com', 'chatgpt-workspace': 'https://chatgpt.com' };
/** A fetch tab this extension opened is closed after this long without use. */
const FETCH_TAB_IDLE_MS = 60_000;

export type LinkState = 'not-paired' | 'connecting' | 'linked' | 'plugin-closed' | 'refused';

interface Pairing { port: number; token: string }

let ws: WebSocket | null = null;
let state: LinkState = 'not-paired';
let pingTimer: number | undefined;

// ---- tabs this extension opened (never the user's own) ---------------------------------------

interface OwnTab { tabId: number; origin: string; kind: 'page' | 'fetch'; lastUse: number }
const own = new Map<string, OwnTab>();
let nextPage = 1;

async function remember(): Promise<void> {
	await chrome.storage.session.set({ ownTabs: [...own.values()].map((t) => t.tabId) });
}

/** After a restart of this worker: close the tabs an earlier run opened. */
async function closeLeftovers(): Promise<void> {
	const { ownTabs } = await chrome.storage.session.get<{ ownTabs?: number[] }>('ownTabs');
	for (const id of ownTabs ?? []) await chrome.tabs.remove(id).catch(() => undefined);
	await chrome.storage.session.set({ ownTabs: [] });
}

async function closeOwn(key: string): Promise<void> {
	const t = own.get(key);
	own.delete(key);
	if (t) await chrome.tabs.remove(t.tabId).catch(() => undefined);
	await remember();
}

async function closeAllOwn(): Promise<void> {
	for (const key of [...own.keys()]) await closeOwn(key);
}

function originOf(url: string | undefined): string | null {
	try {
		return url ? new URL(url).origin : null;
	} catch {
		return null;
	}
}

class LinkFail extends Error {
	constructor(readonly kind: 'not-allowed' | 'no-tab' | 'not-logged-in' | 'timeout' | 'blocked' | 'failed', message: string) {
		super(message);
	}
}

const sleep = (ms: number) => new Promise((r) => self.setTimeout(r, ms));

async function inPage<A extends unknown[], R>(tabId: number, func: (...args: A) => R | Promise<R>, args: A): Promise<R> {
	const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
	if (!res) throw new LinkFail('failed', 'no result from the page');
	return res.result as R;
}

/** Opens a background tab and waits until it is on `origin`, loaded, and `ready` holds there. */
async function openTab(url: string, ready: string, timeoutMs: number): Promise<number> {
	const origin = originOf(url)!;
	const tab = await chrome.tabs.create({ url, active: false });
	const id = tab.id!;
	const until = Date.now() + timeoutMs;
	let lastOrigin: string | null = null;
	let loadedThere = false;
	while (Date.now() < until) {
		await sleep(500);
		const t = await chrome.tabs.get(id).catch(() => null);
		if (!t) throw new LinkFail('no-tab', 'the tab was closed');
		lastOrigin = originOf(t.url) ?? lastOrigin;
		if (lastOrigin !== origin || t.status !== 'complete') continue; // loading, or sent to a sign-in page
		loadedThere = true;
		if (await inPage(id, readyCheck, [ready]).catch(() => false)) return id;
	}
	await chrome.tabs.remove(id).catch(() => undefined);
	// Sent to a sign-in page, or the site loaded but never showed a login (Gemini can be used
	// signed out): both mean "not logged in". Only a page that never loaded is a timeout.
	if (lastOrigin && lastOrigin !== origin) throw new LinkFail('not-logged-in', 'the site sent the tab to a sign-in page');
	if (loadedThere && ready !== 'loaded') throw new LinkFail('not-logged-in', 'the site loaded without a login');
	throw new LinkFail('timeout', 'the page did not become ready');
}

/** A tab where a request to `origin` can run: one of yours (read only), or one this extension opens. */
async function fetchTab(origin: string): Promise<number> {
	const mine = own.get(`fetch:${origin}`);
	if (mine && await chrome.tabs.get(mine.tabId).then((t) => originOf(t.url) === origin, () => false)) {
		mine.lastUse = Date.now();
		return mine.tabId;
	}
	const yours = (await chrome.tabs.query({ url: `${origin}/*` })).find((t) => t.status === 'complete' && t.id !== undefined && !t.discarded);
	if (yours?.id !== undefined) return yours.id;
	const id = await openTab(`${origin}/`, 'loaded', 45_000);
	own.set(`fetch:${origin}`, { tabId: id, origin, kind: 'fetch', lastUse: Date.now() });
	await remember();
	return id;
}

async function handle(msg: LinkRequest & { id: number }): Promise<unknown[]> {
	switch (msg.op) {
		case 'fetch': {
			// A picture Gemini made. Seen 2026-11-27: a fetch from a Gemini page and the extension's
			// own fetch both fail ("Failed to fetch"), while opening the address in a tab shows the
			// picture with your Google login. So it is opened in a background tab of its own and read
			// there (same site, so the browser allows it), then the tab is closed. GET only; only a
			// picture comes back.
			if (isLinkImage(msg.url)) {
				if (msg.method !== 'GET' || msg.body64 !== undefined) throw new LinkFail('not-allowed', 'method not allowed');
				const tabId = await openTab(msg.url, 'loaded', 45_000);
				try {
					const here = (await chrome.tabs.get(tabId)).url ?? '';
					if (!isLinkImage(here)) throw new LinkFail('not-logged-in', 'the picture opened somewhere else');
					const r = await inPage(tabId, pageFetch, [{ url: here, method: 'GET', headers: {}, redirect: 'follow' as const }]);
					const type = (Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '').toLowerCase();
					const bytes = type.startsWith('image/') ? fromBase64(r.body64) : new Uint8Array(0);
					if (bytes.byteLength > MAX_BODY_BYTES) throw new LinkFail('blocked', 'picture too large');
					return fetchFrames(msg.id, r.status, r.headers, bytes);
				} catch (e) {
					if (e instanceof LinkFail) throw e;
					throw new LinkFail('failed', `picture tab (extension ${chrome.runtime.getManifest().version}): ${e instanceof Error ? e.message : 'failed'}`);
				} finally {
					await chrome.tabs.remove(tabId).catch(() => undefined);
				}
			}
			if (!isLinkTarget(msg.url) || !isLinkPage(msg.url)) throw new LinkFail('not-allowed', 'site not allowed');
			if (msg.method !== 'GET' && msg.method !== 'POST') throw new LinkFail('not-allowed', 'method not allowed');
			const tabId = await fetchTab(originOf(msg.url)!);
			const r = await inPage(tabId, pageFetch, [{ url: msg.url, method: msg.method, headers: msg.headers ?? {}, body64: msg.body64, redirect: msg.redirect }]);
			return fetchFrames(msg.id, r.status, r.headers, fromBase64(r.body64));
		}
		case 'open': {
			if (!isLinkPage(msg.url)) throw new LinkFail('not-allowed', 'site not allowed');
			if (!READY_CHECKS.has(msg.ready)) throw new LinkFail('not-allowed', 'unknown ready check');
			const tabId = await openTab(msg.url, msg.ready, Math.min(msg.timeoutMs || 45_000, 120_000));
			const page = `p${nextPage++}`;
			own.set(page, { tabId, origin: originOf(msg.url)!, kind: 'page', lastUse: Date.now() });
			await remember();
			return [{ id: msg.id, ok: true, page }];
		}
		case 'call': {
			const t = own.get(msg.page);
			if (!t || t.kind !== 'page') throw new LinkFail('no-tab', 'no such page');
			const tab = await chrome.tabs.get(t.tabId).catch(() => null);
			if (!tab || originOf(tab.url) !== t.origin) throw new LinkFail('not-logged-in', 'the tab left the site');
			if (!isLinkTarget(msg.call.url)) throw new LinkFail('not-allowed', 'target not allowed');
			if (msg.call.sign !== 'wiz-at' && msg.call.sign !== 'sapisidhash') throw new LinkFail('not-allowed', 'unknown signing');
			t.lastUse = Date.now();
			const answer = await inPage(t.tabId, pageCall, [msg.call]);
			return [{ id: msg.id, ok: true, answer }];
		}
		case 'read': {
			if ('site' in msg) {
				const origin = originOf(msg.site);
				if (!isLinkPage(msg.site) || !origin || SITE_VALUES[msg.value] !== origin) throw new LinkFail('not-allowed', 'value not allowed for this site');
				const tabId = await fetchTab(origin);
				return [{ id: msg.id, ok: true, value: await inPage(tabId, pageRead, [msg.value]) }];
			}
			const t = own.get(msg.page);
			if (!t || t.kind !== 'page') throw new LinkFail('no-tab', 'no such page');
			if (!PAGE_VALUES.has(msg.value)) throw new LinkFail('not-allowed', 'unknown page value');
			const tab = await chrome.tabs.get(t.tabId).catch(() => null);
			if (!tab || originOf(tab.url) !== t.origin) throw new LinkFail('not-logged-in', 'the tab left the site');
			t.lastUse = Date.now();
			return [{ id: msg.id, ok: true, value: await inPage(t.tabId, pageRead, [msg.value]) }];
		}
		case 'close':
			await closeOwn(msg.page);
			return [{ id: msg.id, ok: true }];
		case 'status': {
			if (!isLinkPage(msg.site)) throw new LinkFail('not-allowed', 'site not allowed');
			const tabs = await chrome.tabs.query({ url: `${originOf(msg.site)!}/*` });
			return [{ id: msg.id, ok: true, tabOpen: tabs.length > 0 }];
		}
		default:
			throw new LinkFail('not-allowed', 'unknown request');
	}
}

async function onRequest(sock: WebSocket, raw: string): Promise<void> {
	let msg: (LinkRequest & { id: number }) | { op: 'pong' };
	try {
		msg = JSON.parse(raw) as typeof msg;
	} catch {
		return;
	}
	if (msg.op === 'pong' || typeof (msg as { id?: unknown }).id !== 'number') return;
	const req = msg;
	let frames: unknown[];
	try {
		frames = await handle(req);
	} catch (e) {
		const kind = e instanceof LinkFail ? e.kind : 'failed';
		frames = [{ id: req.id, ok: false, error: { kind, message: e instanceof Error ? e.message : 'failed' } }];
	}
	for (const f of frames) if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(f));
}

// ---- connection ---------------------------------------------------------------------------

async function setState(s: LinkState): Promise<void> {
	state = s;
	await chrome.storage.session.set({ state: s }).catch(() => undefined);
}

function disconnected(sock: WebSocket, refused: boolean): void {
	if (ws !== sock) return;
	ws = null;
	self.clearInterval(pingTimer);
	void closeAllOwn();
	void setState(refused ? 'refused' : 'plugin-closed');
}

/**
 * This install's own random ID (one per browser or browser profile), so the plugin can pair
 * several browsers and send each account's requests to its own one. Made once, kept.
 */
let browserIdOnce: Promise<string> | null = null;
function browserId(): Promise<string> {
	// Asked once per start: two connects at the same moment must not each make a new ID.
	browserIdOnce ??= (async () => {
		const { browserId: saved } = await chrome.storage.local.get<{ browserId?: string }>('browserId');
		if (typeof saved === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(saved)) return saved;
		const id = self.crypto.randomUUID().replace(/-/g, '');
		await chrome.storage.local.set({ browserId: id });
		return id;
	})();
	return browserIdOnce;
}

/**
 * Opens the link with the saved pairing, or with `code` to pair. Resolves with the state
 * once the plugin has answered (or the attempt failed).
 */
async function connect(code?: string): Promise<LinkState> {
	const { pairing } = await chrome.storage.local.get<{ pairing?: Pairing }>('pairing');
	const port = code ? Number(/^(\d{2,5})-/.exec(code.trim())?.[1]) : pairing?.port;
	if (!port || port > 65535) {
		await setState(code ? 'refused' : 'not-paired');
		return state;
	}
	if (!code && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return state;
	if (ws) {
		const old = ws;
		ws = null;
		old.close();
	}
	await setState('connecting');
	const browser = await browserId();
	const sock = new WebSocket(`ws://127.0.0.1:${port}`);
	ws = sock;
	return new Promise<LinkState>((resolve) => {
		let answered = false;
		sock.onopen = () => {
			sock.send(JSON.stringify(code ? { op: 'pair', code: code.trim(), browser } : { op: 'hello', token: pairing?.token ?? '', browser }));
		};
		sock.onmessage = (ev) => {
			const text = String(ev.data);
			if (!answered) {
				answered = true;
				let first: { op?: string; token?: string } = {};
				try {
					first = JSON.parse(text) as typeof first;
				} catch { /* not a welcome */ }
				void (async () => {
					if (first.op === 'paired' && typeof first.token === 'string') await chrome.storage.local.set({ pairing: { port, token: first.token } });
					if (first.op !== 'paired' && first.op !== 'welcome') {
						sock.close();
						resolve(state);
						return;
					}
					self.clearInterval(pingTimer);
					pingTimer = self.setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ op: 'ping' })); }, PING_MS);
					await setState('linked');
					resolve('linked');
				})();
				return;
			}
			void onRequest(sock, text);
		};
		sock.onclose = (ev) => {
			disconnected(sock, ev.code === 1008);
			if (!answered) {
				answered = true;
				resolve(ev.code === 1008 ? 'refused' : 'plugin-closed');
			}
		};
		sock.onerror = () => undefined;
	});
}

async function unpair(): Promise<void> {
	await chrome.storage.local.remove('pairing');
	const s = ws;
	ws = null;
	s?.close();
	self.clearInterval(pingTimer);
	await closeAllOwn();
	await setState('not-paired');
}

/** Closes fetch tabs this extension opened once they sit unused. */
async function tidy(): Promise<void> {
	for (const [key, t] of own) if (t.kind === 'fetch' && Date.now() - t.lastUse > FETCH_TAB_IDLE_MS) await closeOwn(key);
}

chrome.runtime.onMessage.addListener((m: { op?: string; code?: string }, sender, send) => {
	if (sender.id !== chrome.runtime.id) return false;
	if (m.op === 'pair' && typeof m.code === 'string') {
		void connect(m.code).then((s) => send({ state: s }));
		return true;
	}
	if (m.op === 'unpair') {
		void unpair().then(() => send({ state }));
		return true;
	}
	if (m.op === 'state') {
		send({ state });
		return false;
	}
	return false;
});

chrome.action?.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
// Obsidian's "Open in browser" opens a small page on 127.0.0.1; that tab becomes the extension's
// page. Chrome: the page asks for it (works without site access); also: the tab is seen loading.
chrome.runtime.onMessageExternal?.addListener((m: { op?: string }, sender) => {
	if (m?.op === 'open-options' && sender.tab?.id !== undefined && isLinkOpenPage(sender.url)) void chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL('options.html') });
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
	if (isLinkOpenPage(info.url ?? (info.status === 'loading' ? tab.url : undefined))) void chrome.tabs.update(tabId, { url: chrome.runtime.getURL('options.html') });
});
void chrome.alarms.create('link', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
	if (a.name !== 'link') return;
	void tidy();
	void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener((d) => {
	// Right after installing: open the page where you paste the pairing code.
	if (d.reason === 'install') void chrome.runtime.openOptionsPage();
	void connect();
});
void closeLeftovers().then(() => connect());
