// Preserve each conversation capture before downloading its assets. The saved
// index and capture journal let the next run continue after a stop.

import { guardMissing } from '../missing-guard';
import { TFile, TFolder } from 'obsidian';
import type AIChatBridge from '../main';
import { loginRef, withAccount } from '../accounts';
import type { ChatgptAccount } from '../settings';
import { StopError } from '../api';
import { ShapeError } from '../schema';
import { customProjectFolder, DEFAULT_RECENT, filterByProjects, nothingSelected, projectFolderNames } from '../select';
import { baseName, dailyNoteName, safeTitle, tagAccount, untagAccount } from '../naming';
import { createNew, ensureFolder, findFile, freeFileName, freeStem } from '../vaultio';
import { appendLog } from '../log';
import { addVersion, editsLog, keepVersion, noEdits, recordEdit, withVersionInfo, writeNote, writeRaw, type EditedReport } from '../versions';
import { cleanFolder, MIN_DELAY_SECONDS } from '../settings';
import { KIND_FOLDER, numbered, safeFileName } from '../files';
import type { IndexEntry, ListItem } from '../types';
import { BlockedLinkError, GptApi } from './api';
import { pastedSession } from '../cookies';
import { checkGptChat, checkGptFileInfo, checkGptOlderPage, checkGptSidebar, isGptFileGone, isMessageId } from './schema';
import { joinParts, olderPartPath } from './parts';
import { toListItems } from './select';
import { gptChatFiles, type GptFileTask } from './files';
import { automaticRetryDeadline, fingerprint, GptRateLimitError, retryAsset, type Capture } from './recovery';
import { accountInventory, compareRevision, completeInventoryJob, DEFAULT_OVERLAP_MINUTES, scanInventory, type ScanStats } from './inventory';
import { renderGptTranscript } from './transcript';
import { buildStamp, checkKey, fileStamps, QUICK_SAVE_EVERY } from '../quick-check';
import { chatFolders, masterRaw, rawLink } from '../raw-folders';
import type { GptChat, GptListItem, GptProject } from './types';
import type { ProgressFn } from '../progress';
import { archiveRoot } from '../archive-folders';
import { ArchiveObservations } from '../archive-state';
import { archiveLog, emptyArchiveReport, newArchiveFolders, reconcileArchived, rememberArchiveObservations, type ArchiveReport } from '../archive-move';
import { CodexCloudShapeError } from '../cloud/codex-cloud';
import { syncCodexCloud } from '../cloud/codex-sync';
import { recordError } from '../error-log';
import { emptyCloudResult, type CloudSyncResult } from '../cloud/sync';

const MAX_PAGES = 300; // 6000 chats per list; a guard against an endless paging loop
const MAX_OLDER = 200; // older parts per chat (10 turns each)
const SKIPPED = 'skipped: ';
const MAX_ASSET_ATTEMPTS = 24;

export interface GptSyncResult {
	archive?: ArchiveReport;
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
	pendingAssets: number;
	refreshedViews: number;
	/** Notes you had edited whose chat continued or was rendered again. */
	edits: EditedReport;
	listingRequests: number;
	projectRequests: number;
	fullLists: number;
	incrementalLists: number;
	resumeAt?: number;
	stopped?: string;
	/** "Only selected projects" is on with nothing selected, so the sync did not run. */
	nothingSelected?: boolean;
	/** Codex cloud tasks (chatgpt.com/codex); also counted in the totals above. */
	codexCloud?: CloudSyncResult;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Every project in the sidebar. `cut` = it would not stop listing, so some may be missing. */
export async function listAllGptProjects(a: GptApi, wait: () => Promise<unknown>, onPage: (page: number) => void): Promise<{ projects: GptProject[]; cut: boolean }> {
	const projects = new Map<string, GptProject>();
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let cut = false;
	let page = 0;
	do {
		await wait();
		onPage(++page);
		const sidebar = checkGptSidebar((await a.get(a.projectPagePath(cursor))).json);
		for (const project of sidebar.projects) projects.set(project.id, project);
		cursor = sidebar.cursor;
		if (!cursor) break;
		if (cursors.has(cursor) || cursors.size >= MAX_PAGES) {
			cut = true;
			break;
		}
		cursors.add(cursor);
	} while (cursor);
	return { projects: [...projects.values()], cut };
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

/** `progress` gets short status texts while the sync runs (shown in a notice). */
export async function runGptSync(plugin: AIChatBridge, account: ChatgptAccount, progress: ProgressFn = () => undefined, forceFull = false): Promise<GptSyncResult> {
	const s = plugin.settings;
	const g = account.web;
	const app = plugin.app;
	const delayMs = Math.max(MIN_DELAY_SECONDS, s.delaySeconds) * 1000;
	const result: GptSyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], foldersCreated: [], filesSaved: 0, filesDeduped: 0, filesSkipped: [], backfilledChats: 0, tooLong: [], projectsCut: false, pendingAssets: 0, refreshedViews: 0, edits: noEdits(), listingRequests: 0, projectRequests: 0, fullLists: 0, incrementalLists: 0 };
	if (nothingSelected(g)) {
		// A waiting retry would otherwise come back here every second.
		if (g.resumeAfter429) {
			delete g.resumeAfter429;
			await plugin.saveSettings();
		}
		return { ...result, nothingSelected: true };
	}
	const scan: ScanStats ={ requests: 0, fullLists: 0, incrementalLists: 0, seen: new Set() };
	let queuedCount = () => 0;
	let fullStillRequested = forceFull || g.resumeAfter429?.forceFull === true;
	const cooldownUntil = g.cooldownUntil ?? 0;
	if (cooldownUntil > Date.now()) {
		g.resumeAfter429 = { consecutive: g.resumeAfter429?.consecutive ?? 1, forceFull: fullStillRequested };
		await plugin.saveSettings();
		result.resumeAt = cooldownUntil;
		result.stopped = `ChatGPT is cooling down until ${new Date(cooldownUntil).toLocaleString()}.`;
		return result;
	}
	let api: GptApi | null = null;
	let requestStage = 'connecting to ChatGPT';
	let requestChat: { item: ListItem; position: string } | undefined;
	let remainingAttempts = MAX_ASSET_ATTEMPTS;
	const pending = g.pendingCaptures ??= {};
	const retries = g.assetRetries ??= {};
	const pendingAssets = new Set<string>();

