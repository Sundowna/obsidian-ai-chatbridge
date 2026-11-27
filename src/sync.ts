// One sync run: list -> filter -> fetch new/changed -> write files -> log.

import { guardMissing } from './missing-guard';
import type AIChatBridge from './main';
import { withAccount } from './accounts';
import type { ClaudeAccount } from './settings';
import { ClaudeApi, redact, StopError } from './api';
import { checkChat, checkListPage, ShapeError } from './schema';
import { OddChats, readOrSkip } from './odd-chats';
import { keepFlags } from './gemini/save';
import { customProjectFolder, DEFAULT_RECENT, dedupe, filterByProjects, nothingSelected, pickTodo, projectFolderNames, targetFor } from './select';
import { baseName, dailyNoteName, tagAccount } from './naming';
import { renderTranscript } from './transcript';
import { chatFolders, dirOf, masterRaw, rawLink } from './raw-folders';
import type { Chat } from './types';
import { createNew, ensureFolder, findFile, freeFileName, freeStem } from './vaultio';
import { appendLog } from './log';
import { addVersion, editsLog, keepVersion, noEdits, noteHash, recordEdit, setNoteFlag, withVersionInfo, writeNote, writeRaw, type EditedReport } from './versions';
import { cleanFolder, MIN_DELAY_SECONDS } from './settings';
import { buildStamp, checkKey, fileStamps, QUICK_SAVE_EVERY } from './quick-check';
import { chatFiles, FileTask, KIND_FOLDER, mergeFiles, numbered, outputFiles, hasPastedText, pastedFiles, safeFileName, visibleFiles, type PasteMode } from './files';
import { TFile, TFolder } from 'obsidian';
import { claudeAuth } from './claude-auth';
import type { ProgressFn } from './progress';
import type { ListItem } from './types';
import { CloudShapeError } from './cloud/claude-cloud';
import { emptyCloudResult, syncClaudeCloud, type CloudSyncResult } from './cloud/sync';
import { archiveRoot } from './archive-folders';
import { ArchiveObservations } from './archive-state';
import { archiveLog, emptyArchiveReport, newArchiveFolders, reconcileArchived, rememberArchiveObservations, type ArchiveReport } from './archive-move';

/** The chat's own files: downloadable ones, and long pasted texts kept in its JSON (issue #64). */
const ownFiles = (chat: Chat, mode?: PasteMode): FileTask[] => [...chatFiles(chat), ...pastedFiles(chat, mode)];

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
	/** Chats whose data had an unexpected shape: skipped, tried again next run. */
	oddChats: string[];
	/** Notes whose starred mark was brought up to date without fetching the chat. */
	flagChanges: number;
	/** claude.ai does not offer the chat view (ReadConversation) for this account's plan. */
	viewUnavailable?: boolean;
	/** Chats whose Claude-made files were looked up by path instead (chat view not offered). */
	outputsRead?: number;
	/** Chats whose deleted .json/.md were written again. */
	restored: string[];
	/** Notes drawn before pasted text was shown, redrawn from their saved .json (issue #64). */
	redrawn: string[];
	/** Notes you had edited whose chat continued. */
	edits: EditedReport;
	stopped?: string;
	/** "Only selected projects" is on with nothing selected, so the sync did not run. */
	nothingSelected?: boolean;
	/** Claude Code cloud sessions (claude.ai/code); also counted in the totals above. */
	cloud?: CloudSyncResult;
	archive?: ArchiveReport;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const stemOf = (p: string) => (p.split('/').pop() ?? '').replace(/\.(json|md)$/, '');

/**
 * The whole chat list, 30 at a time. With `archived` the archived chats are read too
 * (claude.ai lists them apart) and added to the list; a chat in both is kept once.
 */
