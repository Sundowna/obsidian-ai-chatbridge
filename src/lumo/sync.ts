// One sync of one Lumo account: list, decrypt, save each new or changed chat as raw JSON
// (readable text, no keys) plus a Markdown transcript. A chat has one note: when it continues,
// the note is rewritten and the version before stays in the raw folder (see versions.ts).

import { TFile } from 'obsidian';
import { withAccount } from '../accounts';
import { StopError } from '../api';
import { appendLog } from '../log';
import { guardMissing, MassMissingError } from '../missing-guard';
import { restoreNote, savedChat, type FromRaw } from '../restore';
import { keepFlags } from '../gemini/save';
import type AIChatBridge from '../main';
import { baseName, dailyNoteName, tagAccount } from '../naming';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { OddChats } from '../odd-chats';
import { endCooldown, heldByCooldown, pausedBy } from '../cooldown-run';
import { DEFAULT_RECENT, filterByProjects, newestFirst, nothingSelected, pickTodo, type Todo } from '../select';
import { cleanFolder, MIN_DELAY_SECONDS, type LumoAccount } from '../settings';
import type { ListItem } from '../types';
import { createNew, ensureFolder, findFile, freeFileName, freeStem } from '../vaultio';
import { KIND_FOLDER, numbered, safeFileName } from '../files';
import { chatFolders, dirOf, masterRaw, rawLink } from '../raw-folders';
import { addVersion, editsLog, keepVersion, noEdits, recordEdit, setNoteFlag, withVersionInfo, writeNote, writeRaw, type EditedReport } from '../versions';
import { loginRef } from '../accounts';
import { LumoApi } from './api';
import { decryptChat, decryptListing, shallowMessages, type LumoEntry } from './chat';
import { artifactKey, attachmentKey, collectFiles, extraKey, namesFiles, type CollectedFiles, type LumoAssetContent } from './assets';
import { renderLumoTranscript, type LumoFileLinks } from './transcript';
import { ASSET_GENERATED_DOC, ASSET_GENERATED_IMAGE, type LumoChat, type LumoWireConversation, type LumoWireSpace } from './types';

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
	/** Files saved: your uploads and what Lumo made. */
	filesSaved: number;
	/** Files that could not be saved, with the reason. */
	filesSkipped: string[];
	/** Chats saved earlier that now got their files. */
	backfilledChats: number;
	/** Notes whose starred mark was brought up to date without fetching the chat. */
	flagChanges: number;
	/** Chats that could not be decrypted and were left out. */
	failed: string[];
	/** Notes you had edited whose chat continued. */
	edits: EditedReport;
	stopped?: string;
	/** Set when the run waits for a rate-limit pause to end (not an error). */
	resumeAt?: number;
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

/** Where the files of a chat come from during a sync. Without it, no files are saved. */
export interface LumoFileSource {
	/** True when the chat's space holds a file Lumo made (which no message needs to name). */
	generated: (item: ListItem) => boolean;
	/** The chat's files that are not saved yet. `have` says whether an index key points at a file. */
	collect: (item: ListItem, chat: LumoChat, have: (key: string) => boolean) => Promise<CollectedFiles>;
}

/**
 * Saves the listed chats of one account: new and changed ones, plus ones whose files were
 * deleted from the vault. `read` hands back the decrypted chat, or null when it cannot be read.
 */
