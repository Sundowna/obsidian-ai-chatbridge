// Saving a list of Google chats (Gemini or AI Studio) into one folder: new and changed ones,
// plus ones whose files were deleted from the vault. Never overwrites a file.

import { TFile } from 'obsidian';
import { withAccount } from '../accounts';
import { appendLog } from '../log';
import type AIChatBridge from '../main';
import { baseName, dailyNoteName, localStamp } from '../naming';
import type { ProgressFn } from '../progress';
import { newestFirst, pickTodo, type Todo } from '../select';
import type { GeminiAccount } from '../settings';
import type { IndexEntry, ListItem } from '../types';
import { createNew, ensureFolder, freeStem } from '../vaultio';
import { rawLink } from '../raw-folders';

export interface GoogleSyncResult {
	listed: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	written: string[];
	restored: string[];
	/** Chats that could not be read and were left out. */
	failed: string[];
	stopped?: string;
}

export const emptyResult = (): GoogleSyncResult => ({ listed: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], failed: [] });

/** What one chat becomes: its file name's date, and the two files' contents. */
export interface Saved {
	createdAt: string;
	json: string;
	/** Gets the transcript's link to the raw .json: its file name, or its path when in another folder. */
	md: (jsonLink: string) => string;
}

export async function saveChats(
	plugin: AIChatBridge,
	items: ListItem[],
	index: Record<string, IndexEntry>,
	folder: string,
	/** Where the raw .json files go; the transcript folder when they have no folder of their own. */
	rawFolder: string,
	read: (item: ListItem) => Promise<Saved | null>,
	progress: ProgressFn,
	result: GoogleSyncResult,
): Promise<void> {
	const app = plugin.app;
	const exists = (path: string): boolean => app.vault.getAbstractFileByPath(path) instanceof TFile;
	const todo = pickTodo(items, index);
	const queued = new Set(todo.map((t) => t.item.uuid));
	const lost = (it: ListItem): boolean => {
		const known = index[it.uuid];
		return !!known && !queued.has(it.uuid) && (!exists(known.json) || !exists(known.md));
	};
	const recoveries: Todo[] = items.filter(lost).map((item) => ({ item, isUpdate: true }));
	result.listed = items.length;
	result.unchanged = items.length - todo.length - recoveries.length;
	const jobs = newestFirst([...todo, ...recoveries]);
	const max = plugin.settings.maxChatsPerRun;
	const batch = max > 0 ? jobs.slice(0, max) : jobs;
	result.leftForLater = jobs.length - batch.length;

	for (const [i, { item, isUpdate }] of batch.entries()) {
		progress(`${i + 1} of ${batch.length}: ${item.name}`, i, batch.length);
		const isRecovery = isUpdate && !queued.has(item.uuid);
		const saved = await read(item);
		if (!saved) {
			result.failed.push(item.name);
			continue;
		}
		await ensureFolder(app, folder);
		await ensureFolder(app, rawFolder);
		const suffix = isRecovery ? ' (recovered)' : isUpdate ? ` (updated ${localStamp(item.updated_at)})` : '';
		const stem = freeStem(app, folder, baseName(saved.createdAt, item.name) + suffix, item.uuid, rawFolder);
		const json = `${rawFolder}/${stem}.json`;
		const md = `${folder}/${stem}.md`;
		await createNew(app, json, saved.json);
		await createNew(app, md, saved.md(rawLink(folder, json)));
		index[item.uuid] = { updated_at: item.updated_at, json, md, synced: new Date().toISOString() };
		await plugin.saveSettings();
		if (isRecovery) result.restored.push(stem);
		else {
			result.written.push(stem);
			if (isUpdate) result.changedCount++;
			else result.newCount++;
		}
	}
}

/** What went wrong, for the log. A JSON error can quote its input, so that kind shows only its name. */
export function failureText(e: unknown): string {
	if (!(e instanceof Error) || e instanceof SyntaxError) return e instanceof Error ? e.name : 'unknown error';
	return `${e.name}: ${e.message.slice(0, 160)}`;
}

export async function writeLog(plugin: AIChatBridge, site: string, account: GeminiAccount, r: GoogleSyncResult): Promise<void> {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion`);
	if (r.failed.length) parts.push(`could not read: ${r.failed.slice(0, 10).join(', ')}`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – **${withAccount(site, plugin.settings.gemini, account)}:** ${parts.join(', ')}`;
	if (r.written.length) line += `: ${r.written.slice(0, 20).map((w) => `[[${w}]]`).join(', ')}${r.written.length > 20 ? ` +${r.written.length - 20} more` : ''}`;
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
