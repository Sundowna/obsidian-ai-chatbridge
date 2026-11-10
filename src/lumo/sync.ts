// One sync of one Lumo account: list, decrypt, save each new or changed chat as raw JSON
// (readable text, no keys) plus a Markdown transcript. Never overwrites a file.

import { TFile } from 'obsidian';
import { withAccount } from '../accounts';
import { StopError } from '../api';
import { appendLog } from '../log';
import type AIChatBridge from '../main';
import { baseName, dailyNoteName, localStamp } from '../naming';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { customProjectFolder, DEFAULT_RECENT, filterByProjects, nothingSelected, pickTodo, projectSubfolder, type Todo } from '../select';
import { cleanFolder, MIN_DELAY_SECONDS, type LumoAccount } from '../settings';
import type { ListItem } from '../types';
import { createNew, ensureFolder, freeStem } from '../vaultio';
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
	stopped?: string;
	/** "Only selected projects" is on with nothing selected, so the sync did not run. */
	nothingSelected?: boolean;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

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
	const result: LumoSyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], failed: [] };
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
		const jobs = [...todo, ...recoveries];
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
			const folder = customProjectFolder(item, g, recent) ?? (g.projectSubfolders ? `${base}/${projectSubfolder(item, recent)}` : base);
			await ensureFolder(app, folder);
			const suffix = isRecovery ? ' (recovered)' : isUpdate ? ` (updated ${localStamp(item.updated_at)})` : '';
			const stem = freeStem(app, folder, baseName(item.created_at, item.name) + suffix, item.uuid);
			const json = `${folder}/${stem}.json`;
			const md = `${folder}/${stem}.md`;
			await createNew(app, json, JSON.stringify(chat, null, '\t'));
			await createNew(app, md, renderLumoTranscript(chat, `${stem}.json`));
			g.index[item.uuid] = { updated_at: item.updated_at, json, md, synced: new Date().toISOString() };
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
