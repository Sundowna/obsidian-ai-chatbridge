// Chats that only exist on this computer: sessions saved by the Claude desktop app
// (Claude Code, Cowork) and the ChatGPT/Codex desktop app. Pure types, no Obsidian.

import type { SessionFile, SessionLink } from './session-files';

export type DesktopApp = 'claude' | 'codex';

export const APP_LABEL: Record<DesktopApp, string> = {
	claude: 'Claude desktop',
	codex: 'ChatGPT desktop (Codex)',
};

/** Who speaks in the transcript headings. */
export const ASSISTANT_NAME: Record<DesktopApp, string> = {
	claude: 'Claude',
	codex: 'Codex',
};

export interface DesktopTurn {
	role: 'user' | 'assistant';
	/** ISO time of the first record in this turn. */
	time?: string;
	/** Text pieces and tool-step counts, in order. */
	parts: ({ text: string } | { tools: number })[];
}

export interface DesktopSession {
	app: DesktopApp;
	/** Session/thread ID from the file (stable across appends). */
	id: string;
	title: string;
	/** ISO times of the first and last record. */
	created: string;
	updated: string;
	/** Working folder the session ran in, if recorded. */
	cwd?: string;
	model?: string;
	/** Codex: thread this one was forked from. */
	forkedFrom?: string;
	/** Helper runs (Claude subagents, Codex guardian reviews). Skipped by default. */
	isSubagent: boolean;
	/** Sidebar section in the app (group/project, and parent session if nested): the subfolder. */
	section?: string;
	/** Which login made this session: claude.ai organization or ChatGPT workspace ID, if known. */
	ownerId?: string;
	turns: DesktopTurn[];
	/** Images and files you attached, files the assistant wrote or sent you. */
	files?: SessionFile[];
	/** Claude: artifacts and Claude Docs it published on claude.ai. */
	links?: SessionLink[];
}

/** What we remember per desktop session in data.json (no secrets, no chat text). */
export interface DesktopIndexEntry {
	/** Last activity in the session (ISO) when it was last written. */
	updated: string;
	/** Source file size and modification time, to skip unchanged files without reading them. */
	size: number;
	mtime: number;
	source: string;
	md: string;
	/** Copy of the source .jsonl, when "Keep the raw session file" is on. */
	raw?: string;
	synced: string;
	/** Saved files of this session: file key (see session-files.ts) -> vault path. */
	files?: Record<string, string>;
	/** Session version ("updated") whose files were last saved, so older syncs get them once. */
	filesChecked?: string;
}

export interface DesktopAppSettings {
	enabled: boolean;
	folder: string;
	/** Folder for the raw .jsonl copies ("Keep the raw session file"). Empty = next to the transcripts. */
	rawFolder?: string;
	/** Extra folders with session .jsonl files (one per entry). The app's own folder is always scanned. */
	extraFolders: string[];
	index: Record<string, DesktopIndexEntry>;
	/** Source files with no message from you, by lower-case path -> mtime, so they are not re-read every run. */
	ignored?: Record<string, number>;
	/** Claude: last sidebar groups read (app session ID -> group), used while the app's storage is unreadable. */
	groupCache?: Record<string, string>;
}

/** How sessions are saved, the same for every account. */
export interface DesktopSettings {
	/** Put each session in a subfolder named after the folder it ran in. */
	projectSubfolders: boolean;
	/** Also copy the source .jsonl, next to the transcript or into the account's raw folder. */
	keepRaw: boolean;
	/** Leave sessions alone until they have been quiet this long (they are still being written). */
	quietMinutes: number;
	/** Include helper runs (subagents, guardian reviews). */
	includeSubagents: boolean;
	/** Claude Code and Codex: also save attached images and files, and the files the assistant made (Attachments/ and Artifacts/ next to the transcript). */
	saveFiles: boolean;
}
