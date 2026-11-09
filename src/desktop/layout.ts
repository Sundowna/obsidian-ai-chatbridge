// The "app layout": one folder per desktop app, with Chat and Code inside, like the apps.
//
//   <root>/Claude Desktop/Chat   claude.ai chats   (Recent/, <project>/)
//   <root>/Claude Desktop/Code   Claude Code       (<sidebar group or working folder>/)
//   <root>/ChatGPT Desktop/Chat  ChatGPT chats     (Recent/, <project>/)
//   <root>/ChatGPT Desktop/Codex Codex threads     (Recent/, <project>/)
//
// Only the first account of each provider: accounts added later start out in their own
// "Claude Desktop (<name>)" folders.
//
// moveToAppLayout moves already-synced folders there with Obsidian's own rename, so links
// and the plugin's indexes follow (see follow.ts). Nothing is deleted except source
// folders left empty by the move.

import { normalizePath, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { followRename } from '../follow';
import { DEFAULT_ACCOUNT_ID, type Settings } from '../settings';

export const CLAUDE_APP = 'Claude Desktop';
export const CHATGPT_APP = 'ChatGPT Desktop';

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const join = (root: string, rest: string) => (root ? `${root}/${rest}` : rest);

/** The folder holding the app folders: next to the Claude Chat folder (or above it, if already in the layout). */
export function layoutRoot(chatFolder: string): string {
	const parent = parentOf(chatFolder);
	// "Claude Desktop (Work)" is an added account's app folder.
	const last = parent.split('/').pop() ?? '';
	return last === CLAUDE_APP || last.startsWith(`${CLAUDE_APP} (`) ? parentOf(parent) : parent;
}

export interface LayoutMove {
	label: string;
	from: string;
	to: string;
	set: (s: Settings, path: string) => void;
}

/**
 * What to move. Besides each folder setting, the older default folder names next to the app
 * folders count too while they still exist: a setting may already point at the new folder
 * (changed by hand) with the synced chats still sitting in the old one.
 */
export function layoutMoves(s: Settings, exists: (path: string) => boolean = () => false): LayoutMove[] {
	// Only the original account can sit in the old flat folders; it may have been removed.
	const claude = s.claude.find((a) => a.id === DEFAULT_ACCOUNT_ID);
	const chatgpt = s.chatgpt.find((a) => a.id === DEFAULT_ACCOUNT_ID);
	const root = layoutRoot(s.claude[0]!.web.chatFolder);
	const targets: { label: string; setting: string; legacy: string[]; to: string; set: LayoutMove['set'] }[] = [
		...(claude ? [
		{ label: 'claude.ai chats', setting: claude.web.chatFolder, legacy: ['Claude Chat', 'Claude'], to: `${CLAUDE_APP}/Chat`, set: (_s: Settings, p: string) => (claude.web.chatFolder = p) },
		{ label: 'Claude Code chats listed on claude.ai', setting: claude.web.codeFolder, legacy: ['Claude Code'], to: `${CLAUDE_APP}/Code`, set: (_s: Settings, p: string) => (claude.web.codeFolder = p) },
		{ label: 'Claude desktop Code sessions', setting: claude.desktop.folder, legacy: [], to: `${CLAUDE_APP}/Code`, set: (_s: Settings, p: string) => (claude.desktop.folder = p) },
		] : []),
		...(chatgpt ? [
		{ label: 'ChatGPT chats', setting: chatgpt.web.folder, legacy: ['ChatGPT Chat', 'ChatGPT'], to: `${CHATGPT_APP}/Chat`, set: (_s: Settings, p: string) => (chatgpt.web.folder = p) },
		{ label: 'Codex threads', setting: chatgpt.desktop.folder, legacy: ['Codex'], to: `${CHATGPT_APP}/Codex`, set: (_s: Settings, p: string) => (chatgpt.desktop.folder = p) },
		] : []),
	];
	const out: LayoutMove[] = [];
	const seen = new Set<string>();
	for (const t of targets) {
		const to = join(root, t.to);
		const sources = [t.setting, ...t.legacy.map((name) => join(root, name)).filter(exists)];
		for (const from of sources) {
			const key = `${normalizePath(from)}>${normalizePath(to)}`;
			if (normalizePath(from) === normalizePath(to) || seen.has(key)) continue;
			seen.add(key);
			out.push({ label: t.label, from, to, set: t.set });
		}
	}
	return out;
}

export const folderExists = (app: App) => (path: string): boolean => app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;

export interface MoveResult {
	moved: number;
	conflicts: string[];
}

async function moveInto(app: App, s: Settings, src: TAbstractFile, destPath: string, r: MoveResult): Promise<void> {
	const dest = app.vault.getAbstractFileByPath(destPath);
	if (!dest) {
		const parent = parentOf(destPath);
		if (parent && !app.vault.getAbstractFileByPath(parent)) await app.vault.createFolder(parent);
		const oldPath = src.path;
		await app.fileManager.renameFile(src, destPath);
		followRename(s, oldPath, destPath); // also done by the rename event; repeating it changes nothing
		r.moved++;
		return;
	}
	if (src instanceof TFolder && dest instanceof TFolder) {
		for (const child of [...src.children]) await moveInto(app, s, child, `${destPath}/${child.name}`, r);
		if (src.children.length === 0) await app.fileManager.trashFile(src);
		return;
	}
	// A file with the same name is already there: leave both alone.
	if (src instanceof TFile) r.conflicts.push(src.path);
}

/** Moves each synced folder into the app layout and points the settings there. */
export async function moveToAppLayout(app: App, s: Settings, save: () => Promise<void>): Promise<MoveResult> {
	const r: MoveResult = { moved: 0, conflicts: [] };
	for (const m of layoutMoves(s, folderExists(app))) {
		const src = app.vault.getAbstractFileByPath(normalizePath(m.from));
		// Nested: the old folder is inside the new one (or the other way round) – only switch the setting.
		const nested = m.to.startsWith(`${m.from}/`) || m.from.startsWith(`${m.to}/`);
		if (src instanceof TFolder && !nested) await moveInto(app, s, src, normalizePath(m.to), r);
		m.set(s, m.to);
		await save();
	}
	return r;
}
