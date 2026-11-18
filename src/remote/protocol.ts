// Asking another device to sync, through two small files in the vault.
//
//   sync-request.json   written only by a Requester (the phone): "please sync"
//   sync-status.json    written only by the Writer (the computer): what it did with that request
//
// Whatever carries the vault between the devices (Syncthing, Obsidian Sync, …) carries these
// too; there is no other link. Each file has one writing side, so the two devices never write
// the same file. Pure code, testable offline: no Obsidian, no clock of its own.

import { maskSecrets } from '../chatgpt/token';
import type { LastRun, RunOutcome } from '../last-run';

export const REQUEST_FILE = 'sync-request.json';
export const STATUS_FILE = 'sync-status.json';
export const PROTOCOL = 1;

/** A Writer runs at most one requested sync in this time. */
export const MIN_GAP_MS = 2 * 60_000;
export const DEFAULT_MAX_AGE_HOURS = 12;
/** How many handled request IDs a Writer remembers. */
export const REMEMBER_IDS = 50;

export type Role = 'writer' | 'requester';

/** A computer syncs itself; a phone or tablet asks. */
export const defaultRole = (isMobile: boolean): Role => (isMobile ? 'requester' : 'writer');

/** The role saved on this device, or its default. A phone or tablet cannot sync itself yet, so it always asks. */
export function roleOf(stored: unknown, isMobile: boolean): Role {
	if (isMobile) return 'requester';
	return stored === 'writer' || stored === 'requester' ? stored : defaultRole(false);
}

export interface SyncRequest {
	v: number;
	id: string;
	/** The asking device's name. */
	device: string;
	/** When it asked, by its own clock (ISO). */
	at: string;
	/** What to sync. Only "all" for now. */
	providers: string[];
}

export type StatusState = 'running' | 'done' | 'refused';
export type StatusResult = 'ok' | 'problems' | 'stopped' | 'nothing' | 'too-old' | 'failed';

export interface ProviderStatus {
	outcome: RunOutcome;
	new: number;
	changed: number;
	unchanged: number;
	restored: number;
	leftForLater: number;
	/** The stop or error reason, already cleaned of logins. */
	note?: string;
}

export interface SyncStatus {
	v: number;
	requestId: string;
	/** The device that ran (or refused) the sync. */
	device: string;
	requestedBy: string;
	state: StatusState;
	startedAt: string;
	finishedAt?: string;
	result?: StatusResult;
	/** One entry per account or app that ran, by its label ("claude.ai (Work)"). */
	providers: Record<string, ProviderStatus>;
	/** One sentence for people, without secrets. */
	message?: string;
}

const ID = /^[a-z0-9-]{8,64}$/;
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v !== '' && v.length <= max;
const isoMs = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

export function newRequest(id: string, device: string, now: number): SyncRequest {
	return { v: PROTOCOL, id, device, at: new Date(now).toISOString(), providers: ['all'] };
}

/** A request file's text as a request, or null if it is empty, half written, or not ours. */
export function parseRequest(text: string): SyncRequest | null {
	let j: unknown;
	try {
		j = JSON.parse(text);
	} catch {
		return null;
	}
	if (j === null || typeof j !== 'object') return null;
	const r = j as Record<string, unknown>;
	if (r.v !== PROTOCOL || !str(r.id) || !ID.test(r.id) || !str(r.device, 80) || Number.isNaN(isoMs(r.at))) return null;
	const providers = Array.isArray(r.providers) ? r.providers.filter((p): p is string => str(p, 40)) : [];
	return { v: PROTOCOL, id: r.id, device: r.device, at: r.at as string, providers: providers.length ? providers : ['all'] };
}

export function parseStatus(text: string): SyncStatus | null {
	let j: unknown;
	try {
		j = JSON.parse(text);
	} catch {
		return null;
	}
	if (j === null || typeof j !== 'object') return null;
	const s = j as Record<string, unknown>;
	if (s.v !== PROTOCOL || !str(s.requestId) || !ID.test(s.requestId) || !str(s.device, 80)) return null;
	if (s.state !== 'running' && s.state !== 'done' && s.state !== 'refused') return null;
	if (Number.isNaN(isoMs(s.startedAt))) return null;
	return j as SyncStatus;
}

export interface WriterState {
	/** Request IDs already handled on this device. */
	handled: readonly string[];
	/** When this device last started a requested sync (ms), or 0. */
	lastRunAt: number;
	/** A sync, or a project-list fetch, is running here right now. */
	busy: boolean;
}

export type Decision =
	| { action: 'run' }
	| { action: 'ignore' }
	| { action: 'too-old'; hours: number }
	/** Not yet: look again at `at` (ms), or when the running sync ends. */
	| { action: 'wait'; at?: number };

/**
 * What a Writer does with the request it found.
 * - an ID it has handled: nothing, ever again
 * - older than the limit: refused once (and remembered), so an old request does not start a
 *   sync days later when the computer comes back
 * - a sync is running: wait for it, never interrupt it
 * - a requested sync started less than two minutes ago: wait until the two minutes are over
 */
export function decide(request: SyncRequest, now: number, state: WriterState, maxAgeHours: number): Decision {
	if (state.handled.includes(request.id)) return { action: 'ignore' };
	const age = now - isoMs(request.at);
	if (age > maxAgeHours * 3_600_000) return { action: 'too-old', hours: Math.round(age / 3_600_000) };
	if (state.busy) return { action: 'wait' };
	const next = state.lastRunAt + MIN_GAP_MS;
	if (state.lastRunAt > 0 && now < next) return { action: 'wait', at: next };
	return { action: 'run' };
}

