import { TFile, TFolder, type App } from 'obsidian';
import { archivedMd, archivedRaw, joinFolder, pathKey, rawDestination, subpath, type ArchivedPlacement, type ArchiveMove, type ArchiveMoveFile } from './archive-folders';
import { planArchiveLinks, rebaseArchiveLinks } from './archive-links';
import { KIND_FOLDER } from './files';
import { followRename } from './follow';
import type AIChatBridge from './main';
import type { ProgressFn } from './progress';
import { dirOf, masterRaw, mirrorRaw, type ChatFolders } from './raw-folders';
import type { IndexEntry, ListItem } from './types';
import { ensureFolder, findFile } from './vaultio';
import { versionFiles } from './versions';

const nameOf = (p: string): string => p.split('/').pop() ?? p;
const at = (app: App, p: string): TFile | null => {
	const f = findFile(app, p);
	return f instanceof TFile ? f : null;
};

export interface ArchiveFiling {
	base: string;
	root: string;
	projectSubfolders: boolean;
	rawSetting?: string;
	rawRoot?: string;
	projectRaw?: string | null;
	active: ChatFolders;
}

export function newArchiveFolders(filing: ArchiveFiling): ChatFolders {
	const { active, base, root, projectSubfolders, rawSetting, rawRoot, projectRaw } = filing;
	const md = archivedMd(active.md, base, root, projectSubfolders);
	return { md, raw: archivedRaw(active, md, base, root, rawSetting, rawRoot, !!projectRaw && pathKey(projectRaw) === pathKey(active.raw)) };
}

class BlockedMove extends Error {}

export interface ArchiveReport {
	moved: number;
	skipped: string[];
	failed: string[];
}

export const emptyArchiveReport = (): ArchiveReport => ({ moved: 0, skipped: [], failed: [] });

export const archiveSummary = (r: ArchiveReport): string =>
	`Archived chats: ${r.moved} moved, ${r.skipped.length} skipped, ${r.failed.length} failed`;

export function archiveLog(r: ArchiveReport): string[] {
	return [archiveSummary(r), ...r.skipped.slice(0, 10), ...r.failed.slice(0, 10)];
}

function assertFree(app: App, path: string): void {
	if (findFile(app, path)) throw new BlockedMove(`destination already exists (${path})`);
	for (let parent = dirOf(path); parent; parent = dirOf(parent)) {
		const file = findFile(app, parent);
		if (file && !(file instanceof TFolder)) throw new BlockedMove(`destination folder is occupied (${parent})`);
		if (file) break;
	}
}

function preflight(app: App, paths: ReadonlyMap<string, string>): ArchiveMoveFile[] {
	const claimed = new Set<string>();
	const files: ArchiveMoveFile[] = [];
	for (const [from, to] of paths) {
		if (from === to) continue;
		const file = at(app, from);
		if (!file) continue;
		if (claimed.has(pathKey(to))) throw new BlockedMove(`multiple files need the same destination (${to})`);
		assertFree(app, to);
		claimed.add(pathKey(to));
		const { size, mtime, ctime } = file.stat;
		files.push({ from, to, size, mtime, ctime });
	}
	return files;
}

/** Only indexed files in a chat's own asset folders are eligible to move. */
function assetMoves(app: App, entry: IndexEntry, md: string, fileIndex: Record<string, string>, otherAssets: ReadonlySet<string>, linkedByOthers: ReadonlyMap<string, Set<string>>): [string, string][] {
	const files: [string, string][] = [];
	const stem = nameOf(entry.json).replace(/\.json$/i, '');
	const viaNote = app.metadataCache?.resolvedLinks?.[entry.md] ?? {};
	for (const from of new Set(Object.values(fileIndex))) {
		if (from.startsWith('skipped: ') || otherAssets.has(pathKey(from))) continue;
		const folder = dirOf(from);
		const kind = nameOf(dirOf(folder));
		if (!Object.values<string>(KIND_FOLDER).includes(kind) || nameOf(folder) !== stem) continue;
		if (dirOf(dirOf(folder)) !== dirOf(entry.md) && !viaNote[from]) continue;
		if ([...(linkedByOthers.get(from) ?? [])].some((note) => note !== entry.md && note !== entry.view)) continue;
		if (at(app, from)) files.push([from, joinFolder(md, `${kind}/${stem}/${nameOf(from)}`)]);
	}
	return files;
}

