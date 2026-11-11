// Preserve each conversation capture before downloading its assets. The saved
// index and capture journal let the next run continue after a stop.

import { TFile, TFolder } from 'obsidian';
import type AIChatBridge from '../main';
import { loginRef, withAccount } from '../accounts';
import type { ChatgptAccount } from '../settings';
import { StopError } from '../api';
import { ShapeError } from '../schema';
import { customProjectFolder, DEFAULT_RECENT, filterByProjects, nothingSelected, projectFolderNames } from '../select';
import { baseName, dailyNoteName, localStamp, safeTitle, tagAccount, untagAccount } from '../naming';
import { createNew, ensureFolder, freeFileName, freeStem } from '../vaultio';
import { appendLog } from '../log';
import { cleanFolder, MIN_DELAY_SECONDS } from '../settings';
import { KIND_FOLDER, numbered, safeFileName } from '../files';
import type { IndexEntry, ListItem } from '../types';
import { BlockedLinkError, GptApi } from './api';
import { pastedSession } from '../cookies';
import { checkGptChat, checkGptFileInfo, checkGptOlderPage, checkGptSidebar, isMessageId } from './schema';
import { joinParts, olderPartPath } from './parts';
import { toListItems } from './select';
import { gptChatFiles, type GptFileTask } from './files';
import { automaticRetryDeadline, fingerprint, GptRateLimitError, retryAsset, type Capture } from './recovery';
import { accountInventory, compareRevision, completeInventoryJob, DEFAULT_OVERLAP_MINUTES, scanInventory, type ScanStats } from './inventory';
import { renderGptTranscript } from './transcript';
import { chatFolders, masterRaw, rawLink } from '../raw-folders';
import type { GptChat, GptListItem, GptProject } from './types';
import type { ProgressFn } from '../progress';

