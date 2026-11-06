// One sync run: list -> filter -> fetch new/changed -> write files -> log.

import type AIChatBridge from './main';
import { ClaudeApi, redact, StopError } from './api';
import { checkChat, checkListPage, ShapeError } from './schema';
import { DEFAULT_RECENT, dedupe, filterByProjects, pickTodo, projectFolderNames, projectSubfolder, targetFor } from './select';
import { baseName, dailyNoteName, localStamp } from './naming';
import { renderTranscript } from './transcript';
import type { Chat } from './types';
import { createNew, ensureFolder, freeFileName, freeStem } from './vaultio';
import { appendLog } from './log';
import { cleanFolder, MIN_DELAY_SECONDS } from './settings';
import { chatFiles, FileTask, KIND_FOLDER, mergeFiles, numbered, safeFileName, visibleFiles } from './files';
import { TFile, TFolder } from 'obsidian';
import { claudeAuth } from './claude-auth';
import type { ProgressFn } from './progress';
import type { ListItem } from './types';

const MAX_PAGES = 200; // 6000 chats; a guard against an endless paging loop

export interface SyncResult {
	listed: number;
	filteredOut: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	written: string[];
	/** Platform values that were routed to the Claude Code folder. */
	otherPlatforms: Set<string>;
	foldersCreated: string[];
	filesSaved: number;
	/** Files not written because a byte-identical copy was already saved for that chat. */
	filesDeduped: number;
	filesSkipped: string[];
	backfilledChats: number;
	/** Chats whose chat-view files could not be read (ReadConversation not 200 JSON). */
	viewNotRead: string[];
	/** Chats whose deleted .json/.md were written again. */
	restored: string[];
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

/** fileIndex values starting with this mean "known, deliberately not saved". */
const SKIPPED = 'skipped: ';

interface Fetched {
	task: FileTask;
	bytes: ArrayBuffer;
}

/**
 * Downloads files one by one (with the polite delay). A file whose size differs
 * from what the chat data says is not saved; it is named in the log instead.
 */
async function fetchFiles(
	api: ClaudeApi,
	tasks: FileTask[],
	delayMs: number,
	result: SyncResult,
	fileIndex: Record<string, string>,
): Promise<Fetched[]> {
	const out: Fetched[] = [];
	for (const task of tasks) {
		await sleep(delayMs);
		let bytes: ArrayBuffer | null;
		try {
			bytes = await api.getFile(task.fileUuid);
		} catch (e) {
			// Name the file in the stop message.
			if (e instanceof StopError) throw new StopError(`While fetching file "${task.name}": ${e.message}`);
			throw e;
		}
		if (bytes === null) {
			result.filesSkipped.push(`${task.name} (not found on claude.ai)`);
			fileIndex[task.fileUuid] = `${SKIPPED}not found (404)`; // don't ask again every run
			continue;
		}
		if (task.sizeBytes !== undefined && bytes.byteLength !== task.sizeBytes) {
			result.filesSkipped.push(`${task.name} (size ${bytes.byteLength} ≠ ${task.sizeBytes})`);
			fileIndex[task.fileUuid] = `${SKIPPED}size mismatch`; // don't download it again every run
			continue;
		}
		out.push({ task, bytes });
	}
	return out;
}

/** `progress` gets short status texts (and how far along) while the sync runs. */
export async function runSync(plugin: AIChatBridge, progress: ProgressFn = () => undefined): Promise<SyncResult> {
	const s = plugin.settings;
	const app = plugin.app;
	const delayMs = Math.max(MIN_DELAY_SECONDS, s.delaySeconds) * 1000;
	const result: SyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], otherPlatforms: new Set(), foldersCreated: [], filesSaved: 0, filesDeduped: 0, filesSkipped: [], backfilledChats: 0, viewNotRead: [], restored: [] };
	const auth = await claudeAuth(plugin);
	const getKey = auth.getKey;

	const exists = (path: string): boolean => app.vault.getAbstractFileByPath(path) instanceof TFile;

	/** Files not saved yet – or saved once and since deleted from the vault. */
	const isMissing = (f: FileTask): boolean => {
		const p = s.fileIndex[f.fileUuid];
		if (p === undefined) return true;
		if (p.startsWith(SKIPPED)) return false; // known to be gone on claude.ai
		return !exists(p);
	};

	/** Some file saved for this chat (in its Artifacts/Attachments folders) was deleted. */
	const chatFileDeleted = (folder: string, stem: string): boolean => {
		const dirs = Object.values(KIND_FOLDER).map((k) => `${folder}/${k}/${stem}/`);
		return Object.values(s.fileIndex).some((p) => !p.startsWith(SKIPPED) && dirs.some((d) => p.startsWith(d)) && !exists(p));
	};

	const savedPath = (id: string): string | undefined => {
		const p = s.fileIndex[id];
		return p && !p.startsWith(SKIPPED) && exists(p) ? p : undefined;
	};

	/** Transcript with links to every saved file of this chat. */
	const transcriptFor = (chat: Chat, item: ListItem, stem: string, visible: FileTask[]): string => {
		const filePaths = new Map<string, string>();
		const inline = new Set<string>();
		for (const f of chatFiles(chat)) {
			inline.add(f.fileUuid);
			const p = savedPath(f.fileUuid);
			if (p) filePaths.set(f.fileUuid, p);
		}
		// Files only the chat view knows get their own "Files" section.
		// Compared by saved path too: one file can have two IDs (deduplicated to one path).
		const linked = new Set(filePaths.values());
		const extraFiles: { name: string; path: string }[] = [];
		for (const f of visible) {
			const p = savedPath(f.fileUuid);
			if (!p || inline.has(f.fileUuid) || linked.has(p)) continue;
			linked.add(p);
			extraFiles.push({ name: f.name, path: p });
		}
		return renderTranscript(chat, { projectName: item.project?.name, jsonFileName: `${stem}.json`, filePaths, extraFiles });
	};

	/** Chat-view files via ReadConversation, or null if claude.ai would not say. */
	const readVisible = async (api: ClaudeApi, item: ListItem, name: string): Promise<FileTask[] | null> => {
		await sleep(delayMs);
		const rc = await api.readConversation(item.uuid);
		if (rc === null) {
			result.viewNotRead.push(name);
			return null;
		}
		return visibleFiles(rc);
	};

	/**
	 * A byte-identical file already saved for this chat (claude.ai sometimes gives the
	 * same file different IDs in the chat data and in the chat view).
	 */
	const sameContent = async (bytes: ArrayBuffer, folder: string, stem: string): Promise<string | null> => {
		for (const kindFolder of Object.values(KIND_FOLDER)) {
			const dir = app.vault.getAbstractFileByPath(`${folder}/${kindFolder}/${stem}`);
			if (!(dir instanceof TFolder)) continue;
			for (const f of dir.children) {
				if (!(f instanceof TFile) || f.stat.size !== bytes.byteLength) continue;
				if (equalBytes(await app.vault.readBinary(f), bytes)) return f.path;
			}
		}
		return null;
	};

	/** Writes fetched files to <folder>/Artifacts|Attachments/<stem>/ and remembers them. */
	const saveFiles = async (fetched: Fetched[], folder: string, stem: string): Promise<void> => {
		for (const { task, bytes } of fetched) {
			const existing = await sameContent(bytes, folder, stem);
			if (existing) {
				s.fileIndex[task.fileUuid] = existing; // same file, other ID: no copy
				result.filesDeduped++;
				continue;
			}
			const dir = `${folder}/${KIND_FOLDER[task.kind]}/${stem}`;
			await ensureFolder(app, dir);
			const path = `${dir}/${freeFileName(app, dir, safeFileName(task.name), numbered)}`;
			await createNew(app, path, bytes);
			s.fileIndex[task.fileUuid] = path;
			result.filesSaved++;
		}
		await plugin.saveSettings(); // also keeps "skipped" marks
	};

	try {
		if (auth.source === 'none') throw new StopError('Not logged in to claude.ai. Use "Log in to claude.ai" in the plugin settings.');
		const api = new ClaudeApi(auth.orgId, getKey);

		// 1. Read the whole chat list, 30 at a time.
		let items: ListItem[] = [];
		let offset = 0;
		for (let page = 0; ; page++) {
			if (page >= MAX_PAGES) throw new StopError('Chat list did not end after 200 pages – stopped.');
			if (page > 0) await sleep(delayMs);
			const { json } = await api.get(api.listPath(offset));
			const p = checkListPage(json);
			items.push(...p.data);
			progress(`reading chat list… ${items.length} chats`);
			if (!p.has_more || p.data.length === 0) break;
			offset += p.data.length;
		}
		items = dedupe(items);
		result.listed = items.length;

		// 2. Project filter (uses the project info in the list – no extra requests).
		const recent = s.recentFolderName || DEFAULT_RECENT;
		const kept = s.onlyProjects ? filterByProjects(items, s.projects, recent) : items;
		result.filteredOut = items.length - kept.length;

		// 3. Only new or changed chats.
		const todoAll = pickTodo(kept, s.index);
		result.unchanged = kept.length - todoAll.length;
		const todo = s.maxChatsPerRun > 0 ? todoAll.slice(0, s.maxChatsPerRun) : todoAll;
		result.leftForLater = todoAll.length - todo.length;

		// 4. Make sure the folders exist: both base folders, and (if mirroring)
		//    one subfolder per project in scope inside each of them.
		const folders = { chat: cleanFolder(s.chatFolder), code: cleanFolder(s.codeFolder) };
		if (!folders.chat || !folders.code) throw new StopError('The Claude Chat or Claude Code folder setting is empty or invalid.');
		const projectNames = s.projectSubfolders ? projectFolderNames(kept, recent) : [];
		for (const base of [folders.chat, folders.code]) {
			await ensureFolder(app, base);
			for (const name of projectNames) {
				const path = `${base}/${name}`;
				if (!app.vault.getAbstractFileByPath(path)) {
					await ensureFolder(app, path);
					result.foldersCreated.push(path);
				}
			}
		}

		// 5. Fetch and write each chat, into the Claude Chat or Claude Code folder.
		for (const [i, { item, isUpdate }] of todo.entries()) {
			progress(`${i + 1} of ${todo.length} chats: ${item.name}`, i, todo.length);
			const target = targetFor(item);
			const base = folders[target];
			if (!base) throw new StopError(`The ${target === 'chat' ? 'Claude Chat' : 'Claude Code'} folder setting is empty or invalid.`);
			const sub = s.projectSubfolders ? projectSubfolder(item, recent) : '';
			const folder = sub ? `${base}/${sub}` : base;
			if (target === 'code') result.otherPlatforms.add(item.platform ?? '?');
			await ensureFolder(app, folder);
			await sleep(delayMs);
			const raw = await api.get(api.chatPath(item.uuid));
			const chat = checkChat(raw.json, item.uuid);

			// The chat-view files (download cards, ZIPs, renders) come from ReadConversation.
			let visible: FileTask[] = [];
			let outputsChecked: string | undefined;
			if (s.downloadFiles) {
				const v = await readVisible(api, item, chat.name || item.name);
				if (v !== null) {
					visible = v;
					outputsChecked = item.updated_at;
				}
			}

			// Fetch all new files BEFORE writing anything, so a stop leaves no half-written chat.
			const allFiles = mergeFiles(chatFiles(chat), visible);
			const fetched = s.downloadFiles ? await fetchFiles(api, allFiles.filter(isMissing), delayMs, result, s.fileIndex) : [];

			let stem = baseName(chat.created_at, chat.name || item.name);
			if (isUpdate) stem = `${stem} (updated ${localStamp(chat.updated_at)})`;
			stem = freeStem(app, folder, stem, item.uuid);

			const jsonPath = `${folder}/${stem}.json`;
			const mdPath = `${folder}/${stem}.md`;
			await createNew(app, jsonPath, raw.bytes); // exact bytes from claude.ai
			await saveFiles(fetched, folder, stem);
			await createNew(app, mdPath, transcriptFor(chat, item, stem, visible));

			// Remember it right away, so a later stop doesn't lose progress.
			s.index[item.uuid] = { updated_at: item.updated_at, json: jsonPath, md: mdPath, synced: new Date().toISOString(), outputsChecked };
			await plugin.saveSettings();
			result.written.push(stem);
			if (isUpdate) result.changedCount++;
			else result.newCount++;
		}

		const done = new Set(todo.map((t) => t.item.uuid));
		const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
		const stemOf = (p: string) => (p.split('/').pop() ?? '').replace(/\.(json|md)$/, '');

		// 6. Restore: synced chats whose .json and/or .md were deleted from the vault.
		//    A deleted transcript is rewritten from the saved .json (same name, so links stay valid);
		//    a deleted .json is fetched again; if both are gone the chat is synced like a new one.
		progress('checking older chats…');
		for (const item of kept) {
			const entry = s.index[item.uuid];
			if (!entry || done.has(item.uuid)) continue;
			const jsonOk = exists(entry.json);
			const mdOk = exists(entry.md);
			if (jsonOk && mdOk) continue;

			let chat: Chat;
			let rawBytes: ArrayBuffer | null = null;
			if (jsonOk) {
				try {
					chat = checkChat(JSON.parse(await app.vault.adapter.read(entry.json)), item.uuid);
				} catch {
					continue; // unreadable saved JSON: leave it alone
				}
			} else {
				await sleep(delayMs);
				const raw = await api.get(api.chatPath(item.uuid));
				chat = checkChat(raw.json, item.uuid);
				rawBytes = raw.bytes;
			}

			// Where: next to the remaining file, or (both gone) where a new chat would go today.
			let folder: string;
			let stem: string;
			if (jsonOk || mdOk) {
				const keep = jsonOk ? entry.json : entry.md;
				folder = dirOf(keep);
				stem = stemOf(keep);
			} else {
				const base = folders[targetFor(item)]!;
				const sub = s.projectSubfolders ? projectSubfolder(item, recent) : '';
				folder = sub ? `${base}/${sub}` : base;
				await ensureFolder(app, folder);
				stem = freeStem(app, folder, baseName(chat.created_at, chat.name || item.name), item.uuid);
			}

			let visible: FileTask[] = [];
			let outputsChecked = entry.outputsChecked;
			if (s.downloadFiles) {
				const v = await readVisible(api, item, chat.name || item.name);
				if (v !== null) {
					visible = v;
					outputsChecked = item.updated_at;
				}
			}
			const fetched = s.downloadFiles ? await fetchFiles(api, mergeFiles(chatFiles(chat), visible).filter(isMissing), delayMs, result, s.fileIndex) : [];

			const jsonPath = `${folder}/${stem}.json`;
			const mdPath = `${folder}/${stem}.md`;
			if (rawBytes && !exists(jsonPath)) await createNew(app, jsonPath, rawBytes);
			await saveFiles(fetched, folder, stem);
			if (!exists(mdPath)) await createNew(app, mdPath, transcriptFor(chat, item, stem, visible));

			s.index[item.uuid] = { ...entry, json: jsonPath, md: mdPath, outputsChecked };
			await plugin.saveSettings();
			result.restored.push(stem);
			done.add(item.uuid);
		}

		// 7. Backfill: files missing for chats whose .json and .md are in place –
		//    never downloaded yet, or deleted from the vault since. Transcripts stay as they are.
		if (s.downloadFiles) {
			for (const item of kept) {
				const entry = s.index[item.uuid];
				if (!entry || done.has(item.uuid) || !exists(entry.json)) continue;
				let chat: Chat;
				try {
					chat = checkChat(JSON.parse(await app.vault.adapter.read(entry.json)), item.uuid);
				} catch {
					continue; // unreadable saved JSON: skip, never touch it
				}
				const folder = dirOf(entry.json);
				const stem = stemOf(entry.json);
				// Ask the chat view again if this version was never checked, or a saved file is gone.
				let visible: FileTask[] = [];
				let viewRead = false;
				if (entry.outputsChecked !== item.updated_at || chatFileDeleted(folder, stem)) {
					const v = await readVisible(api, item, chat.name || item.name);
					if (v !== null) {
						visible = v;
						viewRead = true;
					}
				}
				const tasks = mergeFiles(chatFiles(chat), visible).filter(isMissing);
				if (tasks.length) {
					const fetched = await fetchFiles(api, tasks, delayMs, result, s.fileIndex);
					await saveFiles(fetched, folder, stem);
					result.backfilledChats++;
				}
				if (viewRead) {
					entry.outputsChecked = item.updated_at;
					await plugin.saveSettings();
				}
			}
		}
	} catch (e) {
		const key = getKey();
		if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `Unexpected JSON shape (${e.message}). claude.ai may have changed its internal API – nothing more was written.`;
		else result.stopped = redact(e instanceof Error ? e.message : String(e), key);
	}

	await writeLog(plugin, result);
	return result;
}

async function writeLog(plugin: AIChatBridge, r: SyncResult): Promise<void> {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.filteredOut) parts.push(`${r.filteredOut} skipped (other projects)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	if (r.filesSaved) parts.push(`${r.filesSaved} files saved${r.backfilledChats ? ` (incl. files for ${r.backfilledChats} older chats)` : ''}`);
	if (r.filesDeduped) parts.push(`${r.filesDeduped} files already there under another ID (not copied)`);
	if (r.viewNotRead.length) parts.push(`chat-view files not readable (will retry): ${r.viewNotRead.join(', ')}`);
	if (r.filesSkipped.length) parts.push(`files not saved: ${r.filesSkipped.join(', ')}`);
	if (r.foldersCreated.length) parts.push(`new folders: ${r.foldersCreated.map((f) => f.split('/').slice(-2).join('/')).join(', ')}`);
	if (r.otherPlatforms.size) parts.push(`to Claude Code folder: platform ${[...r.otherPlatforms].join(', ')}`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – ${parts.join(', ')}`;
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
