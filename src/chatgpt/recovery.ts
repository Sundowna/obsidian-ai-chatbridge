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

export async function fingerprint(value: string | ArrayBuffer): Promise<string> {
	const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
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
