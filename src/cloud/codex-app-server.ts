// Codex's cloud connection (chatgpt.com/codex since its Nov 2026 redesign), read only.
//
// Seen in DevTools on 2026-11-18: the Codex page keeps one websocket to
// wss://codex-cloud-backend.chatgpt.com/ and speaks the Codex app-server protocol over it
// (JSON-RPC 2.0 without the "jsonrpc" field, as in github.com/openai/codex, codex-rs/app-server).
// The login goes in the sub-protocols: ["codex-app-server", "codex-client.browser",
// "openai-bearer.<access token>"] – the same access token the chat sync already gets from
// chatgpt.com. The server accepts any Origin, including Obsidian's (tested 2026-11-18).
// After "initialize" the plugin only ever asks three things: thread/list, thread/turns/list (the
// turns' status, without their steps) and thread/items/list (the steps, oldest first, as the Codex
// page itself reads them; asking thread/turns/list for full steps hangs on long tasks).

import { StopError } from '../api';

export const CODEX_APP_SERVER_URL = 'wss://codex-cloud-backend.chatgpt.com/';

/** The only methods this plugin sends: reading, never starting or changing anything. */
const READ_ONLY = new Set(['initialize', 'thread/list', 'thread/turns/list', 'thread/items/list']);

/** The parts of a WebSocket used here (a fake in the tests). */
export interface SocketLike {
	readonly readyState: number;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: { code?: number }) => void) | null;
	send(data: string): void;
	close(): void;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

const browserSocket: SocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: number;
}

export type CodexMethod = 'thread/list' | 'thread/turns/list' | 'thread/items/list';

/** The read-only calls the Codex cloud sync makes (a fake in the tests). */
export interface CodexCloudClient {
	call(method: CodexMethod, params: Record<string, unknown>): Promise<unknown>;
	close(): void;
}

export class CodexAppServer implements CodexCloudClient {
	private readonly pending = new Map<string, Pending>();
	private next = 1;
	private closedReason: string | null = null;

	private constructor(private readonly socket: SocketLike, private readonly timeoutMs: number) {
		socket.onmessage = (ev) => this.onMessage(ev.data);
		socket.onclose = (ev) => this.fail(`the Codex connection closed (code ${ev?.code ?? '?'})`);
		socket.onerror = () => this.fail('the Codex connection failed');
	}

	/**
	 * Connects and says hello. `version` is the plugin's, sent as the client's name.
	 * Never puts the token into an error message.
	 */
	static async open(token: string, version: string, factory: SocketFactory = browserSocket, timeoutMs = 60_000): Promise<CodexAppServer> {
		if (!token) throw new StopError('No ChatGPT login key for Codex.');
		let socket: SocketLike;
		try {
			socket = factory(CODEX_APP_SERVER_URL, ['codex-app-server', 'codex-client.browser', `openai-bearer.${token}`]);
		} catch {
			throw new StopError('Could not open the Codex connection (codex-cloud-backend.chatgpt.com).');
		}
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new StopError('Codex did not answer within 30 s (codex-cloud-backend.chatgpt.com).')), 30_000);
			socket.onopen = () => {
				window.clearTimeout(timer);
				resolve();
			};
			socket.onerror = () => {
				window.clearTimeout(timer);
				reject(new StopError('Codex refused the connection – log in to ChatGPT again in the plugin settings. If that does not help, chatgpt.com may have changed how Codex connects.'));
			};
			socket.onclose = socket.onerror;
			if (socket.readyState === 1) socket.onopen(undefined);
		});
		const server = new CodexAppServer(socket, timeoutMs);
		try {
			await server.request('initialize', {
				clientInfo: { name: 'obsidian-ai-chatbridge', title: 'AI ChatBridge for Obsidian', version },
				capabilities: { experimentalApi: true, requestAttestation: false },
			});
			socket.send(JSON.stringify({ method: 'initialized' }));
		} catch (e) {
			server.close();
			throw e;
		}
		return server;
	}

	call(method: CodexMethod, params: Record<string, unknown>): Promise<unknown> {
		return this.request(method, params);
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (!READ_ONLY.has(method)) return Promise.reject(new StopError(`Blocked a Codex request the plugin does not use (${method}).`));
		if (this.closedReason) return Promise.reject(new StopError(`Codex: ${this.closedReason}.`));
		const id = `chatbridge-${this.next++}`;
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new StopError(`Codex did not answer "${method}" within ${Math.round(this.timeoutMs / 1000)} s.`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch {
				window.clearTimeout(timer);
				this.pending.delete(id);
				reject(new StopError('Could not send to Codex: the connection is gone.'));
			}
		});
	}

	private onMessage(data: unknown): void {
		if (typeof data !== 'string') return;
		let m: { id?: unknown; method?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
		try {
			m = JSON.parse(data) as typeof m;
		} catch {
			return;
		}
		// Notifications (no id) and requests from the server (id and method) are not ours.
		if (typeof m.id !== 'string' || m.method !== undefined) return;
		const p = this.pending.get(m.id);
		if (!p) return;
		this.pending.delete(m.id);
		window.clearTimeout(p.timer);
		if (m.error) {
			const what = typeof m.error.message === 'string' ? m.error.message : typeof m.error.code === 'number' ? `code ${m.error.code}` : 'unknown';
			p.reject(new StopError(`Codex answered with an error: ${what.slice(0, 300)}`));
		}
		else p.resolve(m.result);
	}

	private fail(reason: string): void {
		if (this.closedReason) return;
		this.closedReason = reason;
		for (const [id, p] of this.pending) {
			window.clearTimeout(p.timer);
			p.reject(new StopError(`Codex: ${reason}.`));
			this.pending.delete(id);
		}
	}

	close(): void {
		this.fail('closed');
		try {
			this.socket.close();
		} catch {
			// already gone
		}
	}
}
