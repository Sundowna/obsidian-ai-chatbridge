// A request that gets no answer at all (a broken connection, a TLS error) is tried again
// after a short pause; only when every try fails does the caller give up. For read requests
// only: nothing that changes something on the provider's side may be sent twice.
// ChatGPT has done this since 0.41.3 (chatgpt/api.ts, issue #48); this is the same rule
// for Claude, Gemini, AI Studio and Lumo.

/** Pauses before the second and the third try. */
export const NETWORK_RETRY_WAITS_MS: readonly number[] = [2000, 5000];

/** Replaced by tests so they do not wait. */
export const netRetry = {
	pause: (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms)),
};

/** Every try failed. `cause` is the last failure. */
export class NetworkFailure extends Error {
	constructor(readonly cause: unknown, readonly tries: number) {
		super('network failure');
	}
}

/** " (tried 3 times)" for the message, or nothing after a single try. */
export const triedText = (tries: number): string => (tries > 1 ? ` (tried ${tries} times)` : '');

/**
 * Runs `send`; when it throws, waits and runs it again, up to three tries in all.
 * Throws NetworkFailure when the last try failed too.
 */
export async function sendWithRetry<T>(send: () => Promise<T>, waits: readonly number[] = NETWORK_RETRY_WAITS_MS): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await send();
		} catch (e) {
			const wait = waits[attempt];
			if (wait === undefined) throw new NetworkFailure(e, attempt + 1);
			await netRetry.pause(wait);
		}
	}
}