export async function listAllChats(api: ClaudeApi, delayMs: number, progress: ProgressFn, archived = false, observations?: ArchiveObservations, strict = !!observations): Promise<ListItem[]> {
	const items: ListItem[] = [];
	for (const listArchived of archived ? [false, true] : [false]) {
		let offset = 0;
		for (let page = 0; ; page++) {
			if (page >= MAX_PAGES) throw new StopError(`${listArchived ? 'Archived chat' : 'Chat'} list did not end after 200 pages – stopped.`);
			if (page > 0 || listArchived) await sleep(delayMs);
			const { json } = await api.get(api.listPath(offset, listArchived));
			const p = checkListPage(json);
			if (strict && p.has_more && !p.data.length) throw new ShapeError('Claude chat list ended with more pages expected.');
			for (const item of p.data) observations?.add(item.uuid, listArchived);
			items.push(...p.data);
			progress(`reading ${listArchived ? 'archived chats' : 'chat list'}… ${items.length} chats`);
			if (!p.has_more || p.data.length === 0) break;
			offset += p.data.length;
		}
	}
	return dedupe(items);
}

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
		if (task.text !== undefined) {
			// Text kept in the chat JSON (a "Pasted" card, issue #64): nothing to download.
			out.push({ task, bytes: new TextEncoder().encode(task.text).buffer });
			continue;
		}
		await sleep(delayMs);
		let bytes: ArrayBuffer | null;
		try {
			if (task.output) {
				// A Claude-made file known by its path (issue #46): 404 = gone; any other refusal = try next run.
				const r = await api.getOutputFile(task.output.chatUuid, task.output.path);
				if (r.status !== 200 && r.status !== 404) {
					result.filesSkipped.push(`${task.name} (claude.ai answered ${r.status}, will retry)`);
					continue;
				}
				bytes = r.bytes;
			} else {
				bytes = await api.getFile(task.fileUuid);
			}
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
export async function runSync(plugin: AIChatBridge, account: ClaudeAccount, progress: ProgressFn = () => undefined): Promise<SyncResult> {
	const s = account.web;
	const app = plugin.app;
	const delayMs = Math.max(MIN_DELAY_SECONDS, plugin.settings.delaySeconds) * 1000;
	const result: SyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], otherPlatforms: new Set(), foldersCreated: [], filesSaved: 0, filesDeduped: 0, filesSkipped: [], backfilledChats: 0, viewNotRead: [], oddChats: [], flagChanges: 0, restored: [], redrawn: [], edits: noEdits() };
	const odd = new OddChats();
	if (nothingSelected(s)) return { ...result, nothingSelected: true };
	const auth = await claudeAuth(plugin, account);
	const getKey = auth.getKey;

	const exists = (path: string): boolean => findFile(app, path) instanceof TFile;

	/** Files not saved yet – or saved once and since deleted from the vault. */
	const isMissing = (f: FileTask): boolean => missingId(f.fileUuid);
	const missingId = (id: string): boolean => {
		const p = s.fileIndex[id];
		if (p === undefined) return true;
		if (p.startsWith(SKIPPED)) return false; // known to be gone on claude.ai
		return !exists(p);
	};

	/** Some file saved for this chat (in its Artifacts/Attachments folders) was deleted. */
	const chatFileDeleted = (folder: string, stem: string): boolean => {
		const dirs = Object.values(KIND_FOLDER).map((k) => `${folder}/${k}/${stem}/`);
		return Object.values(s.fileIndex).some((p) => !p.startsWith(SKIPPED) && dirs.some((d) => p.startsWith(d)) && !exists(p));
	};

	/** Files already saved for this chat (its Artifacts/Attachments folders), for a redraw without the chat view. */
	const savedFilesOf = (folder: string, stem: string): FileTask[] => {
		const dirs = Object.values(KIND_FOLDER).map((k) => `${folder}/${k}/${stem}/`);
		return Object.entries(s.fileIndex)
			// Pasted text is drawn from the chat itself, never listed as a chat-view file.
			.filter(([id, p]) => !id.startsWith('pasted:') && !p.startsWith(SKIPPED) && dirs.some((d) => p.startsWith(d)) && exists(p))
			.map(([id, p]) => ({ fileUuid: id, name: p.slice(p.lastIndexOf('/') + 1), kind: 'artifact' as const, isImage: false }));
	};

	const savedPath = (id: string): string | undefined => {
		const p = s.fileIndex[id];
		return p && !p.startsWith(SKIPPED) && exists(p) ? p : undefined;
	};

	/** Transcript with links to every saved file of this chat. */
	const transcriptFor = (chat: Chat, item: ListItem, json: string, mdFolder: string, visible: FileTask[]): string => {
		const filePaths = new Map<string, string>();
		const inline = new Set<string>();
		for (const f of ownFiles(chat, s.pastedText)) {
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
		return tagAccount(renderTranscript(chat, { projectName: item.project?.name, jsonFileName: rawLink(mdFolder, json), filePaths, extraFiles, showReasoning: s.showReasoning === true, pasteMode: s.pastedText }), account.label);
	};

	/** Chat-view files via ReadConversation, or null if claude.ai would not say. */
	const readVisible = async (api: ClaudeApi, item: ListItem, name: string): Promise<FileTask[] | null> => {
		if (!api.chatViewUnavailable) await sleep(delayMs);
		const rc = await api.readConversation(item.uuid);
		if (rc === null && api.chatViewUnavailable) {
			// Not offered for this account (issue #46): the Claude-made files are found by their
			// paths in the chat's tool calls instead, and fetched the way the chat view does.
			result.viewUnavailable = true;
			await sleep(delayMs);
			const withTools = await api.chatWithTools(item.uuid);
			if (withTools === null) {
				result.viewNotRead.push(name);
				return null;
			}
			result.outputsRead = (result.outputsRead ?? 0) + 1;
			return outputFiles(withTools, item.uuid);
		}
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
			const dir = findFile(app, `${folder}/${kindFolder}/${stem}`);
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
		if (auth.source === 'none') throw new StopError('Not logged in to claude.ai. Select "Log in" for this account in the plugin settings.');
		const api = new ClaudeApi(auth.orgId, getKey, { provider: 'claude', accountId: account.id }, auth.transport);

		// 1. Read the whole chat list, 30 at a time.
		const observations = s.includeArchived === true ? new ArchiveObservations() : undefined;
		if (observations && s.separateArchived === true) {
			result.archive = emptyArchiveReport();
			progress('checking archived status…');
		}
		const items = await listAllChats(api, delayMs, progress, s.includeArchived === true, observations, !!result.archive);
		result.listed = items.length;

		// 2. Project filter (uses the project info in the list – no extra requests).
		const recent = s.recentFolderName || DEFAULT_RECENT;
		const kept = s.onlyProjects ? filterByProjects(items, s.projects, recent) : items;
		result.filteredOut = items.length - kept.length;

		// 3. Only new or changed chats.
		const todoAll = pickTodo(kept, s.index);
		result.unchanged = kept.length - todoAll.length;
		const maxChats = plugin.settings.maxChatsPerRun;

		// Before anything is written: many saved chats missing means a wrong sync history, not deletions.
		const savedChats = Object.values(s.index).filter((entry) => !entry.archiveMove);
		guardMissing('claude.ai chats', savedChats.length, savedChats.filter((e) => !exists(e.md) || !exists(e.json)).length);

		// 4. Make sure the folders exist: both base folders, and (if mirroring)
		//    one subfolder per project in scope inside each of them.
		const folders = { chat: cleanFolder(s.chatFolder), code: cleanFolder(s.codeFolder) };
		if (!folders.chat || !folders.code) throw new StopError('The Chat or Code Cloud folder setting is empty or invalid.');
		const rawSetting = { chat: s.chatRawFolder, code: s.codeRawFolder };
		const rawRoot = masterRaw(plugin.settings);
		const root = archiveRoot(plugin.settings, 'claude', account.id, folders.chat);
		const filing = (item: ListItem) => ({
			base: folders.chat!, root, projectSubfolders: s.projectSubfolders, rawSetting: rawSetting.chat, rawRoot,
			projectRaw: customProjectFolder(item, { ...s, projectFolders: s.projectRawFolders }, recent),
			active: chatFolders(item, s, folders.chat!, rawSetting.chat, recent, rawRoot),
		});
		const archived = (item: ListItem) => !!result.archive && targetFor(item) === 'chat' && observations?.get(item.uuid) === true;
		if (observations) {
			const webChats = kept.filter((item) => targetFor(item) === 'chat');
			const state = (id: string) => observations.get(id);
			if (result.archive) await reconcileArchived(plugin, { items: webChats, web: s, state, filing, progress }, result.archive);
			else await rememberArchiveObservations(plugin, s.index, webChats, state);
		}
		const ready = todoAll.filter(({ item, isUpdate }) => !s.index[item.uuid]?.archiveMove && (isUpdate || !result.archive || targetFor(item) !== 'chat' || observations?.get(item.uuid) !== null));
		const todo = maxChats > 0 ? ready.slice(0, maxChats) : ready;
		result.leftForLater = todoAll.length - todo.length;
		// Starred or unstarred since: where the chat list says so, only that property changes in the note.
		result.flagChanges = await keepFlags(plugin, kept.filter((it) => typeof it.is_starred === 'boolean'), s.index, new Set(todoAll.map((t) => t.item.uuid)), { key: 'starred', of: (it) => it.is_starred === true });
		/** Transcript and raw folders for a chat, as the settings say today. */
		const foldersOf = (item: ListItem) => {
			const target = targetFor(item);
			return archived(item) ? newArchiveFolders(filing(item)) : chatFolders(item, s, folders[target]!, rawSetting[target], recent, rawRoot);
		};
		// Chats with a project folder of their own need no subfolder in the base folders.
		const projectNames = s.projectSubfolders ? projectFolderNames(kept.filter((item) => !archived(item) && customProjectFolder(item, s, recent) === null), recent) : [];
		for (const base of [folders.chat, folders.code]) {
			await ensureFolder(app, base);
			for (const name of projectNames) {
				const path = `${base}/${name}`;
				if (!findFile(app, path)) {
					await ensureFolder(app, path);
					result.foldersCreated.push(path);
				}
			}
		}

		// 5. Fetch and write each chat, into the Claude Chat or Claude Code folder.
		for (const [i, { item, isUpdate }] of todo.entries()) {
			progress(`${i + 1} of ${todo.length} chats: ${item.name}`, i, todo.length);
			const target = targetFor(item);
			if (!folders[target]) throw new StopError(`The ${target === 'chat' ? 'Chat' : 'Code Cloud'} folder setting is empty or invalid.`);
			// A chat that continues keeps its one note, where it is now; only a new chat is given a place.
			const before = isUpdate ? s.index[item.uuid] : undefined;
			const today = foldersOf(item);
			const folder = before ? dirOf(before.md) : today.md;
			const rawFolder = before ? dirOf(before.json) : today.raw;
			for (const f of new Set([folder, rawFolder])) {
				if (!findFile(app, f) && !result.foldersCreated.includes(f)) result.foldersCreated.push(f);
			}
			if (target === 'code') result.otherPlatforms.add(item.platform ?? '?');
			await ensureFolder(app, folder);
			await ensureFolder(app, rawFolder);
			await sleep(delayMs);
			const raw = await api.get(api.chatPath(item.uuid));
			// One chat in an odd shape is skipped and tried again next run; the third one stops the sync.
			const chat = await readOrSkip(odd, item.name, () => checkChat(raw.json, item.uuid));
			if (!chat) {
				result.oddChats.push(item.name);
				continue;
			}

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
			const allFiles = mergeFiles(ownFiles(chat, s.pastedText), visible);
			const fetched = s.downloadFiles ? await fetchFiles(api, allFiles.filter(isMissing), delayMs, result, s.fileIndex) : [];

			const stem = before ? stemOf(before.json) : freeStem(app, folder, baseName(chat.created_at, chat.name || item.name), item.uuid, rawFolder);
			const jsonPath = before?.json ?? `${rawFolder}/${stem}.json`;
			const mdPath = before?.md ?? `${folder}/${stem}.md`;
			// The version saved before stays in the raw folder; then the exact bytes from claude.ai.
			const versions = addVersion(before, before ? await keepVersion(app, [before.json], before.updated_at, raw.bytes) : null);
			await writeRaw(app, jsonPath, raw.bytes);
			await saveFiles(fetched, folder, stem);
			const note = await writeNote(app, mdPath, withVersionInfo(transcriptFor(chat, item, jsonPath, folder, visible), versions, folder), { policy: plugin.settings.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced });
			recordEdit(result.edits, note, mdPath);
			// A star taken away since the last version must not stay in the note as if you had added it.
			await setNoteFlag(app, mdPath, 'starred', chat.is_starred === true);

			// Remember it right away, so a later stop doesn't lose progress.
			const archive = before ? before.archive : archived(item) ? { root, active: filing(item).active } : undefined;
			const observed = observations?.get(item.uuid);
			const archiveObservation = observed !== undefined ? observed : typeof chat.is_archived === 'boolean' ? chat.is_archived : before?.archiveObservation;
			s.index[item.uuid] = { updated_at: item.updated_at, json: jsonPath, md: mdPath, synced: new Date().toISOString(), outputsChecked, versions, noteHash: note.hash, flagged: chat.is_starred === true, archiveObservation, pastes: 1, ...(archive ? { archive } : {}) };
			await plugin.saveSettings();
			result.written.push(stemOf(mdPath));
			if (isUpdate) result.changedCount++;
			else result.newCount++;
		}

		const done = new Set(todo.map((t) => t.item.uuid));

		// 6. Restore: synced chats whose .json and/or .md were deleted from the vault.
		//    A deleted transcript is rewritten from the saved .json (same name, so links stay valid);
		//    a deleted .json is fetched again; if both are gone the chat is synced like a new one.
		progress('checking older chats…');
		for (const item of kept) {
			const entry = s.index[item.uuid];
			if (!entry || entry.archiveMove || done.has(item.uuid)) continue;
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
				const read = await readOrSkip(odd, item.name, () => checkChat(raw.json, item.uuid));
				if (!read) {
					result.oddChats.push(item.name);
					continue;
				}
				chat = read;
				rawBytes = raw.bytes;
			}

			// Where: with the remaining file's name. A missing file goes next to the other one,
			// or – when raw files have a folder of their own – where the settings put it today.
			// Both gone: where a new chat would go today.
			const today = foldersOf(item);
			const split = today.md !== today.raw;
			let folder: string;
			let rawFolder: string;
			let stem: string;
			if (jsonOk || mdOk) {
				stem = stemOf(jsonOk ? entry.json : entry.md);
				folder = dirOf(entry.md); // a deleted note comes back where it was, under its own name
				rawFolder = jsonOk ? dirOf(entry.json) : split ? today.raw : dirOf(entry.md);
			} else {
				folder = today.md;
				rawFolder = today.raw;
				stem = freeStem(app, folder, baseName(chat.created_at, chat.name || item.name), item.uuid, rawFolder);
			}
			await ensureFolder(app, folder);
			await ensureFolder(app, rawFolder);

			let visible: FileTask[] = [];
			let outputsChecked = entry.outputsChecked;
			if (s.downloadFiles) {
				const v = await readVisible(api, item, chat.name || item.name);
				if (v !== null) {
					visible = v;
					outputsChecked = item.updated_at;
				}
			}
			const fetched = s.downloadFiles ? await fetchFiles(api, mergeFiles(ownFiles(chat, s.pastedText), visible).filter(isMissing), delayMs, result, s.fileIndex) : [];

			const jsonPath = jsonOk ? entry.json : `${rawFolder}/${stem}.json`;
			const mdPath = jsonOk || mdOk ? entry.md : `${folder}/${stem}.md`;
			if (rawBytes && !exists(jsonPath)) await createNew(app, jsonPath, rawBytes);
			await saveFiles(fetched, folder, stem);
			let restoredHash = entry.noteHash;
			let drawn = entry.pastes;
			if (!exists(mdPath)) {
				const md = withVersionInfo(transcriptFor(chat, item, jsonPath, folder, visible), entry.versions, folder);
				await createNew(app, mdPath, md);
				restoredHash = noteHash(md);
				drawn = 1;
			}

			s.index[item.uuid] = { ...entry, json: jsonPath, md: mdPath, outputsChecked, noteHash: restoredHash, ...(drawn ? { pastes: drawn } : {}) };
			await plugin.saveSettings();
			result.restored.push(stem);
			done.add(item.uuid);
		}

		// 7. Backfill: files missing for chats whose .json and .md are in place –
		//    never downloaded yet, or deleted from the vault since. Transcripts stay as they are.
		if (s.downloadFiles) {
			const build = await buildStamp(app, plugin.manifest);
			let quickUnsaved = 0;
			for (const item of kept) {
				const entry = s.index[item.uuid];
				if (!entry || entry.archiveMove || done.has(item.uuid) || !exists(entry.json)) continue;
				// Files live next to the transcript (the raw .json may have a folder of its own).
				const folder = dirOf(exists(entry.md) ? entry.md : entry.json);
				const stem = stemOf(entry.json);
				// Same raw file as at the last full check, its chat view read, every file still there:
				// nothing to do, so the .json is not read (quick-check.ts).
				const key = checkKey([build, item.updated_at, entry.json, await fileStamps(app, [entry.json])]);
				const settled = entry.outputsChecked === item.updated_at && !chatFileDeleted(folder, stem);
				if (key && settled && entry.quick?.key === key && !entry.quick.files.some(missingId)) continue;
				let chat: Chat;
				try {
					chat = checkChat(JSON.parse(await app.vault.adapter.read(entry.json)), item.uuid);
				} catch {
					continue; // unreadable saved JSON: skip, never touch it
				}
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
				const tasks = mergeFiles(ownFiles(chat, s.pastedText), visible).filter(isMissing);
				if (tasks.length) {
					const fetched = await fetchFiles(api, tasks, delayMs, result, s.fileIndex);
					await saveFiles(fetched, folder, stem);
					result.backfilledChats++;
				}
				const files = ownFiles(chat, s.pastedText).map((f) => f.fileUuid);
				const quick = key ? { files, key } : undefined;
				if (viewRead) entry.outputsChecked = item.updated_at;
				const keyChanged = JSON.stringify(entry.quick) !== JSON.stringify(quick);
				if (keyChanged) {
					if (quick) entry.quick = quick;
					else delete entry.quick;
				}
				// A new key alone is saved in batches; a read chat view right away, as before.
				if (viewRead || (keyChanged && ++quickUnsaved >= QUICK_SAVE_EVERY)) {
					quickUnsaved = 0;
					await plugin.saveSettings();
				}
			}
			if (quickUnsaved) await plugin.saveSettings();
		}

		// 7b. Notes drawn before pasted text was shown (issue #64): each saved .json is read once
		//     (no request to claude.ai); a chat with pasted text gets its note redrawn. Your edits
		//     follow "When an edited note gets an update". Then the chat is marked and never read again for this.
		let unmarked = 0;
		for (const item of kept) {
			const entry = s.index[item.uuid];
			if (!entry || entry.pastes || entry.archiveMove || done.has(item.uuid) || !exists(entry.json) || !exists(entry.md)) continue;
			let chat: Chat;
			try {
				chat = checkChat(JSON.parse(await app.vault.adapter.read(entry.json)), item.uuid);
			} catch {
				continue; // unreadable saved JSON: skip, never touch it
			}
			entry.pastes = 1;
			if (!hasPastedText(chat)) {
				if (++unmarked >= QUICK_SAVE_EVERY) {
					unmarked = 0;
					await plugin.saveSettings();
				}
				continue;
			}
			progress(`adding pasted text: ${chat.name || item.name}`);
			const folder = dirOf(entry.md);
			const md = withVersionInfo(transcriptFor(chat, item, entry.json, folder, savedFilesOf(folder, stemOf(entry.json))), entry.versions, folder);
			const note = await writeNote(app, entry.md, md, { policy: plugin.settings.editedNotes, lastHash: entry.noteHash, lastSynced: entry.synced, keep: ['unread'] });
			recordEdit(result.edits, note, entry.md);
			entry.noteHash = note.hash;
			if (note.outcome === 'updated') result.redrawn.push(stemOf(entry.md));
			unmarked = 0;
			await plugin.saveSettings(); // right away: the new fingerprint must not be lost
		}
		if (unmarked) await plugin.saveSettings();

		// 8. Claude Code sessions run in the cloud (claude.ai/code), into the Code Cloud folder.
		if (s.cloudSessions) {
			const cloud = (result.cloud = emptyCloudResult());
			try {
				await syncClaudeCloud({ app, settings: plugin.settings, account, api, delayMs, progress, save: () => plugin.saveSettings(), sleep }, cloud);
			} finally {
				addCloud(result, cloud);
			}
		}
	} catch (e) {
		const key = getKey();
		if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof CloudShapeError) result.stopped = `Unexpected Claude Code session data (${e.message}). claude.ai may have changed its internal API – nothing more was written.`;
		else if (e instanceof ShapeError) result.stopped = `Unexpected JSON shape (${e.message}). claude.ai may have changed its internal API – nothing more was written.`;
		else result.stopped = redact(e instanceof Error ? e.message : String(e), key);
	}

	await writeLog(plugin, account, result);
	return result;
}

