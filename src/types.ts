// Shapes of the claude.ai JSON we rely on, as seen in DevTools (2026-11-05).
// Only the fields we actually use are listed; everything else is kept untouched
// in the raw .json file anyway.

import type { QuickCheck } from './quick-check';

export interface ProjectRef {
	name: string;
	uuid: string;
}

/** One entry of GET /api/organizations/<org>/chat_conversations_v2 */
export interface ListItem {
	uuid: string;
	name: string;
	created_at: string;
	updated_at: string;
	project?: ProjectRef | null;
	project_uuid?: string;
	/** "CLAUDE_AI" for every chat seen so far (2026-11-05). */
	platform?: string;
}

export interface ListPage {
	data: ListItem[];
	has_more: boolean;
}

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	[key: string]: unknown;
}

export interface FileRef {
	file_name?: string;
	file_uuid?: string;
	/** "image" or "blob" (seen 2026-11-05) */
	file_kind?: string;
	size_bytes?: number;
	success?: boolean;
	[key: string]: unknown;
}

export interface ChatMessage {
	uuid: string;
	sender: string;
	text?: string;
	content?: ContentBlock[];
	created_at?: string;
	index?: number;
	parent_message_uuid?: string;
	attachments?: FileRef[];
	files?: FileRef[];
}

/** GET /api/organizations/<org>/chat_conversations/<uuid>?tree=True&rendering_mode=messages */
export interface Chat {
	uuid: string;
	name: string;
	created_at: string;
	updated_at: string;
	project_uuid?: string;
	current_leaf_message_uuid?: string;
	chat_messages: ChatMessage[];
}

/** The raw files of one earlier version of a chat, kept when the chat continued. */
export interface RawVersion {
	/** That version's own "updated" time, as the provider gave it. */
	at: string;
	/** The main raw file first, then its parts (ChatGPT's older pages). */
	files: string[];
}

/** What every index entry remembers about its one note (see versions.ts). */
export interface NoteState {
	/** Earlier versions, oldest first. */
	versions?: RawVersion[];
	/** Fingerprint of the note's text as the plugin last wrote it, to notice your edits. */
	noteHash?: string;
}

/** What we remember per chat in data.json (no secrets). */
export interface IndexEntry extends NoteState {
	updated_at: string;
	json: string;
	md: string;
	synced: string;
	/** updated_at for which the chat-view files (ReadConversation) were last checked. */
	outputsChecked?: string;
	/** ChatGPT long chats: the older parts, each saved unchanged ("… (older 1).json" = just before the main file). */
	older?: string[];
	/** ChatGPT capture integrity and most recent derived transcript. */
	pageHashes?: string[];
	view?: string;
	viewHash?: string;
	/** What the last full check of this unchanged chat depended on (quick-check.ts). */
	quick?: QuickCheck;
}
