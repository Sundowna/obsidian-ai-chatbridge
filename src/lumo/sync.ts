// One sync of one Lumo account: list, decrypt, save each new or changed chat as raw JSON
// (readable text, no keys) plus a Markdown transcript. A chat has one note: when it continues,
// the note is rewritten and the version before stays in the raw folder (see versions.ts).

import { TFile } from 'obsidian';
import { withAccount } from '../accounts';
import { StopError } from '../api';
import { appendLog } from '../log';
import type AIChatBridge from '../main';
import { baseName, dailyNoteName, tagAccount } from '../naming';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { DEFAULT_RECENT, filterByProjects, newestFirst, nothingSelected, pickTodo, type Todo } from '../select';
import { cleanFolder, MIN_DELAY_SECONDS, type LumoAccount } from '../settings';
import type { ListItem } from '../types';
import { ensureFolder, freeStem } from '../vaultio';
import { chatFolders, dirOf, masterRaw, rawLink } from '../raw-folders';
import { addVersion, editsLog, keepVersion, noEdits, recordEdit, withVersionInfo, writeNote, writeRaw, type EditedReport } from '../versions';
import { loginRef } from '../accounts';
import { LumoApi } from './api';
import { decryptChat, decryptListing, shallowMessages, type LumoEntry } from './chat';
import { renderLumoTranscript } from './transcript';
import type { LumoWireConversation, LumoWireSpace } from './types';

const MAX_PAGES = 300; // a guard against an endless paging loop

