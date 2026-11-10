// The settings model. Everything here is saved in data.json, which syncs with the vault.
// So: NO secrets. Logins live in the login windows' own storage; the fallback session
// keys (claude.ai, ChatGPT) live in Obsidian's secret storage – we only store the *name*
// of that secret (secretId).

import { normalizePath } from 'obsidian';
import type { IndexEntry } from './types';
import type { AssetRetry, Capture } from './chatgpt/recovery';
import type { Inventories } from './chatgpt/inventory';
import type { ChatCounts } from './progress';
import type { DesktopAppSettings, DesktopSettings } from './desktop/types';
import type { ProjectCatalog } from './project-catalog';

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
	/** Folder for normal claude.ai chats (platform CLAUDE_AI). */
	chatFolder: string;
	/** Folder for Claude Code sessions (any other platform). */
	codeFolder: string;
	/** Put each chat in a subfolder named after its claude.ai project. */
	projectSubfolders: boolean;
	/** Subfolder for chats without a project (claude.ai's "Recents"). */
	recentFolderName: string;
	/** Also download the files listed in a chat (Artifacts/ and Attachments/ next to the chat). */
	downloadFiles: boolean;
	index: Record<string, IndexEntry>;
	/** file_uuid -> vault path, so each file is downloaded once. */
	fileIndex: Record<string, string>;
}

/** One ChatGPT login: its own folders, index and cooldown. */
export interface GptSettings {
	folder: string;
	/** Name of the secret holding a pasted session cookie, used when the login window has none. */
	secretId: string;
	projectSubfolders: boolean;
	recentFolderName: string;
	downloadFiles: boolean;
	onlyProjects: boolean;
	projects: string[];
	projectCatalog?: ProjectCatalog;
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
	projectSubfolders: boolean;
	recentFolderName: string;
	onlyProjects: boolean;
	projects: string[];
	projectCatalog?: ProjectCatalog;
	index: Record<string, IndexEntry>;
	/** The Proton account behind this login (not secret), to notice the same login twice. */
	userId?: string;
}

/** One Google login's Gemini chats (gemini.google.com). No tokens: those exist only during a sync. */
export interface GeminiSettings {
	folder: string;
	index: Record<string, IndexEntry>;
	/** The Google account behind this login (its email, not secret), to notice the same login twice. */
	userId?: string;
}

/** The same login's Google AI Studio prompts, which AI Studio keeps in Google Drive. */
export interface StudioSettings {
	enabled: boolean;
	folder: string;
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
	logPath: string;
	/** Always at least one. The first account also receives desktop sessions no account claims. */
	claude: ClaudeAccount[];
	chatgpt: ChatgptAccount[];
	lumo: LumoAccount[];
	gemini: GeminiAccount[];
	/** How desktop sessions are saved, for every account. */
	desktop: DesktopSettings;
}

export const DEFAULT_CLAUDE_WEB: ClaudeWebSettings = {
	orgId: '',
	secretId: '',
	onlyProjects: false,
	projects: [],
	chatFolder: 'AI Chats/Claude Desktop/Chat',
	codeFolder: 'AI Chats/Claude Desktop/Code',
	projectSubfolders: true,
	recentFolderName: 'Recent',
	downloadFiles: true,
	index: {},
	fileIndex: {},
};

export const DEFAULT_GPT: GptSettings = {
	folder: 'AI Chats/ChatGPT Desktop/Chat',
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
	folder: 'AI Chats/Lumo/Chat',
	projectSubfolders: true,
	recentFolderName: 'Recent',
	onlyProjects: false,
	projects: [],
	index: {},
};

export const DEFAULT_GEMINI: GeminiSettings = {
	folder: 'AI Chats/Gemini/Chat',
	index: {},
};

export const DEFAULT_STUDIO: StudioSettings = {
	enabled: true,
	folder: 'AI Chats/Gemini/AI Studio',
	index: {},
};

export const desktopApp = (folder: string): DesktopAppSettings => ({ enabled: true, folder, extraFolders: [], index: {} });

export const DEFAULT_DESKTOP: DesktopSettings = {
	projectSubfolders: true,
	keepRaw: false,
	quietMinutes: 15,
	includeSubagents: false,
};

/** The account a vault had before there could be several. Its login window keeps working. */
export const DEFAULT_ACCOUNT_ID = 'default';
export const DEFAULT_ACCOUNT_LABEL = 'Main';

export const DEFAULT_SETTINGS: Settings = {
	maxChatsPerRun: 3,
	delaySeconds: 1.5,
	intervalMinutes: 0,
	logPath: 'AI Chats/AI ChatBridge log.md',
	claude: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_CLAUDE_WEB, desktop: desktopApp('AI Chats/Claude Desktop/Code') }],
	chatgpt: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_GPT, desktop: desktopApp('AI Chats/ChatGPT Desktop/Codex') }],
	lumo: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_LUMO }],
	gemini: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_GEMINI, studio: DEFAULT_STUDIO }],
	desktop: DEFAULT_DESKTOP,
};

export const MIN_DELAY_SECONDS = 1;
export const MIN_INTERVAL_MINUTES = 30;