	const exists = (path: string): boolean => findFile(app, path) instanceof TFile;
	const isMissing = (f: GptFileTask): boolean => missingId(f.fileUuid);
	const missingId = (id: string): boolean => {
		const p = g.fileIndex[id];
		if (p === undefined) return true;
		if (p.startsWith(SKIPPED)) return true;
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
	/** `paths`: where the transcript and the main raw .json are (or will be). */
	const transcript = (chat: GptChat, item: ListItem, paths: { json: string; md: string }) =>
		tagAccount(renderGptTranscript(chat, { projectName: item.project?.name, jsonFileName: rawLink(paths.md.split('/').slice(0, -1).join('/'), paths.json), filePaths: savedPaths(chat) }), account.label);
	// The account line is left out, so notes saved before it existed do not count as changed.
	const viewHash = (value: string): Promise<string> => fingerprint(untagAccount(value).replace(/^(---\r?\n[\s\S]*?\r?\n)unread: false(?=\r?\n)/, '$1unread: true'));

	const sameContent = async (bytes: ArrayBuffer, folder: string, stem: string): Promise<string | null> => {
		for (const kindFolder of Object.values(KIND_FOLDER)) {
			const dir = findFile(app, `${folder}/${kindFolder}/${stem}`);
			if (!(dir instanceof TFolder)) continue;
			for (const f of dir.children) {
				if (f instanceof TFile && f.stat.size === bytes.byteLength && equalBytes(await app.vault.readBinary(f), bytes)) return f.path;
			}
		}
		return null;
	};

	/**
	 * A real PNG, JPEG, GIF or WebP. chatgpt.com serves some older photos only as a resized copy
	 * (seen 2026-11-27: 3172335 bytes stated, 823189 served), so for an image that is still an
	 * image the stated size does not count; any other file of the wrong size is skipped.
	 */
	const isImageBytes = (bytes: ArrayBuffer): boolean => {
		const b = new Uint8Array(bytes.slice(0, 12));
		const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
		return at(0, 0x89, 0x50, 0x4e, 0x47) || at(0, 0xff, 0xd8, 0xff) || at(0, 0x47, 0x49, 0x46, 0x38) || (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50));
	};

	const fetchFile = async (a: GptApi, chatId: string, task: GptFileTask): Promise<{ bytes: ArrayBuffer | null; expected?: number }> => {
		await sleep(delayMs);
		const file = safeFileName(task.name);
		if (task.sandbox) {
			requestStage = `downloading generated file "${file}"`;
			return { bytes: await a.sandboxBytes(chatId, task.sandbox.messageId, task.sandbox.path) };
		}
		requestStage = `looking up file "${file}"`;
		const info = await a.fileInfo(task.fileUuid, chatId);
		if (info === null || isGptFileGone(info)) return { bytes: null };
		const { url, size } = checkGptFileInfo(info);
		await sleep(delayMs);
		requestStage = `downloading file "${file}"`;
		return { bytes: await a.fileBytes(url), expected: size ?? task.sizeBytes };
	};

