// The Sync button across devices (see protocol.ts for the two files and the rules).
//
// A Writer (a computer, by default) syncs itself and also runs the requests it finds.
// A Requester (a phone or tablet, by default) writes a request and shows what came back.
// The role, the device's name and what was handled live on the device (Obsidian's local
// storage for this vault), never in data.json, which may travel between devices.

import { Notice, Platform, type EventRef } from 'obsidian';
import type AIChatBridge from '../main';
import { computerName, UNNAMED_COMPUTER } from '../computer';
import { when } from '../last-run';
import { safeTitle } from '../naming';
import {
	controlFolder, decide, doneStatus, mayAsk, newRequest, onStatus, parseRequest, parseStatus, refusedStatus, remember, REQUEST_FILE, roleOf, runningStatus, STATUS_FILE, statusText,
	type Pending, type Role, type SyncStatus,
} from './protocol';

const KEY = {
	role: 'ai-chatbridge-role',
	device: 'ai-chatbridge-device',
	handled: 'ai-chatbridge-requests-handled',
	lastRun: 'ai-chatbridge-request-last-run',
	pending: 'ai-chatbridge-request-pending',
} as const;

/** A Writer looks for a request this often, besides the vault's own change events. */
const WRITER_POLL_MS = 60_000;
/** A Requester waiting for an answer looks this often. */
const REQUESTER_POLL_MS = 20_000;