const MAX_PAGES = 300; // 6000 chats per list; a guard against an endless paging loop
const MAX_OLDER = 200; // older parts per chat (10 turns each)
const SKIPPED = 'skipped: ';
const MAX_ASSET_ATTEMPTS = 24;

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
	pendingAssets: number;
	refreshedViews: number;
	listingRequests: number;
	projectRequests: number;
	fullLists: number;
	incrementalLists: number;
	resumeAt?: number;
	stopped?: string;
	/** "Only selected projects" is on with nothing selected, so the sync did not run. */
	nothingSelected?: boolean;
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
	const result: GptSyncResult = { listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], foldersCreated: [], filesSaved: 0, filesDeduped: 0, filesSkipped: [], backfilledChats: 0, tooLong: [], projectsCut: false, pendingAssets: 0, refreshedViews: 0, listingRequests: 0, projectRequests: 0, fullLists: 0, incrementalLists: 0 };
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

	const exists = (path: string): boolean => app.vault.getAbstractFileByPath(path) instanceof TFile;
	const isMissing = (f: GptFileTask): boolean => {
		const p = g.fileIndex[f.fileUuid];
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
			const dir = app.vault.getAbstractFileByPath(`${folder}/${kindFolder}/${stem}`);
			if (!(dir instanceof TFolder)) continue;
			for (const f of dir.children) {
				if (f instanceof TFile && f.stat.size === bytes.byteLength && equalBytes(await app.vault.readBinary(f), bytes)) return f.path;
			}
		}
		return null;
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
		if (info === null) return { bytes: null };
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
				else if (expected !== undefined && bytes.byteLength !== expected) failure = 'size mismatch';
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
		const scope = JSON.stringify([
			g.includeArchived === true, filters, filters.length ? recent.toLowerCase() : '',
			projectList.filter((p) => filters.includes(p.name.toLowerCase()) || filters.includes(p.id.toLowerCase()))
				.map((p) => p.id).sort(),
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
			overlapMinutes: g.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES,
			forceFull: reconcile,
			now: Date.now(),
			needsCapture,
			save: () => {
				if (g.resumeAfter429?.forceFull && inventory.manual?.length) g.resumeAfter429.forceFull = false;
				return plugin.saveSettings();
			},
			fetch: async (offset, tpp, archived) => {
				progress(`reading ChatGPT inventory… ${scan.seen.size} chats checked`);
				await sleep(delayMs);
				requestStage = `listing ${archived ? 'archived' : 'active'} ${tpp ? 'TPP' : 'normal'} chats (offset ${offset})`;
				return (await a.get(a.listPath(offset, tpp, archived))).json;
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
		const batch = s.maxChatsPerRun > 0 ? todo.slice(0, s.maxChatsPerRun) : todo;
		// This catalog includes older indexed chats outside the current scan overlap.
		const catalog = allowed(toListItems(Object.values(inventory.known)
			.filter((row) => row.generation === inventory.generation)
			.map((row) => row.item), projectList));
		const kept = catalog.filter((item) => g.index[item.uuid]);
		const catalogIds = new Set(catalog.map((item) => item.uuid));
		const counts = { inventoryKey: a.inventoryKey, scope, saved: kept.length, total: catalog.length };
		g.chatProgress = counts;
		await plugin.saveSettings();

		// 4. Folders.
		await ensureFolder(app, base);
		if (g.projectSubfolders) {
			for (const name of projectFolderNames(kept.filter((item) => customProjectFolder(item, g, recent) === null), recent)) {
				const path = `${base}/${name}`;
				if (!app.vault.getAbstractFileByPath(path)) {
					await ensureFolder(app, path);
					result.foldersCreated.push(path);
				}
			}
		}
		const foldersFor = (item: ListItem) => chatFolders(item, g, base, g.rawFolder, recent, masterRaw(plugin.settings));
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

		/** Checkpoint the intended bytes/paths before creating any file. */
		const capture = async (item: ListItem, suffix: string): Promise<{ chat: GptChat; entry: Capture } | null> => {
			let entry: Capture | undefined = pending[item.uuid];
			if (entry?.updated_at !== item.updated_at) entry = undefined;
			let chat = entry ? await readSaved(item, entry) : null;
			if (!chat) {
				const loaded = await loadChat(item);
				if (!loaded) return null;
				chat = loaded.chat;
				const hashes = await Promise.all(loaded.bytes.map((bytes) => fingerprint(bytes)));
				if (entry && JSON.stringify(entry.pageHashes) !== JSON.stringify(hashes)) entry = undefined;
				if (entry) {
					for (const [i, path] of [entry.json, ...(entry.older ?? [])].entries()) {
						if (exists(path) && (await fingerprint(await app.vault.adapter.readBinary(path))) !== hashes[i]) {
							entry = undefined;
							break;
						}
					}
				}
				if (!entry) {
					const { md: folder, raw: rawFolder } = foldersFor(item);
					await ensureFolder(app, folder);
					await ensureFolder(app, rawFolder);
					const stem = freeStem(app, folder, baseName(item.created_at, item.name) + suffix, item.uuid, rawFolder);
					entry = {
						updated_at: item.updated_at,
						synced: new Date().toISOString(),
						json: `${rawFolder}/${stem}.json`,
						md: `${folder}/${stem}.md`,
						older: loaded.bytes.slice(1).map((_bytes, i) => olderPartPath(rawFolder, stem, i + 1)),
						pageHashes: hashes,
					};
					pending[item.uuid] = entry;
					await plugin.saveSettings();
				}
				for (const [i, path] of [entry.json, ...(entry.older ?? [])].entries()) {
					if (!exists(path)) await createNew(app, path, loaded.bytes[i]!);
				}
			}
			if (!entry) throw new Error('ChatGPT capture has no saved journal entry.');
			const view = transcript(chat, item, entry);
			if (!exists(entry.md)) await createNew(app, entry.md, view);
			const isNew = !g.index[item.uuid];
			g.index[item.uuid] = { ...entry, view: entry.md, viewHash: await viewHash(await app.vault.adapter.read(entry.md)) };
			if (isNew && catalogIds.has(item.uuid)) counts.saved++;
			delete pending[item.uuid];
			await plugin.saveSettings();
			return { chat, entry };
		};

		const refreshView = async (chat: GptChat, item: ListItem, entry: IndexEntry): Promise<void> => {
			const view = transcript(chat, item, entry);
			const hash = await viewHash(view);
			const latest = entry.view ?? entry.md;
			if (exists(entry.md) && exists(latest) && (entry.viewHash === hash || (await viewHash(await app.vault.adapter.read(latest))) === hash)) return;
			const path = !exists(entry.md) ? entry.md : `${dirOf(entry.md)}/${stemOf(entry.json)} (transcript ${hash.slice(0, 16)}).md`;
			if (!exists(path)) {
				await createNew(app, path, view);
				if (path === entry.md) result.restored.push(stemOf(path));
				else result.refreshedViews++;
			} else if ((await viewHash(await app.vault.adapter.read(path))) !== hash) {
				throw new Error('ChatGPT derived transcript path is occupied by different content.');
			}
			entry.view = path;
			entry.viewHash = hash;
			await plugin.saveSettings();
		};

		const done = new Set<string>();
		for (const [i, item] of batch.entries()) {
			requestChat = { item, position: `queued chat ${i + 1} of ${batch.length}` };
			const isUpdate = Boolean(g.index[item.uuid]);
			const position = isUpdate ? undefined : counts.saved + 1;
			activeDownload = position === undefined ? 'updating a saved chat' : `downloading chat ${position}`;
			progress(`${i + 1} of ${batch.length} queued chats: ${item.name}`, i, batch.length, activeDownload);
			const saved = await capture(item, isUpdate ? ` (updated ${localStamp(item.updated_at)})` : '');
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
		for (const [k, item] of kept.entries()) {
			if (k % 25 === 0) progress(`checking older chats… ${k} of ${kept.length}`, k, kept.length, 'checking saved chats');
			let entry = g.index[item.uuid];
			if (!entry || done.has(item.uuid) || entry.updated_at !== item.updated_at) continue;
			requestChat = { item, position: `saved chat ${k + 1} of ${kept.length}` };
			let chat = await readSaved(item, entry);
			if (!chat) {
				// Fetch a new capture as a unit. Pages from different revisions never share a capture.
				const saved = await capture(item, ' (recovered)');
				if (!saved) continue;
				chat = saved.chat;
				entry = g.index[item.uuid]!;
				result.restored.push(stemOf(entry.json));
			}
			const before = result.filesSaved;
			await backfill(a, chat, dirOf(entry.md), stemOf(entry.json));
			if (result.filesSaved > before) result.backfilledChats++;
			await refreshView(chat, item, entry);
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

async function writeLog(plugin: AIChatBridge, account: ChatgptAccount, r: GptSyncResult): Promise<void> {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	parts.push(`${r.listingRequests} chat-list requests, ${r.projectRequests} project-list requests (${r.incrementalLists} incremental lists, ${r.fullLists} full lists)`);
	if (r.filteredOut) parts.push(`${r.filteredOut} skipped (other projects)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	if (r.filesSaved) parts.push(`${r.filesSaved} files saved${r.backfilledChats ? ` (incl. files for ${r.backfilledChats} older chats)` : ''}`);
	if (r.filesDeduped) parts.push(`${r.filesDeduped} files already there (not copied)`);
	if (r.pendingAssets) parts.push(`${r.pendingAssets} known assets pending`);
	parts.push('selected branches only');
	if (r.refreshedViews) parts.push(`${r.refreshedViews} refreshed transcripts`);
	if (r.filesSkipped.length) parts.push(`${r.filesSkipped.length} asset attempts failed: ${r.filesSkipped.slice(0, 10).join(', ')}`);
	if (r.tooLong.length) parts.push(`too long to load in one piece, skipped: ${r.tooLong.join(', ')}`);
	if (r.projectsCut) parts.push('more projects exist than chatgpt.com listed – chats in unlisted projects use the project ID as folder name');
	if (r.foldersCreated.length) parts.push(`new folders: ${r.foldersCreated.map((f) => f.split('/').slice(-2).join('/')).join(', ')}`);
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