function planMove(app: App, entry: IndexEntry, filing: ArchiveFiling | undefined, rawRoot: string | undefined, assets: (md: string) => [string, string][]): ArchiveMove {
	const note = at(app, entry.md);
	if (!note || !at(app, entry.json)) throw new BlockedMove('transcript or raw file is missing');
	const active = { md: dirOf(entry.md), raw: dirOf(entry.json) };
	const previous = entry.archive;
	if (filing && subpath(active.md, `${filing.base}/Archived`) !== undefined) throw new BlockedMove('the active folder is inside the reserved Archived folder');
	const next = filing ? newArchiveFolders({ ...filing, active }) : previous!.active;
	const md = !filing && subpath(active.md, previous!.root) === undefined ? active.md : next.md;
	const to = joinFolder(md, nameOf(entry.md));
	const paths = new Map([[entry.md, to]]);
	const placement: ArchivedPlacement | undefined = filing ? { root: filing.root, active } : undefined;
	for (const from of new Set([entry.json, ...(entry.older ?? []), ...versionFiles(entry)])) {
		const raw = filing ? rawDestination(from, active, md, next.raw, rawRoot)
			: rawRoot !== undefined ? mirrorRaw(md, rawRoot)
				: (previous?.rawOrigins?.[from] ?? rawDestination(from, active, md, next.raw, undefined));
		const dest = joinFolder(raw, nameOf(from));
		if (placement && raw !== dirOf(from)) (placement.rawOrigins ??= {})[dest] = dirOf(from);
		paths.set(from, dest);
	}
	for (const [from, dest] of assets(md)) paths.set(from, dest);
	if (entry.view && entry.view !== entry.md) paths.set(entry.view, joinFolder(md, nameOf(entry.view)));
	const files = preflight(app, paths);
	const links = planArchiveLinks(app, entry, note, to, new Map(files.map(({ from, to }) => [from, to])));
	return { files, placement, transcript: { from: entry.md, to }, links };
}

async function finishMove(plugin: AIChatBridge, entry: IndexEntry, move: ArchiveMove, rememberView: boolean): Promise<void> {
	const { app, settings } = plugin;
	const finishLinks = async () => {
		if (move.linksDone) return;
		const note = at(app, move.transcript.to);
		if (!note) throw new BlockedMove('transcript disappeared during relocation');
		await rebaseArchiveLinks(app, entry, note, move.links);
		move.linksDone = true;
		await plugin.saveSettings();
	};
	while (move.files.length) {
		const step = move.files[0]!;
		if (step.from !== move.transcript.from) await finishLinks();
		const source = at(app, step.from);
		if (source) {
			if (step.ctime && source.stat.ctime !== step.ctime) throw new BlockedMove(`a different file occupies the source (${step.from})`);
			assertFree(app, step.to);
			await ensureFolder(app, dirOf(step.to));
			assertFree(app, step.to);
			const oldPath = source.path;
			Object.assign(step, source.stat);
			await plugin.saveSettings();
			await app.fileManager.renameFile(source, step.to);
			if (oldPath !== step.from) followRename(settings, oldPath, step.to);
		} else {
			// A crash can leave the rename on disk before the updated index is saved.
			const stat = at(app, step.to)?.stat;
			if (!stat || !step.ctime || stat.ctime !== step.ctime || stat.mtime !== step.mtime || stat.size !== step.size) {
				throw new BlockedMove(`could not verify the previous rename (${step.from})`);
			}
		}
		followRename(settings, step.from, step.to);
		move.files.shift();
		await plugin.saveSettings();
	}
	await finishLinks();
	entry.archive = move.placement;
	if (rememberView) entry.archiveViewMoved = true;
	delete entry.archiveMove;
	await plugin.saveSettings();
}

