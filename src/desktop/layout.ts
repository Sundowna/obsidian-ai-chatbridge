// The "app layout": one folder per desktop app, with Chat and Code inside, like the apps.
//
//   <root>/Claude Desktop/Chat   claude.ai chats   (Recent/, <project>/)
//   <root>/Claude Desktop/Code   Claude Code       (<sidebar group or working folder>/)
//   <root>/ChatGPT Desktop/Chat  ChatGPT chats     (Recent/, <project>/)
//   <root>/ChatGPT Desktop/Codex Codex threads     (Recent/, <project>/)
//
// moveToAppLayout moves already-synced folders there with Obsidian's own rename, so links
// and the plugin's indexes follow (see follow.ts). Nothing is deleted except source
// folders left empty by the move.

import { normalizePath, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { followRename } from '../follow';
import type { Settings } from '../settings';

export const CLAUDE_APP = 'Claude Desktop';
export const CHATGPT_APP = 'ChatGPT Desktop';

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const join = (root: string, rest: string) => (root ? `${root}/${rest}` : rest);

/** The folder holding the app folders: next to the Claude Chat folder (or above it, if already in the layout). */
export function layoutRoot(chatFolder: string): string {
	const parent = parentOf(chatFolder);
	return parent.split('/').pop() === CLAUDE_APP ? parentOf(parent) : parent;
}

export interface LayoutMove {
	label: string;
	from: string;
	to: string;
	set: (s: Settings, path: string) => void;
}

export function layoutMoves(s: Settings): LayoutMove[] {
	const root = layoutRoot(s.chatFolder);
	const all: LayoutMove[] = [
		{ label: 'claude.ai chats', from: s.chatFolder, to: join(root, `${CLAUDE_APP}/Chat`), set: (x, p) => (x.chatFolder = p) },
		{ label: 'Claude Code chats listed on claude.ai', from: s.codeFolder, to: join(root, `${CLAUDE_APP}/Code`), set: (x, p) => (x.codeFolder = p) },
		{ label: 'Claude desktop Code sessions', from: s.desktop.claude.folder, to: join(root, `${CLAUDE_APP}/Code`), set: (x, p) => (x.desktop.claude.folder = p) },
		{ label: 'ChatGPT chats', from: s.gpt.folder, to: join(root, `${CHATGPT_APP}/Chat`), set: (x, p) => (x.gpt.folder = p) },
		{ label: 'Codex threads', from: s.desktop.codex.folder, to: join(root, `${CHATGPT_APP}/Codex`), set: (x, p) => (x.desktop.codex.folder = p) },
	];
	return all.filter((m) => normalizePath(m.from) !== normalizePath(m.to));
}

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
	for (const m of layoutMoves(s)) {
		const src = app.vault.getAbstractFileByPath(normalizePath(m.from));
		// Nested: the old folder is inside the new one (or the other way round) – only switch the setting.
		const nested = m.to.startsWith(`${m.from}/`) || m.from.startsWith(`${m.to}/`);
		if (src instanceof TFolder && !nested) await moveInto(app, s, src, normalizePath(m.to), r);
		m.set(s, m.to);
		await save();
	}
	return r;
}
