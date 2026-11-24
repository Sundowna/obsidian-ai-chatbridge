// System files (the plugin's own log, reports and diagnostics) start with "_" in lower case with
// dashes, so they are easy to leave out of the graph and searches: "_ai-chatbridge-log.md".
// Older versions named them "AI ChatBridge log.md" and so on; renameOldSystemFiles() renames
// them once, through Obsidian, so links follow. Chat notes and raw files are never touched.

import { normalizePath, Notice, TFile, TFolder, type App } from 'obsidian';
import type { Settings } from './settings';

/** Bumped when another rename is added; the settings remember the last one done. */
export const SYSTEM_NAMES_VERSION = 1;

export const LOG_NAME = '_ai-chatbridge-log.md';
export const OLD_LOG_NAME = 'AI ChatBridge log.md';
export const DIAGNOSTICS_FOLDER = 'AI Chats/_ai-chatbridge-diagnostics';
export const OLD_DIAGNOSTICS_FOLDER = 'AI Chats/AI ChatBridge diagnostics';

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir: string, name: string): string => normalizePath(dir ? `${dir}/${name}` : name);

/** "merge report" -> "merge-report". */
export const slug = (s: string): string =>
	s
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

/** A report's path without ".md": "<log folder>/_ai-chatbridge-merge-report-2026-11-20-1658". `stamp` is "2026-11-20 1658". */
export function reportBase(logPath: string, title: string, stamp: string): string {
	return join(dirOf(normalizePath(logPath)), `_ai-chatbridge-${slug(title)}-${stamp.replace(/ /g, '-')}`);
}

/** The n-th report of the same minute (n >= 2). */
export const numbered = (base: string, n: number): string => `${base}${n > 1 ? `-${n}` : ''}.md`;

const OLD_REPORT = /^AI ChatBridge (.+?) (\d{4}-\d\d-\d\d) (\d{4})(?: (\d+))?\.md$/;

/** The new name of an old report file name, or null when it is not one. */
export function newReportName(name: string): string | null {
	const m = OLD_REPORT.exec(name);
	if (!m || m[1] === 'log') return null;
	return `_ai-chatbridge-${slug(m[1]!)}-${m[2]}-${m[3]}${m[4] ? `-${m[4]}` : ''}.md`;
}

export interface Rename {
	from: string;
	to: string;
}

/**
 * What to rename, from what is in the vault. `exists` answers for files and folders.
 * `files` lists the file names in the log's folder. A target that is already taken is left out
 * and named in `blocked`.
 */
export function planRenames(logPath: string, logFolderFiles: string[], exists: (p: string) => boolean): { renames: Rename[]; blocked: Rename[]; logPath: string } {
	const renames: Rename[] = [];
	const blocked: Rename[] = [];
	const add = (from: string, to: string) => {
		if (!exists(from) || from === to) return;
		(exists(to) ? blocked : renames).push({ from, to });
	};
	const log = normalizePath(logPath);
	const dir = dirOf(log);
	let newLog = log;
	if ((log.split('/').pop() ?? '') === OLD_LOG_NAME) {
		newLog = join(dir, LOG_NAME);
		add(log, newLog);
		// Keep the old name when the new one is taken by something else: the log stays where it is.
		if (blocked.some((b) => b.from === log)) newLog = log;
	}
	for (const name of logFolderFiles) {
		const to = newReportName(name);
		if (to) add(join(dir, name), join(dir, to));
	}
	add(OLD_DIAGNOSTICS_FOLDER, DIAGNOSTICS_FOLDER);
	return { renames, blocked, logPath: newLog };
}

/** Once per vault, on the device that syncs: renames the old system files and tells you what moved. */
export async function renameOldSystemFiles(app: App, s: Settings): Promise<boolean> {
	if ((s.systemNames ?? 0) >= SYSTEM_NAMES_VERSION) return false;
	const vault = app.vault;
	const dir = dirOf(normalizePath(s.logPath));
	const folder = dir ? vault.getAbstractFileByPath(dir) : vault.getRoot();
	const names = folder instanceof TFolder ? folder.children.filter((c): c is TFile => c instanceof TFile).map((c) => c.name) : [];
	const plan = planRenames(s.logPath, names, (p) => vault.getAbstractFileByPath(normalizePath(p)) !== null);
	const done: Rename[] = [];
	const failed: Rename[] = [...plan.blocked];
	for (const r of plan.renames) {
		const file = vault.getAbstractFileByPath(r.from);
		try {
			if (file) await app.fileManager.renameFile(file, r.to);
			done.push(r);
		} catch {
			failed.push(r);
		}
	}
	// The log keeps its old name only if renaming it did not work.
	s.logPath = failed.some((f) => f.from === normalizePath(s.logPath)) ? s.logPath : plan.logPath;
	s.systemNames = SYSTEM_NAMES_VERSION;
	if (done.length || failed.length) {
		const lines = [`AI ChatBridge: system files now start with "_", so you can leave them out of the graph. Renamed ${done.length}.`];
		if (failed.length) lines.push(`Left as they are (the new name is taken or renaming failed): ${failed.map((f) => f.from).join(', ')}`);
		new Notice(lines.join('\n'), 15_000);
	}
	return true;
}
