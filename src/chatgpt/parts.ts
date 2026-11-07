// Long ChatGPT chats come in several answers: the chat (newest turns) and older parts.
// Each is saved unchanged; this joins them into one chat for the transcript. Pure, testable offline.

import type { GptChat } from './types';
import { ShapeError } from '../schema';

type Page = Pick<GptChat, 'messages'>;

/** The whole chat: oldest part first, the chat's own (newest) messages last; each message once. */
export function joinParts(main: GptChat, olderNewestFirst: Page[]): GptChat {
	const seen = new Map<string, GptChat['messages'][number]>();
	const canonical = (m: GptChat['messages'][number]) => JSON.stringify(m, (_key, value: unknown) => {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
	});
	const messages = [...olderNewestFirst].reverse().flatMap((p) => p.messages).concat(main.messages).filter((m) => {
		const previous = seen.get(m.id);
		if (previous === undefined) {
			seen.set(m.id, m);
			return true;
		}
		if (canonical(previous) !== canonical(m)) throw new ShapeError('ChatGPT message changed between pages. Try syncing the chat again.');
		return false;
	});
	return { ...main, messages };
}

/** "<stem> (older 1).json" = the part just before the main file, 2 = before that, … */
export function olderPartPath(folder: string, stem: string, n: number): string {
	return `${folder}/${stem} (older ${n}).json`;
}