export interface LumoSyncResult {
	listed: number;
	filteredOut: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	written: string[];
	restored: string[];
	/** Chats that could not be decrypted and were left out. */
	failed: string[];
	/** Notes you had edited whose chat continued. */
	edits: EditedReport;
	stopped?: string;
	/** "Only selected projects" is on with nothing selected, so the sync did not run. */
	nothingSelected?: boolean;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const stemOf = (p: string): string => (p.split('/').pop() ?? '').replace(/\.md$/, '');

/** Every space, oldest pages last. Pages overlap at their edge, so later copies are dropped. */
export async function allSpaces(api: LumoApi, wait: () => Promise<void>, progress: ProgressFn): Promise<LumoWireSpace[]> {
	const byId = new Map<string, LumoWireSpace>();
	let before: number | undefined;
	for (let page = 1; page <= MAX_PAGES; page++) {
		progress(`reading Lumo chat list… page ${page}`);
		await wait();
		const spaces = await api.spaces(before);
		for (const s of spaces) if (!byId.has(s.ID)) byId.set(s.ID, s);
		if (!spaces.length) break;
		const oldest = Math.min(...spaces.map((s) => Math.floor(Date.parse(s.CreateTime) / 1000)));
		if (before !== undefined && oldest >= before) break;
		before = oldest;
	}
	return [...byId.values()];
}

/** The conversation with every message's full text, fetching the ones it only outlines. */
async function fullConversation(api: LumoApi, id: string, wait: () => Promise<void>): Promise<LumoWireConversation> {
	await wait();
	const conversation = await api.conversation(id);
	const full = new Map<string, Awaited<ReturnType<LumoApi['message']>>>();
	for (const m of shallowMessages(conversation)) {
		await wait();
		full.set(m.ID, await api.message(m.ID));
	}
	return { ...conversation, Messages: conversation.Messages?.map((m) => full.get(m.ID) ?? m) };
}

export async function runLumoSync(plugin: AIChatBridge, account: LumoAccount, progress: ProgressFn = () => undefined): Promise<LumoSyncResult> {
	const s = plugin.settings;
	const g = account.web;
	const app = plugin.app;
	const delayMs = Math.max(MIN_DELAY_SECONDS, s.delaySeconds) * 1000;
	const wait = async (): Promise<void> => { await sleep(delayMs); };
	const result: LumoSyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], failed: [], edits: noEdits() };
	if (nothingSelected(g)) return { ...result, nothingSelected: true };
	const exists =(path: string): boolean => app.vault.getAbstractFileByPath(path) instanceof TFile;
	let api: LumoApi | null = null;

	try {
		const base = cleanFolder(g.folder);
		if (!base) throw new StopError('The Lumo folder setting is empty or invalid.');
		progress('unlocking Lumo…');
		const a = await LumoApi.connect(loginRef('lumo', account));
		api = a;
		const twin = s.lumo.find((other) => other !== account && other.web.userId === a.userId);
		if (twin) throw new StopError(`This login is the same Proton account as "${twin.label}". Log in with a different account, or remove this one.`);
		if (g.userId !== a.userId) {
			g.userId = a.userId;
			await plugin.saveSettings();
		}

		const listing = await decryptListing(await allSpaces(a, wait, progress), a.masterKeys);
		if (listing.failed && !listing.entries.length) throw new StopError(`Could not decrypt any of ${listing.failed} Lumo chats. Lumo may have changed how it stores them, so nothing was saved.`);
		if (listing.failed) result.failed.push(`${listing.failed} chats could not be listed`);

		const recent = g.recentFolderName || DEFAULT_RECENT;
		const all = listing.entries.map((e) => e.item);
		const items = g.onlyProjects ? filterByProjects(all, g.projects, recent) : all;
		const entryOf = new Map<string, LumoEntry>(listing.entries.map((e) => [e.item.uuid, e]));
		result.listed = all.length;
		result.filteredOut = all.length - items.length;

		const todo = pickTodo(items, g.index);
		const queued = new Set(todo.map((t) => t.item.uuid));
		const lost = (it: ListItem): boolean => {
			const known = g.index[it.uuid];
			return !!known && !queued.has(it.uuid) && (!exists(known.json) || !exists(known.md));
		};
		const recoveries: Todo[] = items.filter(lost).map((item) => ({ item, isUpdate: true }));
		result.unchanged = items.length - todo.length - recoveries.length;
		const jobs = newestFirst([...todo, ...recoveries]);
		const batch = s.maxChatsPerRun > 0 ? jobs.slice(0, s.maxChatsPerRun) : jobs;
		result.leftForLater = jobs.length - batch.length;

		for (const [i, { item, isUpdate }] of batch.entries()) {
			progress(`${i + 1} of ${batch.length}: ${item.name}`, i, batch.length);
			const isRecovery = isUpdate && !queued.has(item.uuid);
			const entry = entryOf.get(item.uuid)!;
			const conversation = await fullConversation(a, item.uuid, wait);
			let chat;
			try {
				chat = await decryptChat(entry, conversation);
			} catch (e) {
				if (e instanceof ShapeError) throw e;
				result.failed.push(item.name);
				continue;
			}
			// A chat that continues (or whose files were deleted) keeps its one note and its name.
			const before = isUpdate ? g.index[item.uuid] : undefined;
			const today = chatFolders(item, g, base, g.rawFolder, recent, masterRaw(plugin.settings));
			const folder = before ? dirOf(before.md) : today.md;
			await ensureFolder(app, folder);
			const stem = before ? stemOf(before.md) : freeStem(app, folder, baseName(item.created_at, item.name), item.uuid, today.raw);
			const json = before?.json ?? `${today.raw}/${stem}.json`;
			const md = before?.md ?? `${folder}/${stem}.md`;
			const raw = JSON.stringify(chat, null, '\t');
			// A recovery is the same version again, so there is no earlier one to keep.
			const versions = addVersion(before, before && !isRecovery ? await keepVersion(app, [json], before.updated_at, raw) : null);
			await writeRaw(app, json, raw);
			const note = await writeNote(app, md, withVersionInfo(tagAccount(renderLumoTranscript(chat, rawLink(folder, json)), account.label), versions, folder), { policy: s.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced, keep: isRecovery ? ['unread'] : [] });
			recordEdit(result.edits, note, md);
			g.index[item.uuid] = { updated_at: item.updated_at, json, md, synced: new Date().toISOString(), versions, noteHash: note.hash };
			await plugin.saveSettings();
			if (isRecovery) result.restored.push(stem);
			else {
				result.written.push(stem);
				if (isUpdate) result.changedCount++;
				else result.newCount++;
			}
		}
	} catch (e) {
		if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `Lumo's answer could not be verified (${e.message}).`;
		else result.stopped = `Something went wrong while reading Lumo (${failureText(e)}).`;
	} finally {
		api?.close();
	}
	await writeLog(plugin, account, result);
	return result;
}

/** What went wrong, for the log. A JSON error can quote its input, so that kind shows only its name. */
function failureText(e: unknown): string {
	if (!(e instanceof Error) || e instanceof SyntaxError) return e instanceof Error ? e.name : 'unknown error';
	return `${e.name}: ${e.message.slice(0, 160)}`;
}

async function writeLog(plugin: AIChatBridge, account: LumoAccount, r: LumoSyncResult): Promise<void> {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.filteredOut) parts.push(`${r.filteredOut} skipped (other projects)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion`);
	parts.push(...editsLog(r.edits));
	if (r.failed.length) parts.push(`could not decrypt: ${r.failed.slice(0, 10).join(', ')}`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – **${withAccount('Lumo', plugin.settings.lumo, account)}:** ${parts.join(', ')}`;
	if (r.written.length) line += `: ${r.written.slice(0, 20).map((w) => `[[${w}]]`).join(', ')}${r.written.length > 20 ? ` +${r.written.length - 20} more` : ''}`;
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
