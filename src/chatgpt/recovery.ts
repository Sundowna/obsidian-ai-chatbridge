import { createHash } from 'crypto';
import { StopError } from '../api';
import type { IndexEntry } from '../types';

export interface Capture extends IndexEntry {
	pageHashes: string[];
}

export interface AssetRetry {
	attempts: number;
	nextAttempt: number;
	reason: string;
}

export function fingerprint(value: string | ArrayBuffer): string {
	return createHash('sha256').update(typeof value === 'string' ? value : new Uint8Array(value)).digest('hex');
}

export function retryAsset(previous: AssetRetry | undefined, reason: string, now = Date.now()): AssetRetry {
	const attempts = (previous?.attempts ?? 0) + 1;
	const delay = Math.min(7 * 86_400_000, 3_600_000 * 2 ** Math.min(attempts - 1, 8));
	return { attempts, nextAttempt: now + delay, reason };
}

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

export class GptRateLimitError extends StopError {
	constructor(readonly until: number) {
		super(`ChatGPT answered 429 (too many requests). Sync can resume after ${new Date(until).toLocaleString()}.`);
	}
}
