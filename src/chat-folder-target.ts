import type { ProjectCatalog } from './project-catalog';
import type { RawFolderOptions } from './raw-folders';
import type { Settings } from './settings';
import type { NoteState } from './types';

export type ChatFolderTarget = { kind: 'hermes' } | {
	kind: 'claude' | 'claude-cloud' | 'claude-local' | 'chatgpt' | 'codex-cloud' | 'codex-local' | 'lumo' | 'gemini' | 'studio';
	id: string;
};

export interface ChatFolderEntry extends NoteState {
	md: string;
	json?: string;
	raw?: string;
	view?: string;
	older?: string[];
}

type ProjectFolders = RawFolderOptions & { recentFolderName: string; projectCatalog?: ProjectCatalog };

export interface ChatFolderStorage {
	folder: string;
	setFolder(path: string): void;
	rawFolder?: string;
	entries(): ChatFolderEntry[];
	projects?: ProjectFolders;
	pending?: Record<string, ChatFolderEntry>;
	/** Claude Web uses one index for chats routed to either of two folders. */
	otherClaudeFolder?: string;
	cloudEntries?: () => ChatFolderEntry[];
}

function indexedFolder(config: { folder: string; rawFolder?: string; index: Record<string, ChatFolderEntry> }): ChatFolderStorage {
	return {
		folder: config.folder,
		setFolder: (path) => { config.folder = path; },
		rawFolder: config.rawFolder,
		entries: () => Object.values(config.index),
	};
}

/** Resolve a settings field and its current index after acquiring the sync lock. */
export function chatFolderStorage(s: Settings, target: ChatFolderTarget): ChatFolderStorage | undefined {
	switch (target.kind) {
		case 'claude':
		case 'claude-cloud':
		case 'claude-local': {
			const account = s.claude.find(({ id }) => id === target.id);
			if (!account) return;
			if (target.kind === 'claude-local') return indexedFolder(account.desktop);
			const web = account.web;
			const cloud = target.kind === 'claude-cloud';
			return {
				folder: cloud ? web.codeFolder : web.chatFolder,
				setFolder: (path) => { web[cloud ? 'codeFolder' : 'chatFolder'] = path; },
				rawFolder: cloud ? web.codeRawFolder : web.chatRawFolder,
				entries: () => Object.values(web.index),
				projects: web,
				otherClaudeFolder: cloud ? web.chatFolder : web.codeFolder,
				cloudEntries: cloud ? () => Object.values(web.cloudIndex ?? {}) : undefined,
			};
		}
		case 'chatgpt':
		case 'codex-cloud':
		case 'codex-local': {
			const account = s.chatgpt.find(({ id }) => id === target.id);
			if (!account) return;
			if (target.kind === 'codex-local') return indexedFolder(account.desktop);
			const web = account.web;
			if (target.kind === 'chatgpt') return { ...indexedFolder(web), projects: web, pending: web.pendingCaptures };
			return {
				folder: web.codexCloudFolder,
				setFolder: (path) => { web.codexCloudFolder = path; },
				rawFolder: web.codexCloudRawFolder,
				entries: () => Object.values(web.codexCloudIndex ?? {}),
			};
		}
		case 'lumo': {
			const web = s.lumo.find(({ id }) => id === target.id)?.web;
			if (web) return { ...indexedFolder(web), projects: web };
			return;
		}
		case 'gemini':
		case 'studio': {
			const account = s.gemini.find(({ id }) => id === target.id);
			if (account) return indexedFolder(target.kind === 'gemini' ? account.web : account.studio);
			return;
		}
		case 'hermes': {
			const hermes = s.hermes;
			return {
				folder: hermes.folder,
				setFolder: (path) => { hermes.folder = path; },
				entries: () => hermes.profiles.flatMap(({ index }) => Object.values(index)),
			};
		}
	}
}
