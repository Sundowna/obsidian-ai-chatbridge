// The settings model. Everything here is saved in data.json, which syncs with the vault.
// So: NO secrets. Logins live in the login windows' own storage; the fallback session
// keys (claude.ai, ChatGPT, Google) live in Obsidian's secret storage – we only store the *name*
// of that secret (secretId).

import { normalizePath } from 'obsidian';
import { layoutFolders } from './desktop/layout';
import type { IndexEntry } from './types';
import type { AssetRetry, Capture } from './chatgpt/recovery';
import type { Inventories } from './chatgpt/inventory';
import type { ChatCounts } from './progress';
import type { DesktopAppSettings, DesktopSettings } from './desktop/types';
import type { ProjectCatalog } from './project-catalog';
import type { HermesSettings } from './hermes/types';
import type { LastAll, LastRun } from './last-run';

/** A usable vault folder path, or null (empty, root, or inside a hidden folder like .obsidian). */
export function cleanFolder(v: string): string | null {
	const p = normalizePath(v.trim());
	if (!p || p === '/' || p.split('/').some((part) => part.startsWith('.'))) return null;
	return p;
}

/** One claude.ai login: where its chats go and what has been synced. */
export interface ClaudeWebSettings {
	orgId: string;
	/** The organization the login window reported last, to notice a different login. Not secret. */
	loginOrg?: string;
	secretId: string;
	onlyProjects: boolean;
	projects: string[];
	projectCatalog?: ProjectCatalog;
	/** With onlyProjects: let a selected project use a folder of its own (projectFolders). */
	customProjectFolders?: boolean;
	/** Picker row ID (project ID, or ":no-project") -> vault folder. Missing = the default folder. */
	projectFolders?: Record<string, string>;
	/** Picker row ID -> folder for that project's raw .json files. Missing = the default (see raw-folders.ts). */
	projectRawFolders?: Record<string, string>;
	/** Folder for normal claude.ai chats (platform CLAUDE_AI). */
	chatFolder: string;
	/** Folder for Claude Code sessions (any other platform). */
	codeFolder: string;
	/** Folder for the raw .json of normal chats. Empty = next to the transcripts. */
	chatRawFolder?: string;
	/** Folder for the raw .json of Claude Code sessions. Empty = next to the transcripts. */
	codeRawFolder?: string;
	/** Put each chat in a subfolder named after its claude.ai project. */
	projectSubfolders: boolean;
	/** Subfolder for chats without a project (claude.ai's "Recents"). */
	recentFolderName: string;
	/** Also download the files listed in a chat (Artifacts/ and Attachments/ next to the chat). */
	downloadFiles: boolean;
	index: Record<string, IndexEntry>;
	/** file_uuid -> vault path, so each file is downloaded once. */
	fileIndex: Record<string, string>;
	/** Also save the Claude Code sessions run in the cloud (claude.ai/code) into the Code Cloud folder. */
	cloudSessions: boolean;
	/** Claude Code cloud session ID ("cse_…") -> what was saved. */
	cloudIndex?: Record<string, CloudIndexEntry>;
}

/** What we remember per Claude Code cloud session (no chat text). */
export interface CloudIndexEntry {
	/** The session's last_event_at when it was saved. */
	updated: string;
	/** Empty for a session with no message from you (nothing written, not asked again until it changes). */
	md: string;
	json: string;
	synced: string;
	/** Saved files: file key -> vault path. */
	files?: Record<string, string>;
}

/** One ChatGPT login: its own folders, index and cooldown. */
export interface GptSettings {
	folder: string;
	/** Folder for the raw .json files. Empty = next to the transcripts. */
	rawFolder?: string;
	/** Name of the secret holding a pasted session cookie, used when the login window has none. */
	secretId: string;
	projectSubfolders: boolean;
	recentFolderName: string;
	downloadFiles: boolean;
	onlyProjects: boolean;
	projects: string[];
	projectCatalog?: ProjectCatalog;
	/** With onlyProjects: let a selected project use a folder of its own (projectFolders). */
	customProjectFolders?: boolean;
	/** Picker row ID (project ID, or ":no-project") -> vault folder. Missing = the default folder. */
	projectFolders?: Record<string, string>;
	/** Picker row ID -> folder for that project's raw .json files. Missing = the default (see raw-folders.ts). */
	projectRawFolders?: Record<string, string>;
	index: Record<string, IndexEntry>;
	fileIndex: Record<string, string>;
	/** The workspace the login belongs to (not secret); matches Codex sessions to this account. */
	workspaceId?: string;
	includeArchived?: boolean;
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number; forceFull: boolean } | null;
	assetRetries?: Record<string, AssetRetry>;
	pendingCaptures?: Record<string, Capture>;
	inventories?: Inventories;
	overlapMinutes?: number;
	chatProgress?: ChatCounts & { inventoryKey: string; scope: string };
}

/** One Lumo login: its folders and what has been synced. No keys: those exist only during a sync. */
export interface LumoSettings {
	folder: string;
	/** Folder for the raw .json files. Empty = next to the transcripts. */
	rawFolder?: string;
	projectSubfolders: boolean;
	recentFolderName: string;
	onlyProjects: boolean;
	projects: string[];
	projectCatalog?: ProjectCatalog;
	/** With onlyProjects: let a selected project use a folder of its own (projectFolders). */
	customProjectFolders?: boolean;
	/** Picker row ID (project ID, or ":no-project") -> vault folder. Missing = the default folder. */
	projectFolders?: Record<string, string>;
	/** Picker row ID -> folder for that project's raw .json files. Missing = the default (see raw-folders.ts). */
	projectRawFolders?: Record<string, string>;
	index: Record<string, IndexEntry>;
	/** The Proton account behind this login (not secret), to notice the same login twice. */
	userId?: string;
}

