// Long ChatGPT chats come in several answers: the chat (newest turns) and older parts.
// Each is saved unchanged; this joins them into one chat for the transcript. Pure, testable offline.

import type { GptChat } from './types';

type Page = Pick<GptChat, 'messages'>;

/** The whole chat: oldest part first, the chat's own (newest) messages last; each message once. */
export function joinParts(main: GptChat, olderNewestFirst: Page[]): GptChat {
	const seen = new Set<string>();
	const messages = [...olderNewestFirst].reverse().flatMap((p) => p.messages).concat(main.messages).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
	return { ...main, messages };
}

/** "<stem> (older 1).json" = the part just before the main file, 2 = before that, … */
export function olderPartPath(folder: string, stem: string, n: number): string {
	return `${folder}/${stem} (older ${n}).json`;
}
