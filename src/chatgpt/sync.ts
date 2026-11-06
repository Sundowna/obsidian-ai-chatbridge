// One ChatGPT sync run: list -> filter -> fetch new/changed -> files first -> write -> index;
// then restore deleted files/transcripts and fetch missing files. Same rules as claude.ai:
// files are only ever created, a changed chat gets a new "(updated …)" pair, stop on anything odd.

import { TFile, TFolder } from 'obsidian';
import type AIChatBridge from '../main';
import { StopError } from '../api';
import { ShapeError } from '../schema';
import { DEFAULT_RECENT, dedupe, filterByProjects, pickTodo, projectFolderNames, projectSubfolder } from '../select';
import { baseName, dailyNoteName, localStamp } from '../naming';
import { createNew, ensureFolder, freeFileName, freeStem } from '../vaultio';
import { appendLog } from '../log';
import { cleanFolder, MIN_DELAY_SECONDS } from '../settings';
import { FileTask, KIND_FOLDER, numbered, safeFileName } from '../files';
import type { IndexEntry, ListItem } from '../types';
import { BlockedLinkError, GptApi } from './api';
import { checkGptChat, checkGptFileInfo, checkGptList, checkGptOlderPage, checkGptSidebar, isMessageId } from './schema';
import { joinParts, olderPartPath } from './parts';
import { toListItems } from './select';
import { gptChatFiles } from './files';
import { renderGptTranscript } from './transcript';
import type { GptChat, GptListItem } from './types';
import type { ProgressFn } from '../progress';

const MAX_PAGES = 300; // 6000 chats per list; a guard against an endless paging loop
const MAX_OLDER = 200; // older parts per chat (10 turns each)
const SKIPPED = 'skipped: ';