	const backfill = async (a: GptApi, chat: GptChat, folder: string, stem: string): Promise<void> => {
		if (!g.downloadFiles) return;
		for (const task of gptChatFiles(chat).filter(isMissing)) {
			const id = task.fileUuid;
			pendingAssets.add(id);
			if (remainingAttempts <= 0 || (retries[id]?.nextAttempt ?? 0) > Date.now()) continue;
			remainingAttempts--;
			let failure: string | undefined;
			try {
				const { bytes, expected } = await fetchFile(a, chat.conversation_id, task);
				if (!bytes) failure = 'download unavailable';
				else if (expected !== undefined && bytes.byteLength !== expected && !(task.isImage && isImageBytes(bytes))) failure = 'size mismatch';
				else {
					const existing = await sameContent(bytes, folder, stem);
					if (existing) {
						g.fileIndex[id] = existing;
						result.filesDeduped++;
					} else {
						const dir = `${folder}/${KIND_FOLDER[task.kind]}/${stem}`;
						await ensureFolder(app, dir);
						const path = `${dir}/${freeFileName(app, dir, safeFileName(task.name), numbered)}`;
						await createNew(app, path, bytes);
						g.fileIndex[id] = path;
						result.filesSaved++;
					}
					delete retries[id];
					pendingAssets.delete(id);
				}
			} catch (e) {
				if (!(e instanceof BlockedLinkError || e instanceof ShapeError)) throw e;
				failure = e instanceof BlockedLinkError ? e.where : 'unexpected file response';
			}
			if (failure) {
				retries[id] = retryAsset(retries[id], failure);
				result.filesSkipped.push(`${safeFileName(task.name)} (${failure})`);
			}
			await plugin.saveSettings();
		}
	};