export class RemoteSync {
	/** The last status file read, for the settings. */
	status: SyncStatus | null = null;
	private checking = false;
	private again = false;
	private waitTimer: number | null = null;
	private stopped = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly plugin: AIChatBridge) {}

	private get app() {
		return this.plugin.app;
	}

	// --- this device ---------------------------------------------------------

	get role(): Role {
		return roleOf(this.app.loadLocalStorage(KEY.role), Platform.isMobile);
	}

	setRole(role: Role): void {
		this.app.saveLocalStorage(KEY.role, role);
		this.changed();
		void this.check();
	}

	/** The role can be chosen here. A phone or tablet cannot sync itself yet. */
	get roleFixed(): boolean {
		return Platform.isMobile;
	}

	get deviceName(): string {
		const saved: unknown = this.app.loadLocalStorage(KEY.device);
		if (typeof saved === 'string' && saved.trim()) return saved.trim();
		if (Platform.isMobile) return Platform.isTablet ? 'Tablet' : 'Phone';
		const name = computerName();
		return name === UNNAMED_COMPUTER ? 'Computer' : name;
	}

	setDeviceName(name: string): void {
		const clean = safeTitle(name.trim()).slice(0, 40);
		this.app.saveLocalStorage(KEY.device, clean || null);
		this.changed();
	}

	get pending(): Pending | null {
		const p = this.app.loadLocalStorage(KEY.pending) as Pending | null;
		return p && typeof p.id === 'string' && typeof p.at === 'number' ? p : null;
	}

	private get handled(): string[] {
		const h: unknown = this.app.loadLocalStorage(KEY.handled);
		return Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : [];
	}

	private get lastRunAt(): number {
		const n: unknown = this.app.loadLocalStorage(KEY.lastRun);
		return typeof n === 'number' ? n : 0;
	}

	// --- the files -------------------------------------------------------------

	/** The folder of the two files, or null while the setting is unusable. */
	get folder(): string | null {
		return controlFolder(this.plugin.settings.remote.folder);
	}

	private path(name: string): string | null {
		const f = this.folder;
		return f ? `${f}/${name}` : null;
	}

	private async read(name: string): Promise<string | null> {
		const p = this.path(name);
		if (!p) return null;
		try {
			const adapter = this.app.vault.adapter;
			return (await adapter.exists(p)) ? await adapter.read(p) : null;
		} catch {
			return null; // being written or carried over right now: the next look gets it
		}
	}

	private async write(name: string, value: unknown): Promise<void> {
		const folder = this.folder;
		if (!folder) throw new Error('The folder for sync requests is not set (General tab).');
		const adapter = this.app.vault.adapter;
		let at = '';
		for (const part of folder.split('/')) {
			at = at ? `${at}/${part}` : part;
			if (!(await adapter.exists(at))) await adapter.mkdir(at);
		}
		const path = `${folder}/${name}`;
		const text = `${JSON.stringify(value, null, '\t')}\n`;
		await adapter.write(path, text);
		// Android (seen on a Pixel, 2026-11-16): a file that was just created keeps a reported
		// size of 0 although its text is there, and a vault sync that goes by the size (Syncthing)
		// then delivers an empty file. Writing it once more makes the size right.
		const stat = await adapter.stat(path).catch(() => null);
		if (!stat || stat.size === 0) await adapter.write(path, text);
	}

	// --- life cycle --------------------------------------------------------------

	/** Call once the layout is ready. Returns what the plugin must register for clean-up. */
	start(): { events: EventRef[]; interval: number } {
		const mine = (path: string) => path === this.path(REQUEST_FILE) || path === this.path(STATUS_FILE);
		const events = [
			this.app.vault.on('create', (f) => { if (mine(f.path)) void this.check(); }),
			this.app.vault.on('modify', (f) => { if (mine(f.path)) void this.check(); }),
		];
		// The vault does not always notice files another app changed (above all on Android),
		// so both sides also look on a timer; a Requester only while it waits for an answer.
		let tick = 0;
		const interval = window.setInterval(() => {
			tick += REQUESTER_POLL_MS;
			if (this.role === 'requester' ? this.pending !== null : tick % WRITER_POLL_MS === 0) void this.check();
		}, REQUESTER_POLL_MS);
		this.plugin.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') void this.check();
		});
		// A request that came while a sync ran is taken up when that sync ends.
		this.plugin.onBusyChange(() => {
			if (!this.plugin.busy && this.role === 'writer') void this.check();
		});
		void this.check();
		return { events, interval };
	}

	stop(): void {
		this.stopped = true;
		if (this.waitTimer !== null) window.clearTimeout(this.waitTimer);
		this.waitTimer = null;
		this.listeners.clear();
	}

	/** Calls `fn` when the role, the name or the last status changes. Returns the way to stop listening. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch {
				this.listeners.delete(fn);
			}
		}
	}

	/** Looks at the files once. Calls that come while one look is under way are folded into one more. */
	async check(): Promise<void> {
		if (this.stopped) return;
		if (this.checking) {
			this.again = true;
			return;
		}
		this.checking = true;
		try {
			do {
				this.again = false;
				await this.readStatus();
				if (this.role === 'writer') await this.serve();
			} while (this.again && !this.stopped);
		} catch (e) {
			console.error('AI ChatBridge: could not handle a sync request', e instanceof Error ? e.message : e);
		} finally {
			this.checking = false;
		}
	}

	// --- Requester -----------------------------------------------------------------

	/** The Sync button on a Requester: writes the request. */
	async ask(): Promise<void> {
		const now = Date.now();
		const waiting = this.pending;
		if (!mayAsk(waiting, now)) {
			new Notice(`Already asked ${when(waiting!.at, now)}. The request is on its way to the computer; ask again in a couple of minutes if nothing happens.`, 8000);
			return;
		}
		const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		try {
			await this.write(REQUEST_FILE, newRequest(id, this.deviceName, now));
		} catch (e) {
			new Notice(`Could not write the sync request: ${e instanceof Error ? e.message : 'unknown error'}`, 10_000);
			return;
		}
		this.app.saveLocalStorage(KEY.pending, { id, at: now } satisfies Pending);
		this.changed();
		new Notice('Asked the computer to sync. It starts once the request has reached it; you are told here when it is done.', 8000);
	}

	private async readStatus(): Promise<void> {
		const text = await this.read(STATUS_FILE);
		const status = text === null ? null : parseStatus(text);
		const before = JSON.stringify(this.status);
		if (status) this.status = status;
		const r = onStatus(this.pending, status);
		if (r.notify && status && this.role === 'requester') {
			const { text: line, tone } = statusText(status, (ms) => when(ms));
			new Notice(line, tone === 'ok' && status.state === 'running' ? 6000 : 15_000);
		}
		if (JSON.stringify(r.pending) !== JSON.stringify(this.pending)) this.app.saveLocalStorage(KEY.pending, r.pending);
		if (r.notify || before !== JSON.stringify(this.status)) this.changed();
	}

	// --- Writer -----------------------------------------------------------------

	private async serve(): Promise<void> {
		const text = await this.read(REQUEST_FILE);
		const request = text === null ? null : parseRequest(text);
		const { plugin } = this;
		// A status still saying "running" for a sync that is not running here any more
		// (Obsidian was closed in the middle): close it, so the asking device stops waiting.
		const stale = this.status;
		if (stale?.state === 'running' && stale.device === this.deviceName && !plugin.busy && this.handled.includes(stale.requestId)) {
			const closed = doneStatus(stale, [], Date.now(), 'Obsidian was closed or the plugin reloaded before the sync finished. What was saved until then stays saved.');
			await this.write(STATUS_FILE, closed);
			this.status = closed;
			this.changed();
		}
		if (!request) return; // none, or half written: the next look gets it
		const maxAge = plugin.settings.remote.maxAgeHours;
		const now = Date.now();
		const d = decide(request, now, { handled: this.handled, lastRunAt: this.lastRunAt, busy: plugin.busy }, maxAge);
		if (d.action === 'ignore') return;
		if (d.action === 'too-old') {
			this.app.saveLocalStorage(KEY.handled, remember(this.handled, request.id));
			await this.write(STATUS_FILE, refusedStatus(request, this.deviceName, now, d.hours, maxAge));
			return;
		}
		if (d.action === 'wait') {
			// A running sync tells us when it ends (start()); a too-early request gets a timer.
			if (d.at !== undefined && this.waitTimer === null) {
				this.waitTimer = window.setTimeout(() => {
					this.waitTimer = null;
					void this.check();
				}, d.at - now + 500);
			}
			return;
		}
		// Another computer is syncing this vault: it may well answer this request itself. If not,
		// the next look (every minute) takes it once that computer has finished.
		if (await plugin.computers.busyElsewhere(now)) return;
		const running = runningStatus(request, this.deviceName, now);
		await this.write(STATUS_FILE, running);
		// Something else may have started while the status was written; then this request waits.
		if (plugin.busy || this.stopped) return;
		this.app.saveLocalStorage(KEY.handled, remember(this.handled, request.id));
		this.app.saveLocalStorage(KEY.lastRun, now);
		this.status = running;
		this.changed();
		new Notice(`AI ChatBridge: ${request.device} asked for a sync.`, 6000);
		let error: string | undefined;
		try {
			await plugin.syncAllRequested();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		if (this.stopped) return;
		const runs = Object.values(plugin.settings.lastRuns).filter((r) => r.at >= now);
		const done = doneStatus(running, runs, Date.now(), error, plugin.pausedSources());
		await this.write(STATUS_FILE, done);
		this.status = done;
		this.changed();
		this.again = true; // another request may have come in the meantime
	}
}
