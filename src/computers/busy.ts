// The busy marker: a small file saying which computer is syncing right now, so a second
// computer does not start at the same time and write the same notes. The vault's own sync
// (Proton Drive, Syncthing…) may bring it some minutes late, so it is a safety net: combining
// what each computer synced (merge.ts) keeps a rare overlap harmless. Pure functions.

export const BUSY_FILE = 'sync-busy.json';
/** A running sync says it is still alive this often. */
export const ALIVE_EVERY_MS = 60_000;
/** A marker with no sign of life for this long was left behind (lid closed, Obsidian killed). */
export const ABANDONED_AFTER_MS = 30 * 60_000;

export interface BusyMarker {
	v: 1;
	device: string;
	state: 'running' | 'idle';
	/** When the sync began (running only). */
	startedAt?: string;
	/** Last sign of life, or when it ended. */
	at: string;
}

export function runningMarker(device: string, startedAt: number, now: number): BusyMarker {
	return { v: 1, device, state: 'running', startedAt: new Date(startedAt).toISOString(), at: new Date(now).toISOString() };
}

export function idleMarker(device: string, now: number): BusyMarker {
	return { v: 1, device, state: 'idle', at: new Date(now).toISOString() };
}

export function parseBusy(text: string): BusyMarker | null {
	let o: unknown;
	try {
		o = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof o !== 'object' || o === null) return null;
	const m = o as Partial<BusyMarker>;
	if (m.v !== 1 || typeof m.device !== 'string' || (m.state !== 'running' && m.state !== 'idle') || typeof m.at !== 'string' || Number.isNaN(Date.parse(m.at))) return null;
	return m as BusyMarker;
}

/** Another computer that is syncing right now, or null. Our own marker never blocks us. */
export function busyElsewhere(m: BusyMarker | null, here: string, now: number): BusyMarker | null {
	if (!m || m.state !== 'running' || m.device === here) return null;
	const age = now - Date.parse(m.at);
	// A clock a little ahead on the other computer gives a small negative age: still alive.
	return age < ABANDONED_AFTER_MS ? m : null;
}

/** "Laptop is syncing (since 10:02)." */
export function busyText(m: BusyMarker, clock: (ms: number) => string): string {
	const since = m.startedAt ? ` (since ${clock(Date.parse(m.startedAt))})` : '';
	return `${m.device} is syncing${since}.`;
}