	try {
		const base = cleanFolder(g.folder);
		if (!base) throw new StopError('The ChatGPT folder setting is empty or invalid.');
		progress('connecting…');
		const a = await GptApi.connect(loginRef('chatgpt', account), pastedSession(plugin.app, g.secretId));
		api = a;
		const twin = s.chatgpt.find((other) => other !== account && other.web.inventories?.accounts[a.inventoryKey]);
		if (twin) throw new StopError(`This login is the same ChatGPT account and workspace as "${twin.label}". Log in with a different account, or remove this one.`);
		if (a.workspaceId && g.workspaceId !== a.workspaceId) {
			g.workspaceId = a.workspaceId;
			await plugin.saveSettings();
		}

		// Refresh labels before applying name-based project filters.
		const { projects: projectList, cut } = await listAllGptProjects(a, () => sleep(delayMs), (page) => {
			result.projectRequests = page;
			requestStage = `listing projects (page ${page})`;
		});
		result.projectsCut = cut;
		const recent = g.recentFolderName || DEFAULT_RECENT;
		const filters = g.onlyProjects ? [...new Set(g.projects.map((name) => name.trim().toLowerCase()).filter(Boolean))].sort() : [];
		const includePinned = g.includePinned !== false;
		const observations = g.includeArchived === true && g.separateArchived === true ? new ArchiveObservations() : undefined;
		const observeArchive = g.includeArchived === true && !observations ? new ArchiveObservations() : undefined;
		if (observations) {
			result.archive = emptyArchiveReport();
			progress('checking archived status…');
		}
		// Pinned chats off adds a fifth entry, so the default (on) keeps the scope older versions saved.
		const scope = JSON.stringify([
			g.includeArchived === true, filters, filters.length ? recent.toLowerCase() : '',
			projectList.filter((p) => filters.includes(p.name.toLowerCase()) || filters.includes(p.id.toLowerCase()))
				.map((p) => p.id).sort(),
			...(includePinned ? [] : ['no-pinned']),
			...(observations ? ['separate-archived'] : []),
		]);
		const inventory = accountInventory(g.inventories ??= { accounts: {} }, a.inventoryKey, scope);
		if (g.chatProgress && (g.chatProgress.inventoryKey !== a.inventoryKey || g.chatProgress.scope !== scope)) {
			delete g.chatProgress;
		}
		const allowed = (items: ListItem[]) => filters.length ? filterByProjects(items, filters, recent) : items;
		const needsCapture = (row: GptListItem): boolean => {
			const captured = g.index[row.id]?.updated_at;
			return !captured || compareRevision(row.update_time, captured) > 0;
		};
		const eligibleJobs = () => allowed(toListItems(Object.values(inventory.queue)
			.filter((row) => inventory.known[row.id]?.generation === inventory.generation && needsCapture(row)), projectList));
		queuedCount = () => eligibleJobs().length;
		const reconcile = fullStillRequested;
		// scanInventory persists unfinished reconciliation lists before it issues requests.
		fullStillRequested = false;
		await scanInventory(inventory, {
			archived: g.includeArchived === true,
			archive: observations,
			observeArchive,
			pinned: includePinned,
			overlapMinutes: g.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES,
			forceFull: reconcile,
			now: Date.now(),
			needsCapture,
			save: () => {
				if (g.resumeAfter429?.forceFull && inventory.manual?.length) g.resumeAfter429.forceFull = false;
				return plugin.saveSettings();
			},
			fetch: async (offset, tpp, archived, pinned) => {
				progress(`${observations ? 'checking archived status' : 'reading ChatGPT inventory'}… ${scan.seen.size} chats checked`);
				await sleep(delayMs);
				requestStage = `listing ${archived ? 'archived' : pinned ? 'pinned' : 'active'} ${tpp ? 'TPP' : 'normal'} chats (offset ${offset})`;
				return (await a.get(a.listPath(offset, tpp, archived, pinned))).json;
			},
		}, scan);

		const discovered = [...scan.seen].flatMap((id) => inventory.known[id]?.item ?? []);
		const completedJobs = Object.values(inventory.queue).filter((row) => !needsCapture(row));
		for (const row of completedJobs) completeInventoryJob(inventory, row.id, row.update_time);
		if (completedJobs.length) await plugin.saveSettings();
		const seenInScope = allowed(toListItems(discovered, projectList));
		result.filteredOut = discovered.length - seenInScope.length;
		result.unchanged = seenInScope.filter((item) => g.index[item.uuid]?.updated_at === item.updated_at).length;
		const todo = eligibleJobs().sort((a, b) => compareRevision(b.updated_at, a.updated_at));
		// This catalog includes older indexed chats outside the current scan overlap.
		const catalog = allowed(toListItems(Object.values(inventory.known)
			.filter((row) => row.generation === inventory.generation)
			.map((row) => row.item), projectList));
		const kept = catalog.filter((item) => g.index[item.uuid]);
		const catalogIds = new Set(catalog.map((item) => item.uuid));
		const counts = { inventoryKey: a.inventoryKey, scope, saved: kept.length, total: catalog.length };
		g.chatProgress = counts;
		await plugin.saveSettings();
		const archiveState = (id: string) => observations ? inventory.known[id]?.archived : undefined;
		const rawRoot = masterRaw(plugin.settings);
		const root = archiveRoot(s, 'chatgpt', account.id, base);
		const filing = (item: ListItem) => ({
			base, root, projectSubfolders: g.projectSubfolders, rawSetting: g.rawFolder, rawRoot,
			projectRaw: customProjectFolder(item, { ...g, projectFolders: g.projectRawFolders }, recent),
			active: chatFolders(item, g, base, g.rawFolder, recent, rawRoot),
		});

		// 4. Folders.
		await ensureFolder(app, base);
		if (g.projectSubfolders) {
			for (const name of projectFolderNames(kept.filter((item) => archiveState(item.uuid) !== true && customProjectFolder(item, g, recent) === null), recent)) {
				const path = `${base}/${name}`;
				if (!findFile(app, path)) {
					await ensureFolder(app, path);
					result.foldersCreated.push(path);
				}
			}
		}
		const foldersFor = (item: ListItem) => archiveState(item.uuid) === true ? newArchiveFolders(filing(item)) : filing(item).active;
		let activeDownload = 'recovering a saved chat';


		const loadChat = async (item: ListItem): Promise<{ chat: GptChat; bytes: ArrayBuffer[] } | null> => {
			await sleep(delayMs);
			requestStage = 'fetching the conversation';
			const r = await a.get(a.chatPath(item.uuid));
			const first = checkGptChat(r.json, item.uuid);
			const pages = [];
			const bytes = [r.bytes];
			const cursors = new Set<string>();
			let info = first.page_info;
			while (info?.has_previous_page) {
				if (pages.length >= MAX_OLDER) {
					result.tooLong.push(item.name);
					return null;
				}
				const before = info.start_cursor;
				if (!isMessageId(before) || cursors.has(before)) throw new ShapeError('ChatGPT older-page cursor is missing or repeated.');
				cursors.add(before);
				progress(`loading older part ${pages.length + 1} of "${item.name}"`, undefined, undefined, activeDownload);
				await sleep(delayMs);
				requestStage = `fetching older conversation page ${pages.length + 1}`;
				const response = await a.get(a.olderPath(item.uuid, before));
				const page = checkGptOlderPage(response.json);
				pages.push(page);
				bytes.push(response.bytes);
				info = page.page_info;
			}
			return { chat: joinParts(first, pages), bytes };
		};

		const readSaved = async (item: ListItem, entry: IndexEntry): Promise<GptChat | null> => {
			try {
				const paths = [entry.json, ...(entry.older ?? [])];
				if (entry.pageHashes && entry.pageHashes.length !== paths.length) return null;
				const pages = [];
				let main: GptChat | undefined;
				let more = true;
				for (const [i, path] of paths.entries()) {
					if (!more || !exists(path)) return null;
					const rawPage = await app.vault.adapter.readBinary(path);
					if (entry.pageHashes && (await fingerprint(rawPage)) !== entry.pageHashes[i]) return null;
					const payload: unknown = JSON.parse(new TextDecoder().decode(rawPage));
					if (i === 0) {
						main = checkGptChat(payload, item.uuid);
						more = main.page_info?.has_previous_page === true;
					} else {
						const page = checkGptOlderPage(payload);
						pages.push(page);
						more = page.page_info?.has_previous_page === true;
					}
				}
				return main && !more ? joinParts(main, pages) : null;
			} catch {
				return null;
			}
		};

		const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
		const stemOf = (p: string) => (p.split('/').pop() ?? '').replace(/\.(json|md)$/, '');

		/** A note saved before fingerprints existed that is still exactly what the plugin wrote. */
		const asWritten = async (e: IndexEntry | undefined): Promise<boolean> =>
			!!e && !e.noteHash && !!e.viewHash && (e.view ?? e.md) === e.md && exists(e.md) && (await viewHash(await app.vault.adapter.read(e.md))) === e.viewHash;

		/**
		 * Saves one chat. A chat saved before keeps its one note and its file names: the version it
		 * had is kept in the raw folder first, then the new pages are written over the old ones.
		 * The intended bytes and paths are checkpointed before any file is written.
		 */
		const capture = async (item: ListItem): Promise<{ chat: GptChat; entry: Capture } | null> => {
			const before = g.index[item.uuid];
			let entry: Capture | undefined = pending[item.uuid];
			if (entry?.updated_at !== item.updated_at) entry = undefined;
			let chat = entry ? await readSaved(item, entry) : null;
			if (!chat) {
				const loaded = await loadChat(item);
				if (!loaded) return null;
				chat = loaded.chat;
				const hashes = await Promise.all(loaded.bytes.map((bytes) => fingerprint(bytes)));
				if (entry && JSON.stringify(entry.pageHashes) !== JSON.stringify(hashes)) entry = undefined;
				if (entry && !before) {
					// A new chat's files are never written over: a different file there means another capture.
					for (const [i, path] of [entry.json, ...(entry.older ?? [])].entries()) {
						if (exists(path) && (await fingerprint(await app.vault.adapter.readBinary(path))) !== hashes[i]) {
							entry = undefined;
							break;
						}
					}
				}
				if (!entry) {
					let json: string;
					let md: string;
					if (before) {
						json = before.json;
						md = before.md;
					} else {
						const { md: folder, raw: rawFolder } = foldersFor(item);
						await ensureFolder(app, folder);
						await ensureFolder(app, rawFolder);
						const stem = freeStem(app, folder, baseName(item.created_at, item.name), item.uuid, rawFolder);
						json = `${rawFolder}/${stem}.json`;
						md = `${folder}/${stem}.md`;
					}
					// The earlier version: its main file and its older parts, kept together.
					const kept = before ? await keepVersion(app, [before.json, ...(before.older ?? [])], before.updated_at, loaded.bytes[0]) : null;
					const archive = before ? before.archive : archiveState(item.uuid) === true ? { root, active: filing(item).active } : undefined;
					entry = {
						updated_at: item.updated_at,
						synced: new Date().toISOString(),
						json,
						md,
						older: loaded.bytes.slice(1).map((_bytes, i) => olderPartPath(dirOf(json), stemOf(json), i + 1)),
						pageHashes: hashes,
						versions: addVersion(before, kept),
						noteHash: before?.noteHash,
						...(archive ? { archive } : {}),
					};
					pending[item.uuid] = entry;
					await plugin.saveSettings();
				}
				const paths = [entry.json, ...(entry.older ?? [])];
				for (const [i, path] of paths.entries()) {
					if (!exists(path) || (await fingerprint(await app.vault.adapter.readBinary(path))) !== hashes[i]) await writeRaw(app, path, loaded.bytes[i]!);
				}
				// Older parts the earlier version had and this one has not: they are in the kept version.
				const keptNow = entry.versions?.some((v) => v.at === before?.updated_at) ?? false;
				for (const stale of (before?.older ?? []).filter((p) => !paths.includes(p))) {
					const file = findFile(app, stale);
					if (keptNow && file instanceof TFile) await app.fileManager.trashFile(file);
				}
			}
			if (!entry) throw new Error('ChatGPT capture has no saved journal entry.');
			const observed = observations ? archiveState(item.uuid) : observeArchive?.get(item.uuid);
			const archiveObservation = observed !== undefined ? observed : typeof chat.is_archived === 'boolean' ? chat.is_archived : before?.archiveObservation;
			const view = withVersionInfo(transcript(chat, item, entry), entry.versions, dirOf(entry.md));
			const note = await writeNote(app, entry.md, view, { policy: s.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced, unedited: await asWritten(before), keep: before?.updated_at === item.updated_at ? ['unread'] : [] });
			recordEdit(result.edits, note, entry.md);
			g.index[item.uuid] = { ...entry, view: entry.md, viewHash: await viewHash(view), noteHash: note.hash, archiveObservation };
			if (!before && catalogIds.has(item.uuid)) counts.saved++;
			delete pending[item.uuid];
			await plugin.saveSettings();
			return { chat, entry };
		};

		/**
		 * Brings the chat's one note up to date when it would be rendered differently now (new files, a newer plugin).
		 * Returns the fingerprint of the note as it is drawn now.
		 */
		const refreshView = async (chat: GptChat, item: ListItem, entry: IndexEntry): Promise<string> => {
			const view = withVersionInfo(transcript(chat, item, entry), entry.versions, dirOf(entry.md));
			const hash = await viewHash(view);
			const latest = entry.view ?? entry.md;
			if (exists(entry.md) && exists(latest)) {
				if (entry.viewHash === hash) return hash;
				if ((await viewHash(await app.vault.adapter.read(latest))) === hash) {
					// The note already reads as drawn now, but its fingerprint is gone (a merge clears it):
					// remember it, so the note is not read again every run and the quick check can skip it.
					entry.viewHash = hash;
					return hash;
				}
			}
			const note = await writeNote(app, entry.md, view, { policy: s.editedNotes, lastHash: entry.noteHash, lastSynced: entry.synced, unedited: await asWritten(entry), keep: ['unread'] });
			recordEdit(result.edits, note, entry.md);
			if (note.outcome === 'created') result.restored.push(stemOf(entry.md));
			else if (note.outcome === 'updated') result.refreshedViews++;
			// A note left as you edited it is not tried again until the chat changes.
			entry.view = entry.md;
			entry.viewHash = hash;
			entry.noteHash = note.hash;
			await plugin.saveSettings();
			return hash;
		};

		/**
		 * Everything the check of a saved, unchanged chat depends on besides the chat itself: its raw
		 * pages (size and time), note, versions, saved files and the plugin build. Null = unknown.
		 */
		const quickKey = async (item: ListItem, entry: IndexEntry, files: string[]): Promise<string | null> => {
			const latest = entry.view ?? entry.md;
			if (!exists(entry.md) || !exists(latest)) return null;
			return checkKey([
				build, JSON.stringify(item), entry.json, entry.md, latest, entry.older ?? [], entry.versions ?? [], entry.pageHashes ?? [], entry.viewHash ?? '',
				await fileStamps(app, [entry.json, ...(entry.older ?? [])]),
				g.downloadFiles, files.map((id) => [g.fileIndex[id] ?? '', !missingId(id)]),
				Intl.DateTimeFormat().resolvedOptions().timeZone,
			]);
		};
		/** A missing file whose next download try is not due yet: backfill would only count it as pending. */
		const waiting = (id: string): boolean => (retries[id]?.nextAttempt ?? 0) > Date.now();
		/** A missing file the full check would try to fetch now. */
		const fetchable = (id: string): boolean => g.downloadFiles && missingId(id) && !waiting(id);
		/**
		 * Nothing to do for this chat: same key as after its last full check, and no missing file due
		 * for a try. Missing files still waiting count as pending, as backfill counts them.
		 */
		const quickDone = async (item: ListItem, entry: IndexEntry): Promise<boolean> => {
			const q = entry.quick;
			if (!q || q.files.some(fetchable)) return false;
			if ((await quickKey(item, entry, q.files)) !== q.key) return false;
			if (g.downloadFiles) for (const id of q.files) if (missingId(id)) pendingAssets.add(id);
			return true;
		};
		let quickUnsaved = 0;
		/**
		 * After a full check: remembered only when it ended with the note as drawn and every file
		 * there or waiting for its next try. Saved in batches (QUICK_SAVE_EVERY).
		 */
		const rememberQuick = async (item: ListItem, entry: IndexEntry, chat: GptChat, hash: string): Promise<void> => {
			const files = gptChatFiles(chat).map((f) => f.fileUuid);
			const settled = entry.viewHash === hash && !files.some(fetchable);
			const key = settled ? await quickKey(item, entry, files) : null;
			const quick = key ? { files, key } : undefined;
			if (JSON.stringify(entry.quick) === JSON.stringify(quick)) return;
			if (quick) entry.quick = quick;
			else delete entry.quick;
			if (++quickUnsaved < QUICK_SAVE_EVERY) return;
			quickUnsaved = 0;
			await plugin.saveSettings();
		};

		// Before anything is written: many saved chats missing means a wrong sync history, not deletions.
		const savedChats = Object.values(g.index).filter((entry) => !entry.archiveMove);
		guardMissing('ChatGPT chats', savedChats.length, savedChats.filter((e) => !exists(e.md) || !exists(e.json)).length);
		if (observations && result.archive) {
			await reconcileArchived(plugin, { items: catalog.filter((item) => !pending[item.uuid]), web: g, state: archiveState, filing, progress, rememberView: true }, result.archive);
		} else if (observeArchive) await rememberArchiveObservations(plugin, g.index, seenInScope, (id) => observeArchive.get(id));
		const ready = todo.filter((item) => !g.index[item.uuid]?.archiveMove && (g.index[item.uuid] || pending[item.uuid] || archiveState(item.uuid) !== null));
		const batch = s.maxChatsPerRun > 0 ? ready.slice(0, s.maxChatsPerRun) : ready;

		const done = new Set<string>();
		for (const [i, item] of batch.entries()) {
			requestChat = { item, position: `queued chat ${i + 1} of ${batch.length}` };
			const isUpdate = Boolean(g.index[item.uuid]);
			const position = isUpdate ? undefined : counts.saved + 1;
			activeDownload = position === undefined ? 'updating a saved chat' : `downloading chat ${position}`;
			progress(`${i + 1} of ${batch.length} queued chats: ${item.name}`, i, batch.length, activeDownload);
			const saved = await capture(item);
			if (!saved) continue;
			done.add(item.uuid);
			completeInventoryJob(inventory, item.uuid, item.updated_at);
			await plugin.saveSettings();
			const stem = stemOf(saved.entry.json);
			result.written.push(stem);
			if (isUpdate) result.changedCount++;
			else result.newCount++;
			progress(`Checking files for ${item.name}`, i + 1, batch.length,
				position === undefined ? 'checking files for an updated chat' : `checking files for chat ${position}`);
			await backfill(a, saved.chat, dirOf(saved.entry.md), stem);
			await refreshView(saved.chat, item, g.index[item.uuid]!);
		}

		progress('checking older chats…');
		activeDownload = 'recovering a saved chat';
		const build = await buildStamp(app, plugin.manifest);
		for (const [k, item] of kept.entries()) {
			if (k % 25 === 0) progress(`checking older chats… ${k} of ${kept.length}`, k, kept.length, 'checking saved chats');
			let entry = g.index[item.uuid];
			if (!entry || entry.archiveMove || done.has(item.uuid) || entry.updated_at !== item.updated_at) continue;
			requestChat = { item, position: `saved chat ${k + 1} of ${kept.length}` };
			if (await quickDone(item, entry)) continue; // its raw pages are not read (quick-check.ts)
			let chat = await readSaved(item, entry);
			if (!chat) {
				// Fetch a new capture as a unit. Pages from different revisions never share a capture.
				const saved = await capture(item);
				if (!saved) continue;
				chat = saved.chat;
				entry = g.index[item.uuid]!;
				result.restored.push(stemOf(entry.json));
			}
			if (entry.archiveViewMoved) {
				// The link paths changed with the move. Adopt that rendering before backfill so a
				// newly downloaded file can still refresh the note through the usual edit policy.
				entry.viewHash = await viewHash(withVersionInfo(transcript(chat, item, entry), entry.versions, dirOf(entry.md)));
				delete entry.archiveViewMoved;
				await plugin.saveSettings();
			}
			const before = result.filesSaved;
			await backfill(a, chat, dirOf(entry.md), stemOf(entry.json));
			if (result.filesSaved > before) result.backfilledChats++;
			await rememberQuick(item, entry, chat, await refreshView(chat, item, entry));
		}
		if (quickUnsaved) await plugin.saveSettings();

		// Codex tasks run in the cloud (chatgpt.com/codex), into the Codex Cloud folder.
		if (g.codexCloud) {
			requestStage = 'reading Codex cloud tasks';
			requestChat = undefined;
			const cloud = (result.codexCloud = emptyCloudResult());
			let codex: Awaited<ReturnType<GptApi['codexAppServer']>> | undefined;
			const client = async () => (codex ??= await a.codexAppServer(plugin.manifest.version));
			try {
				await syncCodexCloud({ app, settings: s, account, client, delayMs, progress, save: () => plugin.saveSettings(), sleep }, cloud);
			} catch (e) {
				if (!(e instanceof GptRateLimitError)) {
					recordError({ provider: 'chatgpt', accountId: account.id }, { service: 'Codex cloud', method: 'WebSocket', url: 'wss://codex-cloud-backend.chatgpt.com', status: null, message: a.redact(e instanceof Error ? e.message : String(e)) });
				}
				throw e;
			} finally {
				codex?.close();
				addCodexCloud(result, cloud);
			}
		}
	} catch (e) {
		if (e instanceof GptRateLimitError) {
			const consecutive = (g.resumeAfter429?.consecutive ?? 0) + 1;
			const deadline = automaticRetryDeadline(e.until, consecutive);
			g.cooldownUntil = deadline;
			g.resumeAfter429 = { consecutive, forceFull: fullStillRequested };
			result.resumeAt = deadline;
			const chat = requestChat
				? ` for "${safeTitle(requestChat.item.name)}" (${requestChat.position}, ID ${requestChat.item.uuid})`
				: '';
			const saved = result.newCount + result.changedCount + result.restored.length;
			result.stopped = `${new GptRateLimitError(deadline).message} Automatic retry scheduled. Hit while ${requestStage}${chat}. Saved ${saved} chat${saved === 1 ? '' : 's'} this run.`;
			await plugin.saveSettings();
		} else if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `ChatGPT response could not be verified (${e.message}). Saved captures are available for the next run.`;
		else if (e instanceof CodexCloudShapeError) result.stopped = `Unexpected Codex cloud task data (${e.message}). chatgpt.com may have changed its internal API – nothing more was written.`;
		else {
			const msg = e instanceof Error ? e.message : String(e);
			result.stopped = api ? api.redact(msg) : msg.replace(/Bearer\s+\S+/gi, 'Bearer [hidden]');
		}
	}

