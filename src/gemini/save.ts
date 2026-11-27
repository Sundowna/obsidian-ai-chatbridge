// Saving a list of Google chats (Gemini or AI Studio) into one folder: new and changed ones,
// plus ones whose files were deleted from the vault. A chat has one note: when it continues,
// the note is rewritten and the version before stays in the raw folder (see versions.ts).

import { TFile } from 'obsidian';
import { withAccount } from '../accounts';
import { appendLog } from '../log';
import { guardMissing } from '../missing-guard';
import { restoreNote, savedChat, type FromRaw } from '../restore';
import type AIChatBridge from '../main';
import { baseName, dailyNoteName, tagAccount } from '../naming';
import type { ProgressFn } from '../progress';
import { newestFirst, pickTodo, type Todo } from '../select';
import type { GeminiAccount } from '../settings';
import { renderGeminiTranscript, renderStudioTranscript } from './transcript';
import type { GeminiChat, StudioPrompt } from './types';
import type { IndexEntry, ListItem } from '../types';
import { ensureFolder, findFile, freeStem } from '../vaultio';
import { dirOf, rawLink } from '../raw-folders';
import { addVersion, editsLog, keepVersion, noEdits, recordEdit, setNoteFlag, withVersionInfo, writeNote, writeRaw, type EditedReport } from '../versions';

export interface GoogleSyncResult {
	listed: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	written: string[];
	restored: string[];
	/** Notes whose pinned mark was brought up to date without fetching the chat. */
	flagChanges: number;
	/** Chats that could not be read and were left out. */
	failed: string[];
	/** Notes you had edited whose chat continued. */
	edits: EditedReport;
	stopped?: string;
}

const stemOf = (p: string): string => (p.split('/').pop() ?? '').replace(/\.md$/, '');

export const emptyResult = (): GoogleSyncResult => ({ listed: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], flagChanges: 0, failed: [], edits: noEdits() });

/** What one chat becomes: its file name's date, and the two files' contents. */
export interface Saved {
	createdAt: string;
	json: string;
	/** Gets the transcript's link to the raw .json: its file name, or its path when in another folder. */
	md: (jsonLink: string) => string;
}

/** Google's number for the signed-in account as the Gemini page gives it, or '' when it is not one. */
export const googleAccountId = (v: unknown): string => (typeof v === 'string' && /^\d{10,30}$/.test(v) ? v : '');

/**
 * Another account of the plugin that is signed in with the same Google account, or undefined.
 * Two such accounts would save every chat twice. An unknown account (`who` empty) matches nobody.
 */
export function sameGoogleLogin(accounts: readonly GeminiAccount[], account: GeminiAccount, who: string | undefined): GeminiAccount | undefined {
	return who ? accounts.find((other) => other !== account && other.web.userId === who) : undefined;
}

export const SAME_GOOGLE_LOGIN = (label: string): string => `This login is the same Google account as "${label}". Log in with a different account, or remove this one.`;

/** A Gemini chat's note from its saved raw file. */
export const geminiFromRaw = (label: string): FromRaw => (raw, link, uuid) => tagAccount(renderGeminiTranscript(savedChat<GeminiChat>(raw, uuid, 'turns'), link), label);
/** An AI Studio prompt's note from its saved raw file. */
export const studioFromRaw = (label: string): FromRaw => (raw, link, uuid) => tagAccount(renderStudioTranscript(savedChat<StudioPrompt>(raw, uuid, 'messages'), link), label);

/** A yes/no mark the provider's chat list carries for every chat (Gemini: pinned), kept up to date in the note. */
export interface ChatFlag {
	key: string;
	of: (item: ListItem) => boolean;
}

/**
 * Chats that are not fetched in this run: when the mark flipped at the provider, only that
 * property is changed in the note. Returns how many notes were changed.
 */
export async function keepFlags(plugin: AIChatBridge, items: readonly ListItem[], index: Record<string, IndexEntry>, skip: ReadonlySet<string>, flag: ChatFlag): Promise<number> {
	let changed = 0;
	let dirty = false;
	for (const item of items) {
		const known = index[item.uuid];
		const now = flag.of(item);
		if (!known || skip.has(item.uuid) || known.flagged === now) continue;
		if (await setNoteFlag(plugin.app, known.md, flag.key, now)) changed++;
		known.flagged = now;
		dirty = true;
	}
	if (dirty) await plugin.saveSettings();
	return changed;
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
	/** `label`: what the chats are called in the safety stop; `fromRaw`: the note from its saved raw file. */
	o: { label: string; fromRaw: FromRaw; flag?: ChatFlag },
): Promise<void> {
	const app = plugin.app;
	const exists = (path: string): boolean => findFile(app, path) instanceof TFile;
	const todo = pickTodo(items, index);
	const queued = new Set(todo.map((t) => t.item.uuid));
	const lost = (it: ListItem): boolean => {
		const known = index[it.uuid];
		return !!known && !queued.has(it.uuid) && (!exists(known.json) || !exists(known.md));
	};
	// Before anything is written: many saved chats missing means a wrong sync history, not deletions.
	const saved = Object.values(index);
	guardMissing(o.label, saved.length, saved.filter((e) => !exists(e.md) || !exists(e.json)).length);
	result.listed = items.length;
	// A deleted note whose raw file is still there is written again from it; the rest is fetched.
	const recoveries: Todo[] = [];
	let rebuilt = 0;
	for (const item of items.filter(lost)) {
		const known = index[item.uuid]!;
		if (await restoreNote(app, item.uuid, known, o.fromRaw)) {
			await plugin.saveSettings();
			result.restored.push(stemOf(known.md));
			rebuilt++;
		} else recoveries.push({ item, isUpdate: true });
	}
	result.unchanged = items.length - todo.length - recoveries.length - rebuilt;
	const jobs = newestFirst([...todo, ...recoveries]);
	const max = plugin.settings.maxChatsPerRun;
	const batch = max > 0 ? jobs.slice(0, max) : jobs;
	result.leftForLater = jobs.length - batch.length;
	if (o.flag) result.flagChanges = await keepFlags(plugin, items, index, new Set(jobs.map((j) => j.item.uuid)), o.flag);

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
		index[item.uuid] = { updated_at: item.updated_at, json, md, synced: new Date().toISOString(), versions, noteHash: note.hash, ...(o.flag ? { flagged: o.flag.of(item) } : {}) };
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
	if (r.flagChanges) parts.push(`pinned updated on ${r.flagChanges} note${r.flagChanges === 1 ? '' : 's'}`);
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
