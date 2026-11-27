// One chat a provider sends in an odd shape is skipped, named in the log and tried again on
// the next run. Several in one run look like a format change, so the sync stops rather than
// guess. The same rule for every provider (Gemini had it first).

import { ShapeError } from './schema';

/** Chats in one run that may fail verification and be skipped before the sync stops. */
export const MAX_ODD_CHATS = 2;

export class OddChats {
	/** The chats skipped so far in this run, by name. */
	readonly names: string[] = [];

	/** True = skip this chat and go on. False = not an odd shape, or one too many: stop as before. */
	skip(e: unknown, name: string): boolean {
		if (!(e instanceof ShapeError) || this.names.length >= MAX_ODD_CHATS) return false;
		this.names.push(name);
		console.warn('AI ChatBridge: chat skipped, its data has an unexpected shape', e.message);
		return true;
	}
}

/** Runs `read`; an odd-shaped chat gives null (skipped), anything else is thrown on. */
export async function readOrSkip<T>(odd: OddChats, name: string, read: () => Promise<T> | T): Promise<T | null> {
	try {
		return await read();
	} catch (e) {
		if (odd.skip(e, name)) return null;
		throw e;
	}
}