/** Cloud sessions count in the run's totals (notices, log); the log names them too. */
function addCloud(r: SyncResult, c: CloudSyncResult): void {
	r.listed += c.listed;
	r.unchanged += c.unchanged;
	r.newCount += c.newCount;
	r.changedCount += c.changedCount;
	r.leftForLater += c.leftForLater;
	r.written.push(...c.written);
	r.restored.push(...c.restored);
	r.edits.copies.push(...c.edits.copies);
	r.edits.kept.push(...c.edits.kept);
	r.filesSaved += c.filesSaved;
}

async function writeLog(plugin: AIChatBridge, account: ClaudeAccount, r: SyncResult): Promise<void> {
	// Named only once there are several accounts; a single account's log reads as before.
	const who = plugin.settings.claude.length > 1 ? `**${withAccount('claude.ai', plugin.settings.claude, account)}:** ` : '';
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.archive) parts.push(...archiveLog(r.archive));
	if (r.filteredOut) parts.push(`${r.filteredOut} skipped (other projects)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	if (r.redrawn.length) parts.push(`${r.redrawn.length} older notes redrawn with their pasted text: ${r.redrawn.map((w) => `[[${w}]]`).join(', ')}`);
	parts.push(...editsLog(r.edits));
	if (r.filesSaved) parts.push(`${r.filesSaved} files saved${r.backfilledChats ? ` (incl. files for ${r.backfilledChats} older chats)` : ''}`);
	if (r.filesDeduped) parts.push(`${r.filesDeduped} files already there under another ID (not copied)`);
	if (r.viewUnavailable) {
		parts.push(r.outputsRead
			? `chat-view files: claude.ai does not offer them for this account, Claude-made files looked up by path instead (${r.outputsRead} chats)`
			: 'chat-view files: claude.ai does not offer them for this account, chats saved without them');
	}
	if (r.flagChanges) parts.push(`starred updated on ${r.flagChanges} note${r.flagChanges === 1 ? '' : 's'}`);
	if (r.oddChats.length) parts.push(`could not read (will retry): ${r.oddChats.join(', ')}`);
	if (r.viewNotRead.length) parts.push(`chat-view files not readable (will retry): ${r.viewNotRead.join(', ')}`);
	if (r.filesSkipped.length) parts.push(`files not saved: ${r.filesSkipped.join(', ')}`);
	if (r.foldersCreated.length) parts.push(`new folders: ${r.foldersCreated.map((f) => f.split('/').slice(-2).join('/')).join(', ')}`);
	if (r.otherPlatforms.size) parts.push(`to Code Cloud folder: platform ${[...r.otherPlatforms].join(', ')}`);
	if (r.cloud && (r.cloud.written.length || r.cloud.restored.length)) parts.push(`incl. ${r.cloud.written.length + r.cloud.restored.length} Claude Code cloud sessions`);
	if (r.cloud?.running) parts.push(`${r.cloud.running} Claude Code cloud sessions still running (saved when done)`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – ${who}${parts.join(', ')}`;
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
