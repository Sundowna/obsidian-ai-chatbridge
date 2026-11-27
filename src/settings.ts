// The settings model. Everything here is saved in data.json, which syncs with the vault.
// So: NO secrets. Logins live in the login windows' own storage; the fallback session
// keys (claude.ai, ChatGPT, Google) live in Obsidian's secret storage – we only store the *name*
// of that secret (secretId).

import { DEFAULT_MAX_AGE_HOURS } from './remote/protocol';
import { normalizePath } from 'obsidian';
import { layoutFolders } from './desktop/layout';
import type { IndexEntry } from './types';
import type { AssetRetry, Capture } from './chatgpt/recovery';
import type { Inventories } from './chatgpt/inventory';
import type { ChatCounts } from './progress';
import type { LoginMethod } from './link/account';
import type { DesktopAppSettings, DesktopSettings } from './desktop/types';
import type { ProjectCatalog } from './project-catalog';
import type { HermesSettings } from './hermes/types';
import type { MemorySettings } from './memory/types';
import type { LastAll, LastRun } from './last-run';
import type { EditedPolicy } from './versions';
import type { PasteMode } from './files';
import type { NoteState } from './types';
import type { ListCatalog } from './quick-list';

/** A usable vault folder path, or null (empty, root, or inside a hidden folder like .obsidian). */
export function cleanFolder(v: string): string | null {
	const p = normalizePath(v.trim());
	if (!p || p === '/' || p.split('/').some((part) => part.startsWith('.'))) return null;
	return p;
}

/** One claude.ai login: where its chats go and what has been synced. */
export interface ClaudeWebSettings {
	/** Login window (missing) or the Browser link (your own browser, through the extension). */
	loginMethod?: LoginMethod;
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
	/** Put Claude's reasoning into the note, folded. Missing = off; it is always in the raw file. */
	showReasoning?: boolean;
	/** Pasted text longer than 5 lines (issue #64): "file" = saved file, linked with a 5-line preview; "note" = all of it in the note. Missing = "file". */
	pastedText?: PasteMode;
	/** Also read claude.ai's archived chats (a list of their own). Missing = off. */
	includeArchived?: boolean;
	separateArchived?: boolean;
	/** Archive folders awaiting empty-folder cleanup on this computer. */
	archiveCleanup?: string[];
	/** The chat list as last read on this computer, so a sync reads only its recent part (quick-list.ts). */
	listCatalog?: ListCatalog;
	/** Rate-limit pause (rate-limit.ts): when claude.ai allows requests again, and the waiting retry. */
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number } | null;
	index: Record<string, IndexEntry>;
	/** file_uuid -> vault path, so each file is downloaded once. */
	fileIndex: Record<string, string>;
	/** Also save the Claude Code sessions run in the cloud (claude.ai/code) into the Code Cloud folder. */
	cloudSessions: boolean;
	/** Claude Code cloud session ID ("cse_…") -> what was saved. */
	cloudIndex?: Record<string, CloudIndexEntry>;
}

/** What we remember per cloud session: Claude Code (claude.ai/code) or Codex (chatgpt.com/codex). No chat text. */
export interface CloudIndexEntry extends NoteState {
	/** The session's last_event_at (Codex: the task's updated_at) when it was saved. */
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
	/** Login window (missing) or the Browser link (your own browser, through the extension). */
	loginMethod?: LoginMethod;
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
	separateArchived?: boolean;
	/** Archive folders awaiting empty-folder cleanup on this computer. */
	archiveCleanup?: string[];
	/** Put ChatGPT's reasoning into the note, folded. Missing = off; it is always in the raw file. */
	showReasoning?: boolean;
	/** Pinned chats sit in lists of their own (issue #32). Missing = on. */
	includePinned?: boolean;
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number; forceFull: boolean } | null;
	assetRetries?: Record<string, AssetRetry>;
	pendingCaptures?: Record<string, Capture>;
	inventories?: Inventories;
	overlapMinutes?: number;
	chatProgress?: ChatCounts & { inventoryKey: string; scope: string };
	/** Also save the Codex tasks run in the cloud (chatgpt.com/codex) into the Codex Cloud folder. */
	codexCloud: boolean;
	/** Folder for Codex cloud tasks (subfolders Tasks = started on chatgpt.com/codex, Work = started from ChatGPT). */
	codexCloudFolder: string;
	/** Folder for their raw .json. Empty = next to the transcripts. */
	codexCloudRawFolder?: string;
	/** Keep every step (commands, tool calls, file edits) in the raw .json. Off = the conversation only. */
	codexCloudSteps?: boolean;
	/** Codex cloud thread ID (a UUID) -> what was saved. */
	codexCloudIndex?: Record<string, CloudIndexEntry>;
}

/** One Lumo login: its folders and what has been synced. No keys: those exist only during a sync. */
export interface LumoSettings {
	folder: string;
	/** Lumo's reasoning in the notes, folded. Missing = on (as before the switch); always in the raw file. */
	showReasoning?: boolean;
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
	/** Also save the chats' files: your uploads to Attachments/, what Lumo made to Artifacts/. */
	downloadFiles: boolean;
	/** Rate-limit pause (rate-limit.ts). */
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number } | null;
	index: Record<string, IndexEntry>;
	/** File key (see lumo/assets.ts) -> vault path, so each file is fetched once. */
	fileIndex: Record<string, string>;
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
	/** Rate-limit pause (rate-limit.ts). */
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number } | null;
	index: Record<string, IndexEntry>;
	/** The chat list as last read on this computer (quick-list.ts). */
	listCatalog?: ListCatalog;
	/** The Google account behind this login (its email, not secret), to notice the same login twice. */
	userId?: string;
	/** Login window (missing) or the Browser link (your own browser, through the extension). */
	loginMethod?: LoginMethod;
	/** Gemini's reasoning and AI Studio's thinking in the notes, folded. Missing = on (as before the switch); always in the raw file. */
	showReasoning?: boolean;
	/** Save the pictures Gemini made beside the chat (Attachments/<chat>/). Missing = on. */
	downloadFiles?: boolean;
}