interface ReconcileOptions {
	items: ListItem[];
	web: { index: Record<string, IndexEntry>; fileIndex: Record<string, string> };
	state: (id: string) => boolean | null | undefined;
	filing: (item: ListItem) => ArchiveFiling;
	progress: ProgressFn;
	rememberView?: boolean;
}

export interface ArchiveCandidate {
	entry: IndexEntry;
	name: string;
	/** The filing destination for an archived chat. Omit when returning it to its active folder. */
	filing?: ArchiveFiling;
}

export async function rememberArchiveObservations(plugin: AIChatBridge, index: ReconcileOptions['web']['index'], items: ListItem[], state: ReconcileOptions['state']): Promise<void> {
	let changed = false;
	for (const { uuid } of items) {
		const entry = index[uuid];
		const archived = state(uuid);
		if (entry && archived !== undefined && entry.archiveObservation !== archived) {
			entry.archiveObservation = archived;
			changed = true;
		}
	}
	if (changed) await plugin.saveSettings();
}

export async function reconcileArchived(plugin: AIChatBridge, { items, web, state, filing, progress, rememberView = false }: ReconcileOptions, report: ArchiveReport): Promise<void> {
	progress('checking archived status…');
	await rememberArchiveObservations(plugin, web.index, items, state);
	const candidates = items.flatMap((item) => {
		const archived = state(item.uuid);
		if (archived === null) report.skipped.push(`${item.name} (conflicting archive status)`);
		const entry = web.index[item.uuid];
		if (!entry || typeof archived !== 'boolean') return [];
		return entry.archiveMove || archived !== !!entry.archive ? [{ entry, name: item.name, filing: archived ? filing(item) : undefined }] : [];
	});
	await moveArchivedChats(plugin, web, candidates, progress, report, rememberView);
}

export async function moveArchivedChats(plugin: AIChatBridge, web: ReconcileOptions['web'], candidates: ArchiveCandidate[], progress: ProgressFn, report: ArchiveReport, rememberView: boolean, restoring = false): Promise<void> {
	if (!candidates.length) return;
	const rawRoot = masterRaw(plugin.settings);
	const linkedByOthers = new Map<string, Set<string>>();
	const indexedPaths = new Set(Object.values(web.fileIndex));
	for (const [source, links] of Object.entries(plugin.app.metadataCache?.resolvedLinks ?? {})) {
		for (const path of Object.keys(links)) {
			if (!indexedPaths.has(path)) continue;
			if (!linkedByOthers.has(path)) linkedByOthers.set(path, new Set());
			linkedByOthers.get(path)!.add(source);
		}
	}
	const otherAssets = new Set([...plugin.settings.claude, ...plugin.settings.chatgpt]
		.filter((a) => a.web !== web).flatMap((a) => Object.values(a.web.fileIndex).map(pathKey)));
	for (const [i, { name, entry, filing }] of candidates.entries()) {
		const phase = `${restoring ? 'returning archived chats' : 'moving archived chats'} ${i + 1} of ${candidates.length}`;
		progress(phase, i, candidates.length, phase);
		try {
			if (entry.archiveMove) await finishMove(plugin, entry, entry.archiveMove, rememberView);
			if (!!entry.archive !== !!filing) {
				entry.archiveMove = planMove(plugin.app, entry, filing, rawRoot, (md) => assetMoves(plugin.app, entry, md, web.fileIndex, otherAssets, linkedByOthers));
				await plugin.saveSettings();
				await finishMove(plugin, entry, entry.archiveMove, rememberView);
			}
			report.moved++;
		} catch (error) {
			const detail = `${name} (${error instanceof Error ? error.message : String(error)})`;
			(error instanceof BlockedMove ? report.skipped : report.failed).push(detail);
		}
	}
}
