// The plugin's end of the Browser link: a WebSocket server on 127.0.0.1 only. The browser
// extension connects, proves itself with a token (or a one-time pairing code), and then does
// requests for the plugin in the owner's own browser.
// Desktop only, and loaded lazily (never imported at the top of the plugin): it needs Node.
// Never logged or shown: tokens, codes, request or answer bodies, headers.

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { BrowserLinkError, BrowserLinkUnavailable } from './errors';
import { isBrowserId, LEGACY_BROWSER, readTokens, writeTokens } from './account';
import { isExtensionOrigin, isLinkImage, isLinkPage, isLinkTarget, LINK_OPEN_PATH } from './sites';
import {
	BodyAssembler, MAX_FRAME_BYTES, toBase64,
	type CallAnswer, type ReadAnswer, type FetchHead, type FetchPart, type FetchResult, type Hello, type LinkFailure, type LinkRequest, type OpenAnswer, type StatusAnswer, type Welcome,
} from './protocol';
import type { PageAnswer, PageCall, PageValue, ReadyCheck, SiteValue } from '../transport/types';

/** Where the long-lived token is kept (Obsidian secret storage in the plugin). */
export interface TokenStore {
	get(): string | null;
	set(token: string | null): void;
}

export interface LinkServerOptions {
	store: TokenStore;
	/** The port used last time, so a paired extension finds it again; 0 or missing = any free one. */
	port?: number;
	helloTimeoutMs?: number;
	codeLifetimeMs?: number;
	now?: () => number;
	/** A browser was paired (its ID): the plugin names it. */
	onPaired?: (browser: string) => void;
}

/** The page behind the "Open in browser" button; the extension turns it into its own page. */
export function openPageHtml(script = ''): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI ChatBridge Browser link</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;background:#fff;color:#1d1d1f}@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#e6e6e6}}h1{font-size:1.25rem}code{font-size:.9em}</style></head>
<body><h1>AI ChatBridge Browser link</h1>
<p>If the ChatBridge extension is installed in this browser, its page opens now.</p>
<p>Nothing happens? Then the extension is not in this browser: install it from the plugin's release page (github.com/Sundowna/obsidian-ai-chatbridge/releases), or open this address in the browser where it is installed.</p>
<p><strong>Keep that browser open while Obsidian syncs.</strong></p>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/**
 * The page's one script, for Chrome, Edge and Brave: it asks the linked extension (by its ID,
 * learnt from its connection) to open its page in this tab. This needs no site access; the
 * extension accepts it from this local page only. Firefox switches the tab by itself instead.
 */
export function openPageScript(extensionId: string): string {
	return `try{chrome.runtime.sendMessage(${JSON.stringify(extensionId)},{op:"open-options"})}catch(e){}`;
}

/** Node's own modules, loaded when the server starts: only on a computer, never on a phone. */
function node<T>(name: string): T {
	return (window as unknown as { require: (n: string) => T }).require(name);
}
type IncomingMessage = import('http').IncomingMessage;
type Server = import('http').Server;
const httpModule = () => node<typeof import('http')>('http');
const cryptoModule = () => node<typeof import('crypto')>('crypto');
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_WRONG_CODES = 5;

interface Pending {
	/** The browser asked, so its answers and its closing only touch its own requests. */
	browser: string;
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: number;
	parts?: BodyAssembler;
}

function sameSecret(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	return x.length === y.length && cryptoModule().timingSafeEqual(x, y);
}

export class LinkServer {
	private http: Server | null = null;
	private wss: WebSocketServer | null = null;
	/** One connection per paired browser (by the extension's own ID). */
	private readonly socks = new Map<string, WebSocket>();
	/** The linked Chrome, Edge or Brave extension's ID (not secret), from its connection; for the open page. */
	private chromeExtensionId: string | null = null;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private code: { secret: string; until: number; wrong: number } | null = null;
	private boundPort = 0;
	/** True when the remembered port was taken and another one was picked (the browser must pair again). */
	portChanged = false;

	constructor(private readonly opts: LinkServerOptions) {}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	get port(): number {
		return this.boundPort;
	}

	get listening(): boolean {
		return this.http?.listening === true;
	}

	/** A browser is connected and has proved itself. */
	get linked(): boolean {
		return this.linkedBrowsers().length > 0;
	}

	get paired(): boolean {
		return this.pairedBrowsers().length > 0;
	}

	/** The paired browsers' IDs. */
	pairedBrowsers(): string[] {
		return Object.keys(readTokens(this.opts.store.get()));
	}

	/** The browsers connected now. */
	linkedBrowsers(): string[] {
		return [...this.socks].filter(([, ws]) => ws.readyState === WebSocket.OPEN).map(([id]) => id);
	}

