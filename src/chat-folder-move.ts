import { normalizePath, Platform, TFile, TFolder, type App } from 'obsidian';
import type { ChatFolderEntry, ChatFolderStorage } from './chat-folder-target';
import { followRename } from './follow';
import { baseRoot, dirOf, masterRaw, projectRoots, rawLink, rawTarget, type RawMove } from './raw-folders';
import { plainFolder } from './select';
import type { Settings } from './settings';
import { ensureFolder, findFile } from './vaultio';
import { versionFiles } from './versions';

const keyOf = (path: string): string => {
	const pathNfc = normalizePath(path).normalize('NFC');
	return Platform.isMacOS || Platform.isWin || Platform.isIosApp ? pathNfc.toLowerCase() : pathNfc;
};

const under = (path: string, folder: string): boolean => keyOf(path).startsWith(`${keyOf(folder)}/`);
const relativeTo = (path: string, folder: string): string => path.split('/').slice(folder.split('/').length).join('/');

/** Keep the location of saved chats in step with their changed default folder. */
export function planChatFolderMove(settings: Settings, storage: ChatFolderStorage, to: string) {
	const { folder: from, projects, rawFolder } = storage;
	if (keyOf(from) === keyOf(to)) return { chats: [], unfinished: false, moves: [] };
	const custom = projects?.onlyProjects && projects.customProjectFolders
		? Object.values(projects.projectFolders ?? {}).flatMap((value) => plainFolder(value) ?? []) : [];
	const usesDefault = (path: string): boolean => under(path, from) && !custom.some((folder) => under(path, folder));
	const rawRoot = masterRaw(settings);
	const projectNames = new Map(projects?.projectCatalog?.rows.map(({ id, name }) => [id, name]));
	const roots = (base: string) => [
		baseRoot(base, rawFolder, rawRoot),
		...(projects ? projectRoots(projects, base, rawFolder, (id) => projectNames.get(id), projects.recentFolderName, rawRoot) : []),
	];
	const oldRoots = roots(from);
	const newRoots = roots(to);
	// Pick the project root from the original transcript, even if the destination is
	// inside another project's custom folder.
	const targetRoots = oldRoots.map(({ md }, index) => ({ md, raw: newRoots[index]!.raw }));
	const moves = new Map<string, RawMove>();
	const entries = storage.entries().filter(({ md }) => usesDefault(md));
	const other = storage.otherClaudeFolder;
	if (other && keyOf(other) === keyOf(from) && entries.length) {
		throw new Error('Claude Chat and Code Cloud share this folder. Their saved web chats cannot be split by folder.');
	}
	const nested = other && under(other, from) ? other : undefined;
	const cloud = new Set(storage.cloudEntries?.().filter(({ md }) => under(md, from)));
	const chats = [...entries.filter(({ md }) => !nested || !under(md, nested)), ...cloud];
	const unfinished = Object.values(storage.pending ?? {}).some((entry) => usesDefault(entry.md));
	const add = (source: string, target: string) => {
		if (keyOf(source) === keyOf(target)) return;
		const previous = moves.get(keyOf(source));
		if (previous && previous.to !== target) throw new Error(`The file has two destinations: ${source}`);
		moves.set(keyOf(source), { from: source, to: target });
	};
	for (const entry of chats) {
		const md = `${to}/${relativeTo(entry.md, from)}`;
		const sourceRoots = cloud.has(entry) ? oldRoots.slice(0, 1) : oldRoots;
		const destinationRoots = cloud.has(entry) ? targetRoots.slice(0, 1) : targetRoots;
		const saved = { md: entry.md, raws: [] };
		for (const path of [entry.json ?? entry.raw, ...(entry.older ?? []), ...versionFiles(entry)]) {
			if (!path) continue;
			const oldRaw = rawTarget(saved, path, sourceRoots);
			const newRaw = rawTarget(saved, path, destinationRoots);
			const colocated = keyOf(dirOf(path)) === keyOf(dirOf(entry.md));
			if (newRaw && (colocated || (oldRaw && keyOf(path) === keyOf(oldRaw)))) add(path, newRaw);
		}
		add(entry.md, md);
		if (entry.view && usesDefault(entry.view)) add(entry.view, `${to}/${relativeTo(entry.view, from)}`);
	}
	return { chats, unfinished, moves: [...moves.values()] };
}

function checkDestinations(app: App, moves: readonly RawMove[]): void {
	const targets = new Set(moves.map(({ to }) => keyOf(to)));
	if (targets.size !== moves.length) throw new Error('Two saved files have the same destination.');
	for (const { from, to } of moves) {
		if (!(findFile(app, from) instanceof TFile)) throw new Error(`Saved file missing: ${from}. Refresh the index or sync the account, then try again.`);
		if (findFile(app, to)) throw new Error(`Destination already exists: ${to}`);
		for (let parent = dirOf(to); parent; parent = dirOf(parent)) {
			const folder = findFile(app, parent);
			if (targets.has(keyOf(parent)) || (folder && !(folder instanceof TFolder))) throw new Error(`Destination folder is occupied: ${parent}`);
		}
	}
}

