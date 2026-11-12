// Hermes Agent (Nous Research) chats: every profile keeps its sessions in its own SQLite
// database, <profile home>/state.db (WAL mode: state.db + -wal + -shm are one image).
// Pure types, no Obsidian.

import type { DesktopTurn } from '../desktop/types';

/** One Hermes profile: a Hermes home folder with a state.db. */
export interface HermesProfile {
	/** Stable key for the index (the profile's folder path, lower case, forward slashes). */
	id: string;
	/** Shown in the settings and used as the vault subfolder: "default" or the profile's name. */
	label: string;
	/** The profile's Hermes home folder (holds state.db). */
	path: string;
	enabled: boolean;
	index: Record<string, HermesIndexEntry>;
	/** Sessions with no message from you, by session ID -> revision, so they are not rendered again. */
	ignored?: Record<string, string>;
}

/** What we remember per Hermes session in data.json (no chat text). */
export interface HermesIndexEntry {
	/** Revision of the session when last written: last message row ID and row count. */
	rev: string;
	/** Last activity (ISO). */
	updated: string;
	md: string;
	synced: string;
}

export interface HermesSettings {
	/** Vault folder; each profile gets a subfolder named after it. */
	folder: string;
	profiles: HermesProfile[];
	/** Python used when Obsidian has no built-in SQLite. Empty = look for Hermes' own Python, then "python". */
	pythonPath: string;
}

/** A session row, reduced to what the transcript needs. */
export interface HermesSessionRow {
	id: string;
	source: string;
	model?: string;
	provider?: string;
	title?: string;
	startedAt: number;
	endedAt?: number;
	parentId?: string;
	cwd?: string;
	/** Last message row ID and number of rows: changes whenever the session changes. */
	lastMessageId: number;
	messageRows: number;
	lastMessageAt?: number;
	/** Delegate/subagent helper run. */
	isSubagent: boolean;
}

export interface HermesMessageRow {
	id: number;
	sessionId: string;
	role: string;
	content: string | null;
	toolCalls: string | null;
	timestamp: number;
	/** Durable per-message ID (schema 31+); the same message can sit in two compaction generations. */
	uid?: string;
	/** Hidden from the chat view (model-only rows). */
	hidden: boolean;
}

export interface HermesSession {
	id: string;
	profile: string;
	title: string;
	/** ISO times of the first and last message. */
	created: string;
	updated: string;
	model?: string;
	provider?: string;
	/** Where it ran: cli, desktop, telegram, cron … */
	source: string;
	cwd?: string;
	parentId?: string;
	isSubagent: boolean;
	turns: DesktopTurn[];
}