	/** Whether this browser (or, without one, any browser) is connected now. */
	isLinked(browser?: string): boolean {
		return browser ? this.linkedBrowsers().includes(browser) : this.linked;
	}

	/** Starts listening on 127.0.0.1; returns the port. */
	async start(): Promise<number> {
		if (this.http) return this.boundPort;
		const wanted = this.opts.port ?? 0;
		let server: Server;
		try {
			server = await this.listen(wanted);
		} catch (e) {
			if (wanted === 0 || (e as { code?: string }).code !== 'EADDRINUSE') throw e;
			server = await this.listen(0);
			this.portChanged = true;
		}
		this.http = server;
		const addr = server.address();
		this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
		this.wss = new WebSocketServer({
			server,
			maxPayload: MAX_FRAME_BYTES,
			// Any web page can try ws://127.0.0.1, so only extension pages get in, and only by this address.
			verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => isExtensionOrigin(origin) && this.hostOk(req),
		});
		this.wss.on('connection', (ws, req: IncomingMessage) => this.onConnection(ws, req.headers.origin));
		return this.boundPort;
	}

	private listen(port: number): Promise<Server> {
		return new Promise((resolve, reject) => {
			const s = httpModule().createServer((req, res) => {
				// One static page, for opening the extension from Obsidian (see LINK_OPEN_PATH);
				// everything else is 404. It holds nothing secret and loads nothing.
				if (req.method === 'GET' && this.hostOk(req) && (req.url ?? '').split('?')[0] === LINK_OPEN_PATH) {
					// Only the one script below may run: allowed by its hash, nothing else.
					const script = this.chromeExtensionId ? openPageScript(this.chromeExtensionId) : '';
					const hash = script ? ` 'sha256-${cryptoModule().createHash('sha256').update(script).digest('base64')}'` : '';
					res.writeHead(200, {
						'Content-Type': 'text/html; charset=utf-8',
						'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'${hash ? `; script-src${hash}` : ''}`,
						'Cache-Control': 'no-store',
						'X-Content-Type-Options': 'nosniff',
					});
					res.end(openPageHtml(script));
					return;
				}
				res.writeHead(404);
				res.end();
			});
			s.once('error', reject);
			s.listen(port, '127.0.0.1', () => {
				s.off('error', reject);
				resolve(s);
			});
		});
	}

	private hostOk(req: IncomingMessage): boolean {
		const host = req.headers.host ?? '';
		return host === `127.0.0.1:${this.boundPort}` || host === `localhost:${this.boundPort}`;
	}

	async stop(): Promise<void> {
		for (const id of [...this.socks.keys()]) this.dropLink(id);
		const wss = this.wss;
		const http = this.http;
		this.wss = null;
		this.http = null;
		this.boundPort = 0;
		if (wss) {
			for (const c of wss.clients) c.terminate();
			await new Promise<void>((r) => wss.close(() => r()));
		}
		if (http) await new Promise<void>((r) => http.close(() => r()));
	}

	/** A new one-time pairing code ("port-XXXX-XXXX-XXXX"), valid for a few minutes. */
	newPairingCode(): string {
		if (!this.http) throw new Error('The Browser link is not running.');
		let secret = '';
		for (let i = 0; i < 12; i++) secret += CODE_LETTERS[cryptoModule().randomInt(CODE_LETTERS.length)];
		this.code = { secret, until: this.now() + (this.opts.codeLifetimeMs ?? 5 * 60_000), wrong: 0 };
		return `${this.boundPort}-${secret.slice(0, 4)}-${secret.slice(4, 8)}-${secret.slice(8)}`;
	}

	/** Forgets one paired browser, or (without an ID) every one. */
	unpair(browser?: string): void {
		const tokens = readTokens(this.opts.store.get());
		for (const id of browser ? [browser] : Object.keys(tokens)) delete tokens[id];
		this.opts.store.set(writeTokens(tokens));
		this.code = null;
		for (const id of browser ? [browser] : [...this.socks.keys()]) this.dropLink(id);
	}

	private dropLink(browser: string): void {
		const s = this.socks.get(browser);
		this.socks.delete(browser);
		if (s && s.readyState <= WebSocket.OPEN) s.close(1000);
		this.failAll(new BrowserLinkUnavailable('browser-closed'), browser);
	}

	private failAll(e: Error, browser?: string): void {
		for (const [id, p] of this.pending) {
			if (browser !== undefined && p.browser !== browser) continue;
			window.clearTimeout(p.timer);
			p.reject(e);
			this.pending.delete(id);
		}
	}

	private onConnection(ws: WebSocket, origin?: string): void {
		const timer = window.setTimeout(() => ws.close(1008), this.opts.helloTimeoutMs ?? 5000);
		ws.once('message', (raw) => {
			window.clearTimeout(timer);
			const hello = this.parse(raw) as Partial<Hello> | null;
			const ok = hello ? this.check(hello) : null;
			if (!ok) {
				ws.close(1008);
				return;
			}
			const { welcome, browser } = ok;
			// One connection per browser: a newer one of the same browser replaces it; other browsers stay.
			const old = this.socks.get(browser);
			this.socks.set(browser, ws);
			const chromeId = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? '')?.[1];
			if (chromeId) this.chromeExtensionId = chromeId;
			if (old && old !== ws) old.close(1000);
			ws.on('message', (m) => this.onMessage(ws, m));
			ws.on('close', () => {
				if (this.socks.get(browser) !== ws) return;
				this.socks.delete(browser);
				this.failAll(new BrowserLinkUnavailable('browser-closed'), browser);
			});
			ws.send(JSON.stringify(welcome));
		});
	}

	/** Checks a first frame; the answer to send and the browser it is, or null to refuse. */
	private check(hello: Partial<Hello>): { welcome: Welcome; browser: string } | null {
		const browser = isBrowserId(hello.browser) ? hello.browser : LEGACY_BROWSER;
		if (hello.op === 'hello') {
			if (typeof hello.token !== 'string') return null;
			const tokens = readTokens(this.opts.store.get());
			const token = tokens[browser];
			if (token) return sameSecret(hello.token, token) ? { welcome: { op: 'welcome' }, browser } : null;
			// An extension updated to send its own ID, paired before with the one older token: it keeps that pairing.
			const legacy = tokens[LEGACY_BROWSER];
			if (browser !== LEGACY_BROWSER && legacy && sameSecret(hello.token, legacy)) {
				delete tokens[LEGACY_BROWSER];
				tokens[browser] = legacy;
				this.opts.store.set(writeTokens(tokens));
				this.opts.onPaired?.(browser);
				return { welcome: { op: 'welcome' }, browser };
			}
			return null;
		}
		if (hello.op === 'pair' && typeof hello.code === 'string') {
			const c = this.code;
			if (!c || this.now() > c.until) return null;
			const given = hello.code.toUpperCase().replace(/^\d+-/, '').replace(/[^A-Z0-9]/g, '');
			if (!sameSecret(given, c.secret)) {
				if (++c.wrong >= MAX_WRONG_CODES) this.code = null;
				return null;
			}
			this.code = null; // single use
			const token = cryptoModule().randomBytes(32).toString('base64url');
			const tokens = readTokens(this.opts.store.get());
			tokens[browser] = token;
			this.opts.store.set(writeTokens(tokens));
			this.opts.onPaired?.(browser);
			return { welcome: { op: 'paired', token }, browser };
		}
		return null;
	}

	private parse(raw: RawData): unknown {
		try {
			const bytes = Array.isArray(raw) ? raw.map((b) => new Uint8Array(b)) : [new Uint8Array(raw)];
			return JSON.parse(bytes.map((b) => new TextDecoder().decode(b)).join('')) as unknown;
		} catch {
			return null;
		}
	}

	private onMessage(ws: WebSocket, raw: RawData): void {
		const msg = this.parse(raw) as { op?: string; id?: number; ok?: boolean; part?: number } | null;
		if (!msg) return;
		if (msg.op === 'ping') {
			ws.send(JSON.stringify({ op: 'pong' }));
			return;
		}
		const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
		if (!p || msg.id === undefined) return;
		const id = msg.id;
		const done = (fn: () => void) => {
			window.clearTimeout(p.timer);
			this.pending.delete(id);
			fn();
		};
		try {
			if (typeof msg.part === 'number') {
				if (!p.parts) throw new Error('part without head');
				const whole = p.parts.add(msg as FetchPart);
				if (whole) done(() => p.resolve(whole));
				return;
			}
			if (msg.ok === false) {
				done(() => p.reject(toError(msg as LinkFailure)));
				return;
			}
			const head = msg as FetchHead;
			if (typeof head.parts === 'number') {
				p.parts = new BodyAssembler(head);
				const whole = p.parts.complete;
				if (whole) done(() => p.resolve(whole));
				return;
			}
			done(() => p.resolve(msg));
		} catch {
			done(() => p.reject(new BrowserLinkError('The browser sent an answer the plugin could not read.')));
		}
	}

	/**
	 * The connection for `browser`; without one, the only browser connected (or, with several, the
	 * first: an account that names no browser takes whichever is there, as before).
	 */
	private target(browser?: string): [string, WebSocket] | null {
		if (browser) {
			const ws = this.socks.get(browser);
			return ws && ws.readyState === WebSocket.OPEN ? [browser, ws] : null;
		}
		const open = [...this.socks].filter(([, ws]) => ws.readyState === WebSocket.OPEN);
		return open[0] ?? null;
	}

	/** Sends one request to the browser and waits for its answer. */
	private send(req: LinkRequest, timeoutMs: number, browser?: string): Promise<unknown> {
		const t = this.target(browser);
		if (!t) {
			const paired = browser ? this.pairedBrowsers().includes(browser) : this.paired;
			return Promise.reject(new BrowserLinkUnavailable(paired ? 'browser-closed' : 'not-paired'));
		}
		const [which, ws] = t;
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new BrowserLinkError(`The browser did not answer within ${Math.round(timeoutMs / 1000)} s.`));
			}, timeoutMs);
			this.pending.set(id, { browser: which, resolve, reject, timer });
			ws.send(JSON.stringify({ id, ...req }));
		});
	}

	/** A request from a tab of the site, with the browser's own cookies. */
	async fetch(url: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: string | ArrayBuffer, redirect?: 'follow' | 'manual', timeoutMs = 120_000, browser?: string): Promise<FetchResult> {
		const picture = isLinkImage(url) && method === 'GET' && body === undefined;
		if (!isLinkTarget(url) && !picture) throw new BrowserLinkError('Blocked: not a site the Browser link may reach.');
		if (method !== 'GET' && method !== 'POST') throw new BrowserLinkError('Blocked: only GET and POST go through the Browser link.');
		const bytes = body === undefined ? undefined : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
		const req: LinkRequest = { op: 'fetch', url, method, headers, ...(bytes ? { body64: toBase64(bytes) } : {}), ...(redirect ? { redirect } : {}) };
		return (await this.send(req, timeoutMs, browser)) as FetchResult;
	}

	/** Opens a background tab of the site (its own, never one of yours) and waits until `ready` holds. */
	async open(url: string, ready: ReadyCheck, timeoutMs: number, browser?: string): Promise<string> {
		if (!isLinkPage(url)) throw new BrowserLinkError('Blocked: not a site the Browser link may open.');
		const a = (await this.send({ op: 'open', url, ready, timeoutMs }, timeoutMs + 15_000, browser)) as OpenAnswer;
		return a.page;
	}

	/** One signed call from a tab opened with `open`. */
	async call(page: string, c: PageCall, timeoutMs = 120_000, browser?: string): Promise<PageAnswer> {
		if (!isLinkTarget(c.url)) throw new BrowserLinkError('Blocked: not a site the Browser link may reach.');
		return ((await this.send({ op: 'call', page, call: c }, timeoutMs, browser)) as CallAnswer).answer;
	}

	/** One named value from a page this link opened (not secret); '' when the page has none. */
	async read(page: string, value: PageValue, timeoutMs = 15_000, browser?: string): Promise<string> {
		const v = ((await this.send({ op: 'read', page, value }, timeoutMs, browser)) as ReadAnswer).value;
		return typeof v === 'string' ? v : '';
	}

	/** One named value from a tab of `site` (a small cookie the page can read; not secret). */
	async siteValue(site: string, value: SiteValue, timeoutMs = 60_000, browser?: string): Promise<string> {
		if (!isLinkPage(site)) throw new BrowserLinkError('Blocked: not a site the Browser link may open.');
		const v = ((await this.send({ op: 'read', site, value }, timeoutMs, browser)) as ReadAnswer).value;
		return typeof v === 'string' ? v : '';
	}

	async closePage(page: string, browser?: string): Promise<void> {
		if (!this.isLinked(browser)) return;
		await this.send({ op: 'close', page }, 15_000, browser).catch(() => undefined);
	}

	async status(site: string, browser?: string): Promise<boolean> {
		if (!isLinkPage(site)) throw new BrowserLinkError('Blocked: not a site the Browser link may open.');
		return ((await this.send({ op: 'status', site }, 15_000, browser)) as StatusAnswer).tabOpen;
	}
}

function toError(f: LinkFailure): Error {
	switch (f.error?.kind) {
		case 'not-logged-in': return new BrowserLinkUnavailable('not-logged-in');
		case 'no-tab':
		case 'timeout': return new BrowserLinkUnavailable('tab-failed');
		case 'not-allowed': return new BrowserLinkError('The browser refused this request: not on its list of allowed sites.');
		// The browser's own short reason (e.g. "Failed to fetch"); it never carries an address or a login.
		default: return new BrowserLinkError(`The browser could not do this request (${f.error?.kind === 'blocked' ? 'blocked' : 'failed'}${typeof f.error?.message === 'string' && f.error.message ? `: ${f.error.message.replace(/https?:\/\/\S+/g, '(address)').slice(0, 120)}` : ''}).`);
	}
}
