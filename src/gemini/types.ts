// What the plugin keeps from Gemini and AI Studio. Google's own rows have no field names,
// so each saved chat holds these readable fields plus the rows exactly as Google sent them.

import type { ListItem } from '../types';

/** A chat on Gemini's chat list. */
export interface GeminiListItem extends ListItem {
	pinned: boolean;
}

/** A picture Gemini showed in an answer, found on the web. Not downloaded. */
export interface GeminiImage {
	/** The answer refers to it as <Image … src="<tag>"/>. */
	tag: string;
	url?: string;
	/** The page the picture comes from, and that site's name. */
	page?: string;
	site?: string;
}

export interface GeminiTurn {
	id: string;
	createdAt: string;
	prompt: string;
	answer: string;
	reasoning?: string;
	model?: string;
	images?: GeminiImage[];
	/** Other drafts Gemini wrote for this prompt; only the one shown is in `answer`. */
	otherDrafts?: number;
}

/** A Gemini chat's .json file. */
export interface GeminiChat {
	id: string;
	title: string;
	pinned?: boolean;
	createdAt: string;
	updatedAt: string;
	turns: GeminiTurn[];
	/** Google's turn rows, oldest first, unchanged. */
	raw: unknown[];
}

export interface StudioMessage {
	role: 'user' | 'model';
	text: string;
	/** Gemini's thinking, which AI Studio saves as a separate model message. */
	thought?: boolean;
	createdAt?: string;
	tokens?: number;
}

/** An AI Studio prompt's .json file. */
export interface StudioPrompt {
	id: string;
	title: string;
	updatedAt: string;
	model?: string;
	systemInstruction?: string;
	messages: StudioMessage[];
	/** Google's prompt row, unchanged. */
	raw: unknown;
}