/** The handled list with one more ID, oldest dropped. */
export function remember(handled: readonly string[], id: string): string[] {
	return [...handled.filter((x) => x !== id), id].slice(-REMEMBER_IDS);
}

export function runningStatus(request: SyncRequest, device: string, now: number): SyncStatus {
	return { v: PROTOCOL, requestId: request.id, device, requestedBy: request.device, state: 'running', startedAt: new Date(now).toISOString(), providers: {} };
}

export function refusedStatus(request: SyncRequest, device: string, now: number, hours: number, maxAgeHours: number): SyncStatus {
	const at = new Date(now).toISOString();
	return {
		v: PROTOCOL, requestId: request.id, device, requestedBy: request.device, state: 'refused', startedAt: at, finishedAt: at, result: 'too-old', providers: {},
		message: `The request was ${hours} hours old when ${device} saw it (limit ${maxAgeHours}), so it was not run. Ask again.`,
	};
}

/** A note for the status file: no logins, one line, not long. */
export function cleanNote(note: string): string {
	const t = maskSecrets(note.replace(/sessionKey=[^;\s"']+/gi, 'sessionKey=[hidden]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [hidden]')).replace(/\s+/g, ' ').trim();
	return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

/**
 * The finished status, from the runs the sync recorded since it started.
 * `error` is set when the sync itself threw before or between the runs. `waiting` names the
 * sources the Writer skipped because an earlier error there still waits for a sync by hand.
 */
export function doneStatus(running: SyncStatus, runs: readonly LastRun[], now: number, error?: string, waiting: readonly string[] = []): SyncStatus {
	const providers: Record<string, ProviderStatus> = {};
	for (const r of runs) {
		const p: ProviderStatus = { outcome: r.outcome, new: r.newCount, changed: r.changedCount, unchanged: r.unchanged, restored: r.restored, leftForLater: r.leftForLater };
		if (r.note) p.note = cleanNote(r.note);
		providers[r.label] = p;
	}
	const bad = runs.filter((r) => r.outcome === 'error' || r.outcome === 'waiting');
	const skipped = waiting.filter((label) => !bad.some((r) => r.label === label));
	const result: StatusResult = error ? 'failed'
		: !runs.length && !skipped.length ? 'nothing'
		: runs.some((r) => r.outcome === 'stopped') ? 'stopped'
		: bad.length || skipped.length ? 'problems'
		: 'ok';
	const hand = skipped.length ? ` Skipped until synced by hand on ${running.device}: ${skipped.join(', ')}.` : '';
	const saved = runs.reduce((n, r) => n + r.newCount + r.changedCount + r.restored, 0);
	const message = error ? `The sync failed: ${cleanNote(error)}`
		: result === 'nothing' ? `Nothing to sync: ${running.device} is not logged in to any provider, or its automatic sync is waiting.`
		: result === 'stopped' ? `Stopped on ${running.device}. ${saved} saved before that.`
		: result === 'problems' ? `${saved} saved.${bad.length ? ` Problems: ${bad.map((r) => r.label).join(', ')}.` : ''}${hand}`
		: `${saved} saved, ${runs.reduce((n, r) => n + r.unchanged, 0)} unchanged.`;
	return { ...running, state: 'done', finishedAt: new Date(now).toISOString(), result, providers, message };
}

export type StatusTone = 'ok' | 'warn' | 'bad';

/** One line for the asking device: what the other one did. `clock` turns a time into words. */
export function statusText(s: SyncStatus, clock: (ms: number) => string): { text: string; tone: StatusTone } {
	if (s.state === 'running') return { text: `${s.device} is syncing (started ${clock(isoMs(s.startedAt))}).`, tone: 'ok' };
	const at = clock(isoMs(s.finishedAt ?? s.startedAt));
	if (s.state === 'refused') return { text: `${s.device} did not sync (${at}): ${s.message ?? 'the request was too old.'}`, tone: 'warn' };
	const tone: StatusTone = s.result === 'ok' ? 'ok' : s.result === 'failed' || s.result === 'problems' ? 'bad' : 'warn';
	return { text: `Last synced by ${s.device} ${at}: ${s.message ?? s.result ?? 'done'}`, tone };
}

/** The request this device is waiting on (kept on the device, not in the vault). */
export interface Pending {
	id: string;
	at: number;
	/** The last state shown for it, so each is told once. */
	seen?: StatusState;
}

/**
 * What the asking device does with a status it read: tell the person (once per state), and
 * stop waiting when the other device has finished or refused. A status for another request
 * (an older one, or another device's) says nothing about this one.
 */
export function onStatus(pending: Pending | null, status: SyncStatus | null): { notify: boolean; pending: Pending | null } {
	if (!pending || !status || status.requestId !== pending.id) return { notify: false, pending };
	if (status.state === 'running') return { notify: pending.seen !== 'running', pending: { ...pending, seen: 'running' } };
	return { notify: true, pending: null };
}

/** May this device ask again? Not while a request younger than the Writer's own two-minute gap is still unanswered. */
export function mayAsk(pending: Pending | null, now: number): boolean {
	return !pending || now - pending.at >= MIN_GAP_MS;
}

/** A folder path for the control files: no leading or trailing slash, no "..", not hidden. Null if unusable. */
export function controlFolder(input: string): string | null {
	const parts = input.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p !== '');
	if (!parts.length || parts.some((p) => p === '..' || p === '.' || p.startsWith('.'))) return null;
	return parts.join('/');
}
