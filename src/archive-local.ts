import { FileSystemAdapter, Platform, type DataAdapter } from 'obsidian';
import { archiveRoot, joinFolder, pathKey, subpath } from './archive-folders';
import { emptyArchiveReport, moveArchivedChats, type ArchiveCandidate } from './archive-move';
import { isProjectId } from './chatgpt/schema';
import type AIChatBridge from './main';
import type { ProgressFn } from './progress';
import { dirOf, masterRaw, mirrorRaw, rawBase } from './raw-folders';
import { customProjectFolder, DEFAULT_RECENT, filterByProjects, nothingSelected } from './select';
import { cleanFolder, type ChatgptAccount, type ClaudeAccount } from './settings';
import type { IndexEntry, ListItem } from './types';

export type ArchiveTarget = { kind: 'claude'; account: ClaudeAccount } | { kind: 'chatgpt'; account: ChatgptAccount };

function filingConfig(plugin: AIChatBridge, target: ArchiveTarget) {
	const base = cleanFolder(target.kind === 'claude' ? target.account.web.chatFolder : target.account.web.folder);
	const rawSetting = target.kind === 'claude' ? target.account.web.chatRawFolder : target.account.web.rawFolder;
	const rawRoot = masterRaw(plugin.settings);
	return { base, rawSetting, rawRoot, root: base ? archiveRoot(plugin.settings, target.kind, target.account.id, base) : null };
}

async function readChat(plugin: AIChatBridge, entry: IndexEntry, id: string, kind: ArchiveTarget['kind']): Promise<Record<string, unknown> | undefined> {
	try {
		const body: unknown = JSON.parse(await plugin.app.vault.adapter.read(entry.json));
		if (!body || typeof body !== 'object') return undefined;
		const raw = body as Record<string, unknown>;
		if (raw[kind === 'claude' ? 'uuid' : 'conversation_id'] === id) return raw;
	} catch {
		// Missing or invalid JSON needs fresh provider evidence.
	}
	return undefined;
}

function localProject(kind: ArchiveTarget['kind'], raw: Record<string, unknown> | undefined): string | null | undefined {
	const id = raw?.[kind === 'claude' ? 'project_uuid' : 'gizmo_id'];
	if (id === null || id === '') return null;
	if (id === undefined && kind === 'claude' && raw?.platform === 'CLAUDE_AI') return null;
	if (typeof id !== 'string') return undefined;
	return kind === 'chatgpt' && !isProjectId(id) ? null : id;
}

export async function separateSavedChats(plugin: AIChatBridge, target: ArchiveTarget, progress: ProgressFn) {
	const { web } = target.account;
	const report = emptyArchiveReport();
	const candidates: ArchiveCandidate[] = [];
	let unresolved = 0;
	if (nothingSelected(web)) return { report, unresolved };
	const { base, root, rawSetting, rawRoot } = filingConfig(plugin, target);
	const recent = web.recentFolderName || DEFAULT_RECENT;
	const code = target.kind === 'claude' ? cleanFolder(target.account.web.codeFolder) : null;
	const saved = Object.entries(web.index);
	for (const [i, [id, entry]] of saved.entries()) {
		progress(`checking saved chats ${i + 1} of ${saved.length}`, i, saved.length);
		const raw = await readChat(plugin, entry, id, target.kind);
		if (target.kind === 'claude' && typeof raw?.platform === 'string' && raw.platform !== 'CLAUDE_AI') continue;
		if (code && subpath(entry.md, code) !== undefined && !entry.archive && raw?.platform !== 'CLAUDE_AI') continue;
		const observed = entry.archiveObservation;
		const archived = observed !== undefined ? observed : entry.archive ? true : raw?.is_archived;
		if (typeof archived === 'boolean' && archived === !!entry.archive && !entry.archiveMove) continue;
		const projectId = localProject(target.kind, raw);
		const row = web.projectCatalog?.rows.find(({ id }) => id === projectId);
		const item: ListItem = {
			uuid: id, name: entry.md, created_at: '', updated_at: entry.updated_at,
			project: projectId ? { uuid: projectId, name: row?.name ?? projectId } : null,
		};
		if (web.onlyProjects) {
			if (projectId === undefined || (projectId && !row && !filterByProjects([item], web.projects, recent).length)) {
				unresolved++;
				continue;
			}
			if (!filterByProjects([item], web.projects, recent).length) continue;
		}
		if (typeof archived !== 'boolean' || !base || !root || (target.kind === 'chatgpt' && target.account.web.pendingCaptures?.[id])) {
			unresolved++;
			continue;
		}
		if (entry.archiveMove || archived !== !!entry.archive) {
			const active = { md: dirOf(entry.md), raw: dirOf(entry.json) };
			const projectRaw = customProjectFolder(item, { ...web, projectFolders: web.projectRawFolders }, recent);
			candidates.push({ entry, name: entry.md, filing: archived ? { base, root, projectSubfolders: web.projectSubfolders, rawSetting, rawRoot, active, projectRaw } : undefined });
		}
	}
	await moveArchivedChats(plugin, web, candidates, progress, report, target.kind === 'chatgpt');
	return { report, unresolved };
}