export interface GptSyncResult {
	listed: number;
	filteredOut: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	written: string[];
	restored: string[];
	foldersCreated: string[];
	filesSaved: number;
	filesDeduped: number;
	filesSkipped: string[];
	backfilledChats: number;
	/** Chats too long to load in one piece – skipped, not half-saved. */
	tooLong: string[];
	/** The project list said there are more projects than it sent. */
	projectsCut: boolean;
	stopped?: string;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

/** `progress` gets short status texts while the sync runs (shown in a notice). */
export async function runGptSync(plugin: AIChatBridge, progress: ProgressFn = () => undefined): Promise<GptSyncResult> {
	const s = plugin.settings;
	const g = s.gpt;
	const app = plugin.app;
	const delayMs = Math.max(MIN_DELAY_SECONDS, s.delaySeconds) * 1000;
	const result: GptSyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], foldersCreated: [], filesSaved: 0, filesDeduped: 0, filesSkipped: [], backfilledChats: 0, tooLong: [], projectsCut: false };
	let api: GptApi | null = null;

	const exists = (path: string): boolean => app.vault.getAbstractFileByPath(path) instanceof TFile;
	const isMissing = (f: FileTask): boolean => {
		const p = g.fileIndex[f.fileUuid];
		if (p === undefined) return true;
		if (p.startsWith(SKIPPED)) return false;
		return !exists(p);
	};
	const savedPaths = (chat: GptChat): Map<string, string> => {
		const m = new Map<string, string>();
		for (const f of gptChatFiles(chat)) {
			const p = g.fileIndex[f.fileUuid];
			if (p && !p.startsWith(SKIPPED) && exists(p)) m.set(f.fileUuid, p);
		}
		return m;
	};
	const transcript = (chat: GptChat, item: ListItem, stem: string) =>
		renderGptTranscript(chat, { projectName: item.project?.name, jsonFileName: `${stem}.json`, filePaths: savedPaths(chat) });

	/** Downloads files one by one (info, then bytes). Size mismatch or 404: not saved, named in the log. */
	const fetchFiles = async (a: GptApi, chatId: string, tasks: FileTask[]): Promise<{ task: FileTask; bytes: ArrayBuffer }[]> => {
		const out: { task: FileTask; bytes: ArrayBuffer }[] = [];
		for (const task of tasks) {
			try {
				await sleep(delayMs);
				const info = await a.fileInfo(task.fileUuid, chatId);
				if (info === null) {
					result.filesSkipped.push(`${task.name} (not found on chatgpt.com)`);
					g.fileIndex[task.fileUuid] = `${SKIPPED}not found (404)`;
					continue;
				}
				const { url, size } = checkGptFileInfo(info);
				await sleep(delayMs);
				const bytes = await a.fileBytes(url);
				if (bytes === null) {
					result.filesSkipped.push(`${task.name} (download link not found)`);
					g.fileIndex[task.fileUuid] = `${SKIPPED}not found (404)`;
					continue;
				}
				const want = size ?? task.sizeBytes;
				if (want !== undefined && bytes.byteLength !== want) {
					result.filesSkipped.push(`${task.name} (size ${bytes.byteLength} ≠ ${want})`);
					g.fileIndex[task.fileUuid] = `${SKIPPED}size mismatch`;
					continue;
				}
				out.push({ task, bytes });
			} catch (e) {
				if (e instanceof BlockedLinkError) {
					// Not followed; not marked either, so a later version can fetch it.
					result.filesSkipped.push(`${task.name} (download from ${e.where} failed – will retry)`);
					continue;
				}
				if (e instanceof StopError) throw new StopError(`While fetching file "${task.name}": ${e.message}`);
				throw e;
			}
		}
		return out;
	};

	const sameContent = async (bytes: ArrayBuffer, folder: string, stem: string): Promise<string | null> => {
		for (const kindFolder of Object.values(KIND_FOLDER)) {
			const dir = app.vault.getAbstractFileByPath(`${folder}/${kindFolder}/${stem}`);
			if (!(dir instanceof TFolder)) continue;
			for (const f of dir.children) {
				if (f instanceof TFile && f.stat.size === bytes.byteLength && equalBytes(await app.vault.readBinary(f), bytes)) return f.path;
			}
		}
		return null;
	};

	const saveFiles = async (fetched: { task: FileTask; bytes: ArrayBuffer }[], folder: string, stem: string): Promise<void> => {
		for (const { task, bytes } of fetched) {
			const existing = await sameContent(bytes, folder, stem);
			if (existing) {
				g.fileIndex[task.fileUuid] = existing;
				result.filesDeduped++;
				continue;
			}
			const dir = `${folder}/${KIND_FOLDER[task.kind]}/${stem}`;
			await ensureFolder(app, dir);
			const path = `${dir}/${freeFileName(app, dir, safeFileName(task.name), numbered)}`;
			await createNew(app, path, bytes);
			g.fileIndex[task.fileUuid] = path;
			result.filesSaved++;
		}
		await plugin.saveSettings();
	};

	try {
		const base = cleanFolder(g.folder);
		if (!base) throw new StopError('The ChatGPT folder setting is empty or invalid.');
		progress('connecting…');
		const a = await GptApi.connect();
		api = a;

		// 1. Both chat lists (normal + "tpp"), 20 at a time.
		const raw: GptListItem[] = [];
		for (const tpp of [false, true]) {
			let offset = 0;
			for (let page = 0; ; page++) {
				if (page >= MAX_PAGES) throw new StopError('ChatGPT chat list did not end – stopped.');
				await sleep(delayMs);
				const p = checkGptList((await a.get(a.listPath(offset, tpp))).json);
				raw.push(...p.items);
				offset += p.items.length;
				// chatgpt.com's "total" only says "seen so far + 1" (2026-11-06) – so no percentage here.
				progress(`reading chat list… ${raw.length} chats`);
				if (p.items.length === 0 || offset >= p.total) break;
			}
		}

		// 2. Project names.
		await sleep(delayMs);
		const sidebar = checkGptSidebar((await a.get(a.sidebarPath)).json);
		result.projectsCut = sidebar.more;
		const items = dedupe(toListItems(raw, sidebar.projects));
		result.listed = items.length;

		// 3. Project filter, then only new or changed chats.
		const recent = g.recentFolderName || DEFAULT_RECENT;
		const kept = g.onlyProjects ? filterByProjects(items, g.projects, recent) : items;
		result.filteredOut = items.length - kept.length;
		const todoAll = pickTodo(kept, g.index);
		result.unchanged = kept.length - todoAll.length;
		const todo = s.maxChatsPerRun > 0 ? todoAll.slice(0, s.maxChatsPerRun) : todoAll;
		result.leftForLater = todoAll.length - todo.length;

		// 4. Folders.
		await ensureFolder(app, base);
		if (g.projectSubfolders) {
			for (const name of projectFolderNames(kept, recent)) {
				const path = `${base}/${name}`;
				if (!app.vault.getAbstractFileByPath(path)) {
					await ensureFolder(app, path);
					result.foldersCreated.push(path);
				}
			}
		}
		const folderFor = (item: ListItem) => (g.projectSubfolders ? `${base}/${projectSubfolder(item, recent)}` : base);

/**
		 * The whole chat from chatgpt.com: the chat answer (newest turns), then older parts
		 * one by one ("before" = oldest message so far) until the beginning. Null if longer
		 * than MAX_OLDER parts (logged, never half-saved).
		 */
		const loadChat = async (item: ListItem): Promise<{ chat: GptChat; main: ArrayBuffer; older: ArrayBuffer[] } | null> => {
			await sleep(delayMs);
			const r = await a.get(a.chatPath(item.uuid));
			const first = checkGptChat(r.json, item.uuid);
			const pages: GptChat['messages'][] = [];
			const older: ArrayBuffer[] = [];
			let info = first.page_info;
			while (info?.has_previous_page) {
				if (older.length >= MAX_OLDER) {
					result.tooLong.push(item.name);
					return null;
				}
				if (!isMessageId(info.start_cursor)) throw new ShapeError('ChatGPT chat: "page_info.start_cursor" missing although older messages exist');
				progress(`loading older part ${older.length + 1} of "${item.name}"`);
				await sleep(delayMs);
				const p = await a.get(a.olderPath(item.uuid, info.start_cursor));
				const page = checkGptOlderPage(p.json);
				if (page.page_info?.start_cursor === info.start_cursor) throw new ShapeError('ChatGPT older messages: paging does not move on');
				pages.push(page.messages);
				older.push(p.bytes);
				info = page.page_info;
			}
			return { chat: joinParts(first, pages.map((messages) => ({ messages }))), main: r.bytes, older };
		};

		/** The chat as saved in the vault (main file + older parts), or null if a part is missing/unreadable. */
		const readSaved = async (item: ListItem, entry: IndexEntry): Promise<GptChat | null> => {
			try {
				const main = checkGptChat(JSON.parse(await app.vault.adapter.read(entry.json)), item.uuid);
				const pages = [];
				for (const p of entry.older ?? []) {
					if (!exists(p)) return null;
					pages.push(checkGptOlderPage(JSON.parse(await app.vault.adapter.read(p))));
				}
				return joinParts(main, pages);
			} catch {
				return null;
			}
		};

		// 5. Fetch and write each new/changed chat.
		const done = new Set<string>();
		for (const [i, { item, isUpdate }] of todo.entries()) {
			progress(`${i + 1} of ${todo.length} chats: ${item.name}`, i, todo.length);
			const folder = folderFor(item);
			await ensureFolder(app, folder);
			const loaded = await loadChat(item);
			if (!loaded) continue;
			const { chat } = loaded;
			// Files BEFORE writing anything, so a stop leaves no half-written chat.
			const fetched = g.downloadFiles ? await fetchFiles(a, item.uuid, gptChatFiles(chat).filter(isMissing)) : [];

			let stem = baseName(item.created_at, item.name);
			if (isUpdate) stem = `${stem} (updated ${localStamp(item.updated_at)})`;
			stem = freeStem(app, folder, stem, item.uuid);
			const jsonPath = `${folder}/${stem}.json`;
			const mdPath = `${folder}/${stem}.md`;
			await createNew(app, jsonPath, loaded.main); // exact bytes from chatgpt.com
			const olderPaths: string[] = [];
			for (const [n, bytes] of loaded.older.entries()) {
				const p = olderPartPath(folder, stem, n + 1);
				await createNew(app, p, bytes); // exact bytes too
				olderPaths.push(p);
			}
			await saveFiles(fetched, folder, stem);
			await createNew(app, mdPath, transcript(chat, item, stem));

			g.index[item.uuid] = { updated_at: item.updated_at, json: jsonPath, md: mdPath, synced: new Date().toISOString(), ...(olderPaths.length ? { older: olderPaths } : {}) };
			await plugin.saveSettings();
			done.add(item.uuid);
			result.written.push(stem);
			if (isUpdate) result.changedCount++;
			else result.newCount++;
		}

		const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
		const stemOf = (p: string) => (p.split('/').pop() ?? '').replace(/\.(json|md)$/, '');

		// 6. Restore deleted .json/.md/older parts, and 7. fetch files missing for synced chats.
		progress('checking older chats…');
		for (const [k, item] of kept.entries()) {
			if (k % 25 === 0) progress(`checking older chats… ${k} of ${kept.length}`, k, kept.length);
			const entry = g.index[item.uuid];
			if (!entry || done.has(item.uuid)) continue;
			const mdOk = exists(entry.md);

			// Saved copy complete? Otherwise fetch the chat again (and write only what is missing).
			let chat = exists(entry.json) ? await readSaved(item, entry) : null;
			let loaded: Awaited<ReturnType<typeof loadChat>> = null;
			if (!chat) {
				if (exists(entry.json) && (entry.older ?? []).every(exists)) continue; // unreadable saved JSON: never touch it
				loaded = await loadChat(item);
				if (!loaded) continue;
				chat = loaded.chat;
			}

			let folder: string;
			let stem: string;
			if (exists(entry.json) || mdOk) {
				const keep = exists(entry.json) ? entry.json : entry.md;
				folder = dirOf(keep);
				stem = stemOf(keep);
			} else {
				folder = folderFor(item);
				await ensureFolder(app, folder);
				stem = freeStem(app, folder, baseName(item.created_at, item.name), item.uuid);
			}

			const missing = g.downloadFiles ? gptChatFiles(chat).filter(isMissing) : [];
			if (!loaded && mdOk && missing.length === 0) continue;
			const fetched = missing.length ? await fetchFiles(a, item.uuid, missing) : [];

			const jsonPath = `${folder}/${stem}.json`;
			const mdPath = `${folder}/${stem}.md`;
			let restoredSomething = !mdOk;
			let olderPaths = entry.older;
			if (loaded) {
				if (!exists(jsonPath)) {
					await createNew(app, jsonPath, loaded.main);
					restoredSomething = true;
				}
				olderPaths = [];
				for (const [n, bytes] of loaded.older.entries()) {
					const was = entry.older?.[n];
					const p = was && dirOf(was) === folder ? was : olderPartPath(folder, stem, n + 1);
					if (!exists(p)) {
						await createNew(app, p, bytes);
						restoredSomething = true;
					}
					olderPaths.push(p);
				}
			}
			await saveFiles(fetched, folder, stem);
			if (!exists(mdPath)) await createNew(app, mdPath, transcript(chat, item, stem));
			g.index[item.uuid] = { ...entry, json: jsonPath, md: mdPath, ...(olderPaths?.length ? { older: olderPaths } : {}) };
			await plugin.saveSettings();
			if (restoredSomething) result.restored.push(stem);
			else if (fetched.length) result.backfilledChats++;
		}
	} catch (e) {
		if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `Unexpected JSON shape (${e.message}). chatgpt.com may have changed its internal API – nothing more was written.`;
		else {
			const msg = e instanceof Error ? e.message : String(e);
			result.stopped = api ? api.redact(msg) : msg.replace(/Bearer\s+\S+/gi, 'Bearer [hidden]');
		}
	}

	await writeLog(plugin, result);
	return result;
}

async function writeLog(plugin: AIChatBridge, r: GptSyncResult): Promise<void> {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.filteredOut) parts.push(`${r.filteredOut} skipped (other projects)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	if (r.filesSaved) parts.push(`${r.filesSaved} files saved${r.backfilledChats ? ` (incl. files for ${r.backfilledChats} older chats)` : ''}`);
	if (r.filesDeduped) parts.push(`${r.filesDeduped} files already there (not copied)`);
	if (r.filesSkipped.length) parts.push(`files not saved: ${r.filesSkipped.join(', ')}`);
	if (r.tooLong.length) parts.push(`too long to load in one piece, skipped: ${r.tooLong.join(', ')}`);
	if (r.projectsCut) parts.push('more projects exist than chatgpt.com listed – chats in unlisted projects use the project ID as folder name');
	if (r.foldersCreated.length) parts.push(`new folders: ${r.foldersCreated.map((f) => f.split('/').slice(-2).join('/')).join(', ')}`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – **ChatGPT:** ${parts.join(', ')}`;
	if (r.written.length) {
		const shown = r.written.slice(0, 20).map((w) => `[[${w}]]`).join(', ');
		line += `: ${shown}${r.written.length > 20 ? ` +${r.written.length - 20} more` : ''}`;
	}
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
