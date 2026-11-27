// The plugin's end of the Browser link: a WebSocket server on 127.0.0.1 only. The browser
// extension connects, proves itself with a token (or a one-time pairing code), and then does
// requests for the plugin in the owner's own browser.
// Desktop only, and loaded lazily (never imported at the top of the plugin): it needs Node.
// Never logged or shown: tokens, codes, request or answer bodies, headers.

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { BrowserLinkError, BrowserLinkUnavailable } from './errors';
import { isExtensionOrigin, isLinkPage, isLinkTarget } from './sites';
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
	private sock: WebSocket | null = null;
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
		return this.sock?.readyState === WebSocket.OPEN;
	}

	get paired(): boolean {
		return !!this.opts.store.get();
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
		this.wss.on('connection', (ws) => this.onConnection(ws));
		return this.boundPort;
	}

	private listen(port: number): Promise<Server> {
		return new Promise((resolve, reject) => {
			const s = httpModule().createServer((_req, res) => {
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
		this.dropLink();
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

	/** Forgets the paired browser. */
	unpair(): void {
		this.opts.store.set(null);
		this.code = null;
		this.dropLink();
	}

	private dropLink(): void {
		const s = this.sock;
		this.sock = null;
		if (s && s.readyState <= WebSocket.OPEN) s.close(1000);
		this.failAll(new BrowserLinkUnavailable('browser-closed'));
	}

	private failAll(e: Error): void {
		for (const p of this.pending.values()) {
			window.clearTimeout(p.timer);
			p.reject(e);
		}
		this.pending.clear();
	}

	private onConnection(ws: WebSocket): void {
		const timer = window.setTimeout(() => ws.close(1008), this.opts.helloTimeoutMs ?? 5000);
		ws.once('message', (raw) => {
			window.clearTimeout(timer);
			const hello = this.parse(raw) as Partial<Hello> | null;
			const welcome = hello ? this.check(hello) : null;
			if (!welcome) {
				ws.close(1008);
				return;
			}
			const old = this.sock;
			this.sock = ws; // one browser: the newest proven connection wins
			if (old && old !== ws) old.close(1000);
			ws.on('message', (m) => this.onMessage(ws, m));
			ws.on('close', () => {
				if (this.sock !== ws) return;
				this.sock = null;
				this.failAll(new BrowserLinkUnavailable('browser-closed'));
			});
			ws.send(JSON.stringify(welcome));
		});
	}

	/** Checks a first frame; the answer to send, or null to refuse. */
	private check(hello: Partial<Hello>): Welcome | null {
		if (hello.op === 'hello') {
			const token = this.opts.store.get();
			return token && typeof hello.token === 'string' && sameSecret(hello.token, token) ? { op: 'welcome' } : null;
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
			this.opts.store.set(token);
			return { op: 'paired', token };
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

	/** Sends one request to the browser and waits for its answer. */
	private send(req: LinkRequest, timeoutMs: number): Promise<unknown> {
		const ws = this.sock;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new BrowserLinkUnavailable(this.paired ? 'browser-closed' : 'not-paired'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new BrowserLinkError(`The browser did not answer within ${Math.round(timeoutMs / 1000)} s.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ id, ...req }));
		});
	}

	/** A request from a tab of the site, with the browser's own cookies. */
	async fetch(url: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: string | ArrayBuffer, redirect?: 'follow' | 'manual', timeoutMs = 120_000): Promise<FetchResult> {
		if (!isLinkTarget(url)) throw new BrowserLinkError('Blocked: not a site the Browser link may reach.');
		if (method !== 'GET' && method !== 'POST') throw new BrowserLinkError('Blocked: only GET and POST go through the Browser link.');
		const bytes = body === undefined ? undefined : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
		const req: LinkRequest = { op: 'fetch', url, method, headers, ...(bytes ? { body64: toBase64(bytes) } : {}), ...(redirect ? { redirect } : {}) };
		return (await this.send(req, timeoutMs)) as FetchResult;
	}

	/** Opens a background tab of the site (its own, never one of yours) and waits until `ready` holds. */
	async open(url: string, ready: ReadyCheck, timeoutMs: number): Promise<string> {
		if (!isLinkPage(url)) throw new BrowserLinkError('Blocked: not a site the Browser link may open.');
		const a = (await this.send({ op: 'open', url, ready, timeoutMs }, timeoutMs + 15_000)) as OpenAnswer;
		return a.page;
	}

	/** One signed call from a tab opened with `open`. */
	async call(page: string, c: PageCall, timeoutMs = 120_000): Promise<PageAnswer> {
		if (!isLinkTarget(c.url)) throw new BrowserLinkError('Blocked: not a site the Browser link may reach.');
		return ((await this.send({ op: 'call', page, call: c }, timeoutMs)) as CallAnswer).answer;
	}

	/** One named value from a page this link opened (not secret); '' when the page has none. */
	async read(page: string, value: PageValue, timeoutMs = 15_000): Promise<string> {
		const v = ((await this.send({ op: 'read', page, value }, timeoutMs)) as ReadAnswer).value;
		return typeof v === 'string' ? v : '';
	}

	/** One named value from a tab of `site` (a small cookie the page can read; not secret). */
	async siteValue(site: string, value: SiteValue, timeoutMs = 60_000): Promise<string> {
		if (!isLinkPage(site)) throw new BrowserLinkError('Blocked: not a site the Browser link may open.');
		const v = ((await this.send({ op: 'read', site, value }, timeoutMs)) as ReadAnswer).value;
		return typeof v === 'string' ? v : '';
	}

	async closePage(page: string): Promise<void> {
		if (!this.linked) return;
		await this.send({ op: 'close', page }, 15_000).catch(() => undefined);
	}

	async status(site: string): Promise<boolean> {
		if (!isLinkPage(site)) throw new BrowserLinkError('Blocked: not a site the Browser link may open.');
		return ((await this.send({ op: 'status', site }, 15_000)) as StatusAnswer).tabOpen;
	}
}

function toError(f: LinkFailure): Error {
	switch (f.error?.kind) {
		case 'not-logged-in': return new BrowserLinkUnavailable('not-logged-in');
		case 'no-tab':
		case 'timeout': return new BrowserLinkUnavailable('tab-failed');
		case 'not-allowed': return new BrowserLinkError('The browser refused this request: not on its list of allowed sites.');
		default: return new BrowserLinkError(`The browser could not do this request (${f.error?.kind === 'blocked' ? 'blocked' : 'failed'}).`);
	}
}
