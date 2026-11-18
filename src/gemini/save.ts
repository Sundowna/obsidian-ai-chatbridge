// Saving a list of Google chats (Gemini or AI Studio) into one folder: new and changed ones,
// plus ones whose files were deleted from the vault. A chat has one note: when it continues,
// the note is rewritten and the version before stays in the raw folder (see versions.ts).

import { TFile } from 'obsidian';
import { withAccount } from '../accounts';
import { appendLog } from '../log';
import type AIChatBridge from '../main';
import { baseName, dailyNoteName } from '../naming';
import type { ProgressFn } from '../progress';
import { newestFirst, pickTodo, type Todo } from '../select';
import type { GeminiAccount } from '../settings';
import type { IndexEntry, ListItem } from '../types';
import { ensureFolder, findFile, freeStem } from '../vaultio';
import { dirOf, rawLink } from '../raw-folders';
import { addVersion, editsLog, keepVersion, noEdits, recordEdit, withVersionInfo, writeNote, writeRaw, type EditedReport } from '../versions';

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
	/** Notes you had edited whose chat continued. */
	edits: EditedReport;
	stopped?: string;
}

const stemOf = (p: string): string => (p.split('/').pop() ?? '').replace(/\.md$/, '');

export const emptyResult = (): GoogleSyncResult => ({ listed: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], failed: [], edits: noEdits() });

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
	const exists = (path: string): boolean => findFile(app, path) instanceof TFile;
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
		// A chat that continues (or whose files were deleted) keeps its one note and its name.
		const before = isUpdate ? index[item.uuid] : undefined;
		const noteFolder = before ? dirOf(before.md) : folder;
		await ensureFolder(app, noteFolder);
		const stem = before ? stemOf(before.md) : freeStem(app, folder, baseName(saved.createdAt, item.name), item.uuid, rawFolder);
		const json = before?.json ?? `${rawFolder}/${stem}.json`;
		const md = before?.md ?? `${folder}/${stem}.md`;
		// A recovery is the same version again, so there is no earlier one to keep.
		const versions = addVersion(before, before && !isRecovery ? await keepVersion(app, [json], before.updated_at, saved.json) : null);
		await writeRaw(app, json, saved.json);
		const note = await writeNote(app, md, withVersionInfo(saved.md(rawLink(noteFolder, json)), versions, noteFolder), { policy: plugin.settings.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced, keep: isRecovery ? ['unread'] : [] });
		recordEdit(result.edits, note, md);
		index[item.uuid] = { updated_at: item.updated_at, json, md, synced: new Date().toISOString(), versions, noteHash: note.hash };
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
	parts.push(...editsLog(r.edits));
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