	result.pendingAssets = pendingAssets.size;
	result.listed = scan.seen.size;
	result.listingRequests = scan.requests;
	result.fullLists = scan.fullLists;
	result.incrementalLists = scan.incrementalLists;
	result.leftForLater = queuedCount();
	if (!result.resumeAt && (g.resumeAfter429 || g.cooldownUntil)) {
		delete g.resumeAfter429;
		delete g.cooldownUntil;
		await plugin.saveSettings();
	}
	await writeLog(plugin, account, result);
	return result;
}

/** Codex cloud tasks count in the run's totals (notices, log); the log names them too. */
function addCodexCloud(r: GptSyncResult, c: CloudSyncResult): void {
	r.listed += c.listed;
	r.unchanged += c.unchanged;
	r.newCount += c.newCount;
	r.changedCount += c.changedCount;
	r.leftForLater += c.leftForLater;
	r.written.push(...c.written);
	r.restored.push(...c.restored);
	r.edits.copies.push(...c.edits.copies);
	r.edits.kept.push(...c.edits.kept);
}

async function writeLog(plugin: AIChatBridge, account: ChatgptAccount, r: GptSyncResult): Promise<void> {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.archive) parts.push(...archiveLog(r.archive));
	parts.push(`${r.listingRequests} chat-list requests, ${r.projectRequests} project-list requests (${r.incrementalLists} incremental lists, ${r.fullLists} full lists)`);
	if (r.filteredOut) parts.push(`${r.filteredOut} skipped (other projects)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	if (r.filesSaved) parts.push(`${r.filesSaved} files saved${r.backfilledChats ? ` (incl. files for ${r.backfilledChats} older chats)` : ''}`);
	if (r.filesDeduped) parts.push(`${r.filesDeduped} files already there (not copied)`);
	if (r.pendingAssets) parts.push(`${r.pendingAssets} known assets pending`);
	parts.push('selected branches only');
	if (r.refreshedViews) parts.push(`${r.refreshedViews} refreshed transcripts`);
	parts.push(...editsLog(r.edits));
	if (r.filesSkipped.length) parts.push(`${r.filesSkipped.length} asset attempts failed: ${r.filesSkipped.slice(0, 10).join(', ')}`);
	if (r.tooLong.length) parts.push(`too long to load in one piece, skipped: ${r.tooLong.join(', ')}`);
	if (r.projectsCut) parts.push('more projects exist than chatgpt.com listed – chats in unlisted projects use the project ID as folder name');
	if (r.foldersCreated.length) parts.push(`new folders: ${r.foldersCreated.map((f) => f.split('/').slice(-2).join('/')).join(', ')}`);
	// Suggested by a Codex cloud task (2026-11-18): always say that Codex was looked at.
	if (r.codexCloud) {
		const { listed, written, restored, running } = r.codexCloud;
		const saved = written.length + restored.length;
		parts.push(`${listed} Codex cloud ${listed === 1 ? 'task' : 'tasks'}${listed ? ' listed' : ''}${saved ? `, ${saved} saved` : ''}`);
		if (running) parts.push(`${running} Codex cloud tasks still running (saved when done)`);
	}
	let line = `- [[${dailyNoteName(now)}]] ${time} – **${withAccount('ChatGPT', plugin.settings.chatgpt, account)}:** ${parts.join(', ')}`;
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