function ownedRoot(path: string, target: ArchiveTarget): string | undefined {
	if (cleanFolder(path) !== path) return undefined;
	const accountBranch = `/Archived/_Accounts/${target.kind}-${target.account.id}`;
	const key = pathKey(path);
	if (key.endsWith('/archived') || key === 'archived' || key.endsWith(pathKey(accountBranch)) || key === pathKey(accountBranch.slice(1))) return path;
	return undefined;
}

async function removeEmptyFolder(adapter: DataAdapter, path: string): Promise<boolean> {
	try {
		if (Platform.isDesktop && adapter instanceof FileSystemAdapter) {
			// Desktop's adapter can use fs.rm, which rejects directories with recursive disabled.
			// Use rmdir so an unlisted file or a file created concurrently prevents deletion.
			const require = (window as unknown as { require: (name: string) => unknown }).require;
			const { promises: fs } = require('fs') as { promises: { realpath: (path: string) => Promise<string>; rmdir: (path: string) => Promise<void> } };
			const { relative, isAbsolute, sep } = require('path') as { relative: (from: string, to: string) => string; isAbsolute: (path: string) => boolean; sep: string };
			const full = adapter.getFullPath(path);
			const real = await fs.realpath(full);
			const rel = relative(await fs.realpath(adapter.getBasePath()), real);
			if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
			await fs.rmdir(full);
		} else await adapter.rmdir(path, false);
		return true;
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		if (code === 'ENOENT') return true;
		if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false;
		throw error;
	}
}

async function pruneArchiveFolder(plugin: AIChatBridge, path: string): Promise<boolean> {
	const { adapter } = plugin.app.vault;
	if (!(await adapter.exists(path))) return true;
	const contents = await adapter.list(path);
	for (const folder of contents.folders) {
		if (pathKey(folder) !== pathKey(joinFolder(path, '_Accounts')) || !pathKey(path).endsWith('/archived')) {
			await pruneArchiveFolder(plugin, folder);
		} else {
			const accounts = await adapter.list(folder);
			if (!accounts.files.length && !accounts.folders.length) await removeEmptyFolder(adapter, folder);
		}
	}
	const remaining = await adapter.list(path);
	if (remaining.files.length || remaining.folders.length) return false;
	return removeEmptyFolder(adapter, path);
}

export function hasArchiveToRestore(target: ArchiveTarget): boolean {
	const { web } = target.account;
	return web.separateArchived === false &&
		(!!web.archiveCleanup?.length || Object.values(web.index).some((entry) => entry.archive || entry.archiveMove));
}

export async function restoreSavedChats(plugin: AIChatBridge, target: ArchiveTarget, progress: ProgressFn) {
	const { web } = target.account;
	const { base, root, rawSetting, rawRoot } = filingConfig(plugin, target);
	const report = emptyArchiveReport();
	const folders = new Set(web.archiveCleanup?.filter((path) => ownedRoot(path, target)));
	const candidates: ArchiveCandidate[] = [];
	const configuredRaw = rawBase(rawSetting);
	const addRoots = (archive: string) => {
		if (!ownedRoot(archive, target)) return;
		folders.add(archive);
		if (rawRoot !== undefined) folders.add(mirrorRaw(archive, rawRoot));
		else if (configuredRaw && base) {
			const branch = subpath(archive, base);
			if (branch) folders.add(joinFolder(configuredRaw, branch));
		}
	};
	if (root) addRoots(root);
	for (const [id, entry] of Object.entries(web.index)) {
		if (!entry.archive && !entry.archiveMove) continue;
		const placement = entry.archive ?? entry.archiveMove?.placement;
		if (placement) addRoots(placement.root);
		if (entry.archiveObservation === undefined && placement) entry.archiveObservation = true;
		if (target.kind === 'chatgpt' && target.account.web.pendingCaptures?.[id]) {
			report.skipped.push(`${entry.md} (a capture is still pending)`);
		} else candidates.push({ entry, name: entry.md });
	}
	web.archiveCleanup = [...folders];
	await plugin.saveSettings();
	await moveArchivedChats(plugin, web, candidates, progress, report, target.kind === 'chatgpt', true);

	const retained: string[] = [];
	const retry: string[] = [];
	progress('removing empty archive folders…');
	for (const folder of folders) {
		try {
			if (!await pruneArchiveFolder(plugin, folder)) {
				retained.push(folder);
				continue;
			}
			const parent = dirOf(folder);
			if (pathKey(parent).endsWith('/archived/_accounts')) {
				const { adapter } = plugin.app.vault;
				for (const path of [parent, dirOf(parent)]) {
					if (!(await adapter.exists(path))) continue;
					const remaining = await adapter.list(path);
					if (!remaining.files.length && !remaining.folders.length) await removeEmptyFolder(adapter, path);
				}
			}
		} catch (error) {
			retry.push(folder);
			retained.push(folder);
			report.failed.push(`${folder} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	web.archiveCleanup = retry.length ? retry : undefined;
	await plugin.saveSettings();
	return { report, retained };
}