/** The same login's Google AI Studio prompts, which AI Studio keeps in Google Drive. */
export interface StudioSettings {
	enabled: boolean;
	folder: string;
	/** Folder for the raw .json files. Empty = next to the transcripts. */
	rawFolder?: string;
	/** Rate-limit pause (rate-limit.ts); AI Studio has its own, apart from Gemini's. */
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number } | null;
	index: Record<string, IndexEntry>;
	/** The library list as last read on this computer (quick-list.ts). */
	listCatalog?: ListCatalog;
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
	/** A chat continues and you edited its note: keep your version as a copy, leave the note, or overwrite. */
	editedNotes: EditedPolicy;
	/** Always at least one. The first account also receives desktop sessions no account claims. */
	claude: ClaudeAccount[];
	chatgpt: ChatgptAccount[];
	lumo: LumoAccount[];
	gemini: GeminiAccount[];
	/** How desktop sessions are saved, for every account. */
	desktop: DesktopSettings;
	/** Hermes Agent chats, read from each profile's state.db (desktop only). */
	hermes: HermesSettings;
	/** AI memory snapshots: what each AI keeps about you (desktop only for the local sources). */
	memory: MemorySettings;
	/** Asking another device to sync through files in the vault (see remote/protocol.ts). */
	remote: RemoteSettings;
	/** Keeping the vault's Active Context note up to date (see handoff/). */
	handoff: HandoffSettings;
	/** What the last sync of each account surface did (see last-run.ts). */
	lastRuns: Record<string, LastRun>;
	/** The last "Sync all". */
	lastAll?: LastAll;
	/** The Browser link's port on 127.0.0.1, kept so a paired extension finds it again (not a secret). */
	browserLinkPort?: number;
	/** System file renames done in this vault (see system-names.ts). */
	systemNames?: number;
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
	// Off until you turn it on: it opens a second connection to chatgpt.com (Codex's own).
	codexCloud: false,
	codexCloudFolder: FIRST.codexCloud,
};

export const DEFAULT_LUMO: LumoSettings = {
	folder: FIRST.lumoChat,
	projectSubfolders: true,
	recentFolderName: 'Recent',
	downloadFiles: true,
	onlyProjects: false,
	projects: [],
	index: {},
	fileIndex: {},
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

/** Every source is off until you turn it on. */
export const DEFAULT_MEMORY: MemorySettings = {
	folder: 'AI Memory',
	intervalMinutes: 0,
	redact: true,
	claudeWeb: {},
	chatgptWeb: {},
	lumoWeb: {},
	codexLocal: false,
	claudeCodeLocal: false,
	states: {},
};

export interface RemoteSettings {
	/** Where sync-request.json and sync-status.json live. Both devices must name the same folder. */
	folder: string;
	/** A request older than this when the computer sees it is not run. */
	maxAgeHours: number;
}

/** Active Context upkeep: Live sessions after each sync, the 7-day archive pass and stale "Now" lines once a day. */
export interface HandoffSettings {
	enabled: boolean;
	/** Folder of the handoff: holds "Active Context.md" and the "Handoff archive" folder. */
	folder: string;
	/** Live sessions: chats active in the last this many hours. */
	liveHours: number;
	/** "Recently done" keeps this many days; older entries move to the archive. */
	keepDays: number;
	/** A "Now" line still there after this many days is flagged under the "Waiting for …" section (0 = never). */
	staleDays: number;
	/** Day (YYYY-MM-DD) the daily pass last ran. */
	lastDaily?: string;
	/** "Now" lines seen so far: line key -> first day seen. */
	nowSeen: Record<string, { first: string; flagged?: boolean }>;
}

export const HANDOFF_NOTE = 'Active Context.md';
export const HANDOFF_ARCHIVE = 'Handoff archive';
export const handoffNote = (h: Pick<HandoffSettings, 'folder'>): string => normalizePath(`${h.folder}/${HANDOFF_NOTE}`);
export const handoffArchive = (h: Pick<HandoffSettings, 'folder'>): string => normalizePath(`${h.folder}/${HANDOFF_ARCHIVE}`);

export const DEFAULT_HANDOFF: HandoffSettings = {
	enabled: false,
	folder: '_AI Handoff',
	liveHours: 48,
	keepDays: 7,
	staleDays: 3,
	nowSeen: {},
};

export const DEFAULT_REMOTE: RemoteSettings = {
	folder: '00 Inbox/Mobile/ChatBridge',
	maxAgeHours: DEFAULT_MAX_AGE_HOURS,
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
	logPath: 'AI Chats/_ai-chatbridge-log.md',
	rawRootOn: true,
	rawRoot: '80 Archive/raw',
	editedNotes: 'copy',
	claude: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_CLAUDE_WEB, desktop: desktopApp(FIRST.claudeCodeLocal) }],
	chatgpt: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_GPT, desktop: desktopApp(FIRST.codexLocal) }],
	lumo: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_LUMO }],
	gemini: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: DEFAULT_GEMINI, studio: DEFAULT_STUDIO }],
	desktop: DEFAULT_DESKTOP,
	hermes: DEFAULT_HERMES,
	memory: DEFAULT_MEMORY,
	remote: DEFAULT_REMOTE,
	handoff: DEFAULT_HANDOFF,
	lastRuns: {},
};

export const MIN_DELAY_SECONDS = 1;
export const MIN_INTERVAL_MINUTES = 30;