async function rename(app: App, settings: Settings, { from, to }: RawMove): Promise<void> {
	const file = findFile(app, from);
	if (!(file instanceof TFile) || findFile(app, to)) throw new Error(`Could not move ${from} to ${to}`);
	const oldPath = file.path;
	await app.fileManager.renameFile(file, to);
	followRename(settings, oldPath, to);
	if (oldPath !== from) followRename(settings, from, to);
}

/** Only consider folders that lost a file, and stop at the previous storage roots. */
function sourceFolders(moves: readonly RawMove[], roots: readonly string[]): string[] {
	const folders = new Set<string>();
	for (const { from } of moves) {
		for (let dir = dirOf(from); dir && roots.some((root) => keyOf(dir) === keyOf(root) || under(dir, root)); dir = dirOf(dir)) {
			folders.add(dir);
		}
	}
	return [...folders];
}

async function removeEmptyFolders(app: App, paths: readonly string[]): Promise<string[]> {
	const failed: string[] = [];
	for (const path of [...paths].sort((a, b) => b.length - a.length)) {
		const folder = findFile(app, path);
		if (!(folder instanceof TFolder) || folder.children.length) continue;
		try {
			await app.fileManager.trashFile(folder);
		} catch {
			failed.push(path);
		}
	}
	return failed;
}

/** Refresh the plugin's raw links even when Obsidian's automatic link updates are disabled. */
async function updateRawLinks(app: App, chats: readonly ChatFolderEntry[]): Promise<void> {
	for (const entry of chats) {
		const file = findFile(app, entry.md);
		if (!(file instanceof TFile)) continue;
		const link = (path: string) => `[[${rawLink(dirOf(entry.md), path)}]]`;
		const main = entry.json ?? entry.raw;
		const raw = main ? link(main) : undefined;
		const earlier = (entry.versions ?? []).flatMap(({ files }) => files[0] ? [link(files[0])] : []);
		if (!raw && !earlier.length) continue;
		const properties = app.metadataCache.getFileCache(file)?.frontmatter;
		if ((!raw || properties?.raw === raw) && JSON.stringify(properties?.earlier_raw ?? []) === JSON.stringify(earlier)) continue;
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (raw) fm.raw = raw;
			if (earlier.length) fm.earlier_raw = earlier;
		});
	}
}

export interface ChatFolderMoveResult {
	moved: number;
	foldersLeft: string[];
}

export async function moveChatFolder(
	app: App, settings: Settings, storage: ChatFolderStorage, to: string, save: () => Promise<void>, stopping: () => boolean,
): Promise<ChatFolderMoveResult> {
	const from = storage.folder;
	if (keyOf(from) === keyOf(to)) return { moved: 0, foldersLeft: [] };
	const plan = planChatFolderMove(settings, storage, to);
	if (plan.unfinished) throw new Error('Finish syncing the interrupted download before moving its folder.');
	const target = findFile(app, to);
	if (target && !(target instanceof TFolder)) throw new Error(`Destination folder is occupied: ${to}`);
	checkDestinations(app, plan.moves);

	const moved: RawMove[] = [];
	const created: string[] = [];
	try {
		for (const folder of new Set(plan.moves.map(({ to: path }) => dirOf(path)))) {
			await ensureFolder(app, folder, (path) => created.push(path));
		}
		for (const step of plan.moves) {
			if (stopping()) throw new Error('The folder move was stopped.');
			await rename(app, settings, step);
			moved.push(step);
		}
		if (stopping()) throw new Error('The folder move was stopped.');
		if (moved.length) await updateRawLinks(app, plan.chats);
		if (stopping()) throw new Error('The folder move was stopped.');
		storage.setFolder(to);
		await save();
	} catch (error) {
		storage.setFolder(from);
		const failed: string[] = [];
		for (const step of moved.reverse()) {
			try {
				await rename(app, settings, { from: step.to, to: step.from });
			} catch {
				failed.push(step.to);
			}
		}
		if (moved.length) {
			try {
				await updateRawLinks(app, plan.chats);
			} catch {
				failed.push('raw links');
			}
		}
		await save();
		if (failed.length) throw new Error(`Could not undo every change: ${failed.join(', ')}. Review these paths before retrying.`);
		const foldersLeft = await removeEmptyFolders(app, created);
		if (foldersLeft.length) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message} Could not remove empty folders: ${foldersLeft.join(', ')}.`);
		}
		throw error;
	}
	const oldRawRoot = baseRoot(from, storage.rawFolder, masterRaw(settings)).raw;
	const foldersLeft = await removeEmptyFolders(app, sourceFolders(moved, [from, oldRawRoot]));
	return { moved: plan.chats.length, foldersLeft };
}