export async function saveLumoChats(
	plugin: AIChatBridge,
	account: LumoAccount,
	base: string,
	items: ListItem[],
	read: (item: ListItem) => Promise<LumoChat | null>,
	progress: ProgressFn,
	result: LumoSyncResult,
	files?: LumoFileSource,
	/** Says whether a chat is starred at Lumo; the note's property is kept up to date from it. */
	starred?: (item: ListItem) => boolean,
): Promise<void> {
	const s = plugin.settings;
	const g = account.web;
	const app = plugin.app;
	const exists = (path: string): boolean => findFile(app, path) instanceof TFile;
	const recent = g.recentFolderName || DEFAULT_RECENT;
	const downloads = g.downloadFiles && files ? files : undefined;
	const savedPath = (key: string): string | undefined => {
		const p = g.fileIndex[key];
		return p && exists(p) ? p : undefined;
	};
	/** Some file saved for this chat (in its Artifacts/Attachments folders) was deleted. */
	const fileDeleted = (md: string): boolean => {
		const dirs = Object.values(KIND_FOLDER).map((k) => `${dirOf(md)}/${k}/${stemOf(md)}/`);
		return Object.values(g.fileIndex).some((p) => dirs.some((d) => p.startsWith(d)) && !exists(p));
	};
	/** The saved files of a chat, for the links in its note. */
	const linksFor = (chatId: string): LumoFileLinks => ({
		attachment: (tag) => savedPath(attachmentKey(tag)),
		artifact: (id) => savedPath(artifactKey(chatId, id)),
		extras: Object.keys(g.fileIndex).filter((k) => k.startsWith(extraKey(chatId, ''))).flatMap((k) => savedPath(k) ?? []),
	});
	const noteOf = (chat: LumoChat, link: string): string => tagAccount(renderLumoTranscript(chat, link, linksFor(chat.id), g.showReasoning !== false), account.label);

	const todo = pickTodo(items, g.index);
	const queued = new Set(todo.map((t) => t.item.uuid));
	const lost = (it: ListItem): boolean => {
		const known = g.index[it.uuid];
		return !!known && !queued.has(it.uuid) && (!exists(known.json) || !exists(known.md));
	};
	// Before anything is written: many saved chats missing means a wrong sync history, not deletions.
	const saved = Object.values(g.index);
	guardMissing('Lumo chats', saved.length, saved.filter((e) => !exists(e.md) || !exists(e.json)).length);
	// A deleted note whose raw file is still there is written again from it; the rest is fetched.
	const fromRaw: FromRaw = (raw, link, uuid) => noteOf(savedChat<LumoChat>(raw, uuid, 'messages'), link);
	const recoveries: Todo[] = [];
	let rebuilt = 0;
	for (const item of items.filter(lost)) {
		const known = g.index[item.uuid]!;
		if (await restoreNote(app, item.uuid, known, fromRaw)) {
			await plugin.saveSettings();
			result.restored.push(stemOf(known.md));
			rebuilt++;
		} else recoveries.push({ item, isUpdate: true });
	}
	// Chats saved before their files were (an older build, or the setting was off): fetched once
	// more for their files. One whose raw file names no file, in a space where Lumo made none,
	// has nothing to fetch and is only marked as checked.
	const fetching = new Set([...queued, ...recoveries.map((r) => r.item.uuid)]);
	const backfills: Todo[] = [];
	let marked = false;
	for (const item of downloads ? items : []) {
		const known = g.index[item.uuid];
		if (!known || fetching.has(item.uuid)) continue;
		// Checked already: only a saved file of its that was deleted brings it back.
		if (known.outputsChecked === known.updated_at) {
			if (fileDeleted(known.md)) backfills.push({ item, isUpdate: true });
			continue;
		}
		const raw = findFile(app, known.json);
		let nothing = false;
		if (raw instanceof TFile && !downloads!.generated(item)) {
			try {
				nothing = !namesFiles(savedChat<LumoChat>(await app.vault.read(raw), item.uuid, 'messages'));
			} catch {
				// A raw file that cannot be read as this chat: fetch the chat to find out.
			}
		}
		if (nothing) {
			known.outputsChecked = known.updated_at;
			marked = true;
		} else backfills.push({ item, isUpdate: true });
	}
	if (marked) await plugin.saveSettings();
	const backfilling = new Set(backfills.map((b) => b.item.uuid));
	result.unchanged = items.length - todo.length - recoveries.length - rebuilt - backfills.length;
	const jobs = newestFirst([...todo, ...recoveries, ...backfills]);
	const batch = s.maxChatsPerRun > 0 ? jobs.slice(0, s.maxChatsPerRun) : jobs;
	result.leftForLater = jobs.length - batch.length;
	if (starred) result.flagChanges = await keepFlags(plugin, items, g.index, new Set(jobs.map((j) => j.item.uuid)), { key: 'starred', of: starred });

	for (const [i, { item, isUpdate }] of batch.entries()) {
		progress(`${i + 1} of ${batch.length}: ${item.name}`, i, batch.length);
		const isBackfill = backfilling.has(item.uuid);
		const isRecovery = isUpdate && !queued.has(item.uuid) && !isBackfill;
		const chat = await read(item);
		if (!chat) {
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

		// The chat's files first, so the note can link them.
		let filesChecked = before?.outputsChecked;
		let gotFiles = 0;
		if (downloads) {
			const got = await downloads.collect(item, chat, (key) => savedPath(key) !== undefined);
			for (const f of got.files) {
				const dir = `${folder}/${KIND_FOLDER[f.kind]}/${stem}`;
				await ensureFolder(app, dir);
				const path = `${dir}/${freeFileName(app, dir, safeFileName(f.name), numbered)}`;
				await createNew(app, path, f.bytes);
				for (const key of f.keys) g.fileIndex[key] = path;
				gotFiles++;
			}
			result.filesSaved += gotFiles;
			result.filesSkipped.push(...got.skipped);
			// A file that could not be read is tried again next run.
			if (!got.skipped.length) filesChecked = item.updated_at;
		}

		const raw = JSON.stringify(chat, null, '\t');
		// A recovery is the same version again, so there is no earlier one to keep.
		const versions = addVersion(before, before && !isRecovery ? await keepVersion(app, [json], before.updated_at, raw) : null);
		await writeRaw(app, json, raw);
		const note = await writeNote(app, md, withVersionInfo(noteOf(chat, rawLink(folder, json)), versions, folder), { policy: s.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced, keep: isRecovery || isBackfill ? ['unread'] : [] });
		recordEdit(result.edits, note, md);
		// A star taken away since the last version must not stay in the note as if you had added it.
		if (starred) await setNoteFlag(app, md, 'starred', starred(item));
		g.index[item.uuid] = { updated_at: item.updated_at, json, md, synced: new Date().toISOString(), versions, noteHash: note.hash, ...(filesChecked ? { outputsChecked: filesChecked } : {}), ...(starred ? { flagged: starred(item) } : {}) };
		await plugin.saveSettings();
		if (isBackfill) {
			if (gotFiles) result.backfilledChats++;
		} else if (isRecovery) result.restored.push(stem);
		else {
			result.written.push(stem);
			if (isUpdate) result.changedCount++;
			else result.newCount++;
		}
	}
}

export async function runLumoSync(plugin: AIChatBridge, account: LumoAccount, progress: ProgressFn = () => undefined): Promise<LumoSyncResult> {
	const s = plugin.settings;
	const g = account.web;
	const delayMs = Math.max(MIN_DELAY_SECONDS, s.delaySeconds) * 1000;
	const wait = async (): Promise<void> => { await sleep(delayMs); };
	const result: LumoSyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], filesSaved: 0, filesSkipped: [], backfilledChats: 0, flagChanges: 0, failed: [], edits: noEdits() };
	if (nothingSelected(g)) return { ...result, nothingSelected: true };
	let api: LumoApi | null = null;

	try {
		if (heldByCooldown(g, 'Lumo', result)) {
			await plugin.saveSettings();
			return result;
		}
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
		// A project's files belong to its space, so chats of one project share what was read.
		const assetCache = new Map<string, LumoAssetContent | null>();
		const odd = new OddChats();
		result.listed = all.length;
		result.filteredOut = all.length - items.length;

		await saveLumoChats(plugin, account, base, items, async (item) => {
			const conversation = await fullConversation(a, item.uuid, wait);
			try {
				return await decryptChat(entryOf.get(item.uuid)!, conversation);
			} catch (e) {
				// An odd shape: skipped like a chat that cannot be decrypted, but the third one stops the sync.
				if (e instanceof ShapeError && !odd.skip(e, item.name)) throw e;
				return null;
			}
		}, progress, result, {
			generated: (item) => (entryOf.get(item.uuid)?.assets ?? []).some((x) => x.AssetType === ASSET_GENERATED_DOC || x.AssetType === ASSET_GENERATED_IMAGE),
			collect: (item, chat, have) => collectFiles(entryOf.get(item.uuid)!, chat, {
				have,
				cache: assetCache,
				fetch: async (id) => {
					await wait();
					return a.asset(id);
				},
			}),
		}, (item) => entryOf.get(item.uuid)?.starred === true);
	} catch (e) {
		if (pausedBy(e, g, result)) await plugin.saveSettings();
		else if (e instanceof StopError || e instanceof MassMissingError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `Lumo's answer could not be verified (${e.message}).`;
		else result.stopped = `Something went wrong while reading Lumo (${failureText(e)}).`;
	} finally {
		api?.close();
	}
	if (endCooldown(g, result)) await plugin.saveSettings();
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
	if (r.filesSaved) parts.push(`${r.filesSaved} file${r.filesSaved === 1 ? '' : 's'} saved`);
	if (r.backfilledChats) parts.push(`files added to ${r.backfilledChats} chat${r.backfilledChats === 1 ? '' : 's'} saved earlier`);
	if (r.flagChanges) parts.push(`starred updated on ${r.flagChanges} note${r.flagChanges === 1 ? '' : 's'}`);
	if (r.filesSkipped.length) parts.push(`files skipped: ${r.filesSkipped.slice(0, 10).join('; ')}${r.filesSkipped.length > 10 ? ` +${r.filesSkipped.length - 10} more` : ''}`);
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
