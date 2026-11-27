// A provider that answers 429 (too many requests) pauses that one account: the sync stops,
// remembers when it may go on, and the plugin retries by itself when the pause ends. Other
// accounts keep syncing. ChatGPT has done this since 0.30 (chatgpt/sync.ts); this is the same
// rule for Claude, Gemini, AI Studio and Lumo. No imports from the request code, so every
// part of the plugin can use it.

/** The pause state kept with an account, in this computer's file. */
export interface Cooling {
	/** When the provider allows requests again (ms since 1970). */
	cooldownUntil?: number;
	/** Set while an automatic retry is waiting; `consecutive` = pauses in a row. Null = retry canceled by you. */
	resumeAfter429?: { consecutive: number; forceFull?: boolean } | null;
}

/** The provider's "Retry-After" as a time: seconds or a date; unreadable = ten minutes. */
export function retryDeadline(value: string, now = Date.now()): number {
	const trimmed = value.trim();
	const time = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed);
	return Number.isFinite(time) && time <= 8.64e15 ? Math.max(now + 1000, time) : now + 10 * 60_000;
}

/** Respect the server deadline and slow down further if consecutive attempts are throttled. */
export function automaticRetryDeadline(serverUntil: number, consecutive: number, now = Date.now()): number {
	const delay = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(Math.max(0, consecutive - 1), 5));
	return Math.max(serverUntil, now + delay);
}

/** When this account's pause ends, or 0 when it is not paused. */
export function coolingUntil(c: Cooling, now = Date.now()): number {
	const until = c.cooldownUntil ?? 0;
	return until > now ? until : 0;
}

/**
 * At the start of a run. Paused: returns the time it ends and keeps the automatic retry
 * waiting. Not paused: returns 0.
 */
export function stillCooling(c: Cooling, now = Date.now()): number {
	const until = coolingUntil(c, now);
	if (until && c.resumeAfter429 === undefined) c.resumeAfter429 = { consecutive: 1 };
	return until;
}

/** The provider answered 429: start (or lengthen) the pause. Returns when the retry comes. */
export function startCooldown(c: Cooling, serverUntil: number, now = Date.now()): number {
	const consecutive = (c.resumeAfter429?.consecutive ?? 0) + 1;
	const deadline = automaticRetryDeadline(serverUntil, consecutive, now);
	c.cooldownUntil = deadline;
	c.resumeAfter429 = { consecutive };
	return deadline;
}

/** A run got through: the pause is over. True when there was something to clear. */
export function clearCooldown(c: Cooling): boolean {
	if (c.cooldownUntil === undefined && c.resumeAfter429 === undefined) return false;
	delete c.cooldownUntil;
	delete c.resumeAfter429;
	return true;
}

/** "mm:ss" until a time, for the status bar. */
export function countdown(until: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.ceil((until - now) / 1000));
	return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
