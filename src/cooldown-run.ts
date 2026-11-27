// How one sync run of an account deals with a rate-limit pause (see rate-limit.ts): it does
// not start while the pause lasts, a 429 during the run starts the pause, and a run that got
// through ends it. The same three steps for Claude, Gemini, AI Studio and Lumo.

import { RateLimitError } from './api';
import { clearCooldown, startCooldown, stillCooling, type Cooling } from './rate-limit';

/** The part of a sync result these steps fill in. `resumeAt` set = waiting, not an error. */
export interface WaitingResult {
	stopped?: string;
	resumeAt?: number;
}

/** Before a run: true when the account is still paused; the result then says until when. Save the settings after it. */
export function heldByCooldown(c: Cooling, service: string, result: WaitingResult, now = Date.now()): boolean {
	const until = stillCooling(c, now);
	if (!until) return false;
	result.resumeAt = until;
	result.stopped = `${service} is cooling down until ${new Date(until).toLocaleString()}.`;
	return true;
}

/** In a run's error handling: true when the error was a 429, which starts the pause. Save the settings after it. */
export function pausedBy(e: unknown, c: Cooling, result: WaitingResult, now = Date.now()): boolean {
	if (!(e instanceof RateLimitError)) return false;
	const deadline = startCooldown(c, e.until, now);
	result.resumeAt = deadline;
	result.stopped = `${new RateLimitError(e.service, deadline).message} Automatic retry scheduled.`;
	return true;
}

/** After a run: one that is not waiting ends the pause. True when there was one to end (save the settings). */
export function endCooldown(c: Cooling, result: WaitingResult): boolean {
	return result.resumeAt === undefined && clearCooldown(c);
}