/** One Google login's Gemini chats (gemini.google.com). No tokens: those exist only during a sync. */
export interface GeminiSettings {
	folder: string;
	/** Folder for the raw .json files. Empty = next to the transcripts. */
	rawFolder?: string;
	/** Name of the secret holding pasted Google cookies (Gemini and AI Studio), used when the login window has none. */
	secretId: string;
	index: Record<string, IndexEntry>;
	/** The Google account behind this login (its email, not secret), to notice the same login twice. */
	userId?: string;
}

/** The same login's Google AI Studio prompts, which AI Studio keeps in Google Drive. */
export interface StudioSettings {
	enabled: boolean;
	folder: string;
	/** Folder for the raw .json files. Empty = next to the transcripts. */
	rawFolder?: string;
	index: Record<string, IndexEntry>;
}

/** One person's login at a provider, with its two surfaces: the website and the desktop app. */
export interface ClaudeAccount {
	id: string;
	label: string;
	web: ClaudeWebSettings;
	desktop: DesktopAppSettings;
}

export interface ChatgptAccount {
	id: string;
	label: string;
	web: GptSettings;
	desktop: DesktopAppSettings;
}

/** Lumo is a website only, so its accounts have no desktop side. */
export interface LumoAccount {
	id: string;
	label: string;
	web: LumoSettings;
}

/** One Google login, used for both Gemini and Google AI Studio. */
export interface GeminiAccount {
	id: string;
	label: string;
	web: GeminiSettings;
	studio: StudioSettings;
}

export interface Settings {
	maxChatsPerRun: number;
	delaySeconds: number;
	intervalMinutes: number;
	/** Runs "Sync all" once, shortly after Obsidian has started. */
	syncOnStartup: boolean;
	logPath: string;
	/**
	 * One folder for all raw files (.json, .jsonl): each goes to this folder plus its transcript
	 * folder's own path. While on, the per-account and per-project JSON folders are not used.
	 */
	rawRootOn: boolean;
	/** That folder; empty = next to the transcripts. */
	rawRoot: string;
	/** Always at least one. The first account also receives desktop sessions no account claims. */
	claude: ClaudeAccount[];
	chatgpt: ChatgptAccount[];
	lumo: LumoAccount[];
	gemini: GeminiAccount[];
	/** How desktop sessions are saved, for every account. */
	desktop: DesktopSettings;
	/** Hermes Agent chats, read from each profile's state.db (desktop only). */
	hermes: HermesSettings;
	/** What the last sync of each account surface did (see last-run.ts). */
	lastRuns: Record<string, LastRun>;
	/** The last "Sync all". */
	lastAll?: LastAll;
}

/** Where a new vault's chats go: the layout below "AI Chats" (see desktop/layout.ts). */
const FIRST = layoutFolders('AI Chats');

export const DEFAULT_CLAUDE_WEB: ClaudeWebSettings = {
	orgId: '',
	secretId: '',
	onlyProjects: false,
	projects: [],
	chatFolder: FIRST.claudeChat,
	codeFolder: FIRST.claudeCodeCloud,
	projectSubfolders: true,
	recentFolderName: 'Recent',
	downloadFiles: true,
	index: {},
	fileIndex: {},
	cloudSessions: true,
};

export const DEFAULT_GPT: GptSettings = {
	folder: FIRST.chatgptChat,
	secretId: '',
	projectSubfolders: true,
	recentFolderName: 'Recent',
	downloadFiles: true,
	onlyProjects: false,
	projects: [],
	index: {},
	fileIndex: {},
};

export const DEFAULT_LUMO: LumoSettings = {
	folder: FIRST.lumoChat,
	projectSubfolders: true,
	recentFolderName: 'Recent',
	onlyProjects: false,
	projects: [],
	index: {},
};

export const DEFAULT_GEMINI: GeminiSettings = {
	folder: FIRST.geminiChat,
	secretId: '',
	index: {},
};

export const DEFAULT_STUDIO: StudioSettings = {
	enabled: true,
	folder: FIRST.studio,
	index: {},
};

export const desktopApp = (folder: string): DesktopAppSettings => ({ enabled: true, folder, extraFolders: [], index: {} });

export const DEFAULT_HERMES: HermesSettings = {
	folder: 'AI Chats/Hermes',
	profiles: [],
	pythonPath: '',
};

export const DEFAULT_DESKTOP: DesktopSettings = {
	projectSubfolders: true,
	keepRaw: false,
	quietMinutes: 15,
	includeSubagents: false,
	saveFiles: true,
};

/** The account a vault had before there could be several. Its login window keeps working. */
export const DEFAULT_ACCOUNT_ID = 'default';
export const DEFAULT_ACCOUNT_LABEL = 'Main';

export const DEFAULT_SETTINGS: Settings = {
	maxChatsPerRun: 3,
	delaySeconds: 1.5,
	intervalMinutes: 0,
	syncOnStartup: false,
	logPath: 'AI Chats/AI ChatBridge log.md',
	rawRootOn: true,
	rawRoot: '80 Archive/raw',
	claude: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_CLAUDE_WEB, desktop: desktopApp(FIRST.claudeCodeLocal) }],
	chatgpt: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_GPT, desktop: desktopApp(FIRST.codexLocal) }],
	lumo: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_LUMO }],
	gemini: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_GEMINI, studio: DEFAULT_STUDIO }],
	desktop: DEFAULT_DESKTOP,
	hermes: DEFAULT_HERMES,
	lastRuns: {},
};

export const MIN_DELAY_SECONDS = 1;
export const MIN_INTERVAL_MINUTES = 30;
