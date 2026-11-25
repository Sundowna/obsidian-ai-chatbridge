import { normalizePath, Platform, TFile, TFolder, type App } from 'obsidian';
import { followRename } from '../follow';
import { baseRoot, dirOf, masterRaw, projectRoots, rawLink, rawTarget, type RawMove } from '../raw-folders';
import { plainFolder } from '../select';
import type { ChatgptAccount, Settings } from '../settings';
import { ensureFolder, findFile } from '../vaultio';
import { versionFiles } from '../versions';

const keyOf = (path: string): string => {
	const pathNfc = normalizePath(path).normalize('NFC');
	return Platform.isMacOS || Platform.isWin || Platform.isIosApp ? pathNfc.toLowerCase() : pathNfc;
};

const under = (path: string, folder: string): boolean => keyOf(path).startsWith(`${keyOf(folder)}/`);
const relativeTo = (path: string, folder: string): string => path.split('/').slice(folder.split('/').length).join('/');

/** Change the default folder for one ChatGPT Web account, including its saved chats there. */
export function planChatgptFolderMove(settings: Settings, account: ChatgptAccount, to: string) {
	const web = account.web;
	const from = web.folder;
	const custom = web.onlyProjects && web.customProjectFolders
		? Object.values(web.projectFolders ?? {}).flatMap((value) => plainFolder(value) ?? []) : [];
	const usesDefault = (path: string): boolean => under(path, from) && !custom.some((folder) => under(path, folder));
	const rawRoot = masterRaw(settings);
	const projectNames = new Map(web.projectCatalog?.rows.map(({ id, name }) => [id, name]));
	const roots = (base: string) => [
		baseRoot(base, web.rawFolder, rawRoot),
		...projectRoots(web, base, web.rawFolder, (id) => projectNames.get(id), web.recentFolderName, rawRoot),
	];
	const oldRoots = roots(from);
	const newRoots = roots(to);
	// Pick the project root from the original transcript, even if the destination is
	// inside another project's custom folder.
	const targetRoots = oldRoots.map(({ md }, index) => ({ md, raw: newRoots[index]!.raw }));
	const moves = new Map<string, RawMove>();
	const chats = Object.values(web.index).filter((entry) => usesDefault(entry.md));
	const unfinished = Object.values(web.pendingCaptures ?? {}).some((entry) => usesDefault(entry.md));
	const add = (source: string, target: string) => {
		if (keyOf(source) === keyOf(target)) return;
		const previous = moves.get(keyOf(source));
		if (previous && previous.to !== target) throw new Error(`The file has two destinations: ${source}`);
		moves.set(keyOf(source), { from: source, to: target });
	};
	for (const entry of chats) {
		const md = `${to}/${relativeTo(entry.md, from)}`;
		for (const path of [entry.json, ...(entry.older ?? []), ...versionFiles(entry)]) {
			if (!path) continue;
			const oldRaw = rawTarget({ md: entry.md, raws: [] }, path, oldRoots);
			const newRaw = rawTarget({ md: entry.md, raws: [] }, path, targetRoots);
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

/** Refresh the plugin's raw links even when Obsidian's automatic link updates are disabled. */
async function updateRawLinks(app: App, chats: ReturnType<typeof planChatgptFolderMove>['chats']): Promise<void> {
	for (const entry of chats) {
		const file = findFile(app, entry.md);
		if (!(file instanceof TFile)) continue;
		const link = (path: string) => `[[${rawLink(dirOf(entry.md), path)}]]`;
		const raw = link(entry.json);
		const earlier = (entry.versions ?? []).flatMap(({ files }) => files[0] ? [link(files[0])] : []);
		const properties = app.metadataCache.getFileCache(file)?.frontmatter;
		if (properties?.raw === raw && JSON.stringify(properties.earlier_raw ?? []) === JSON.stringify(earlier)) continue;
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.raw = raw;
			if (earlier.length) fm.earlier_raw = earlier;
		});
	}
}

export async function moveChatgptFolder(
	app: App, settings: Settings, account: ChatgptAccount, to: string, save: () => Promise<void>, stopping: () => boolean,
): Promise<number> {
	const web = account.web;
	const from = web.folder;
	if (keyOf(from) === keyOf(to)) return 0;
	const plan = planChatgptFolderMove(settings, account, to);
	if (plan.unfinished) throw new Error('Finish syncing the interrupted ChatGPT download before moving its folder.');
	const target = findFile(app, to);
	if (target && !(target instanceof TFolder)) throw new Error(`Destination folder is occupied: ${to}`);
	checkDestinations(app, plan.moves);
	for (const folder of new Set(plan.moves.map(({ to: path }) => dirOf(path)))) await ensureFolder(app, folder);

	const moved: RawMove[] = [];
	try {
		for (const step of plan.moves) {
			if (stopping()) throw new Error('The folder move was stopped.');
			await rename(app, settings, step);
			moved.push(step);
		}
		if (stopping()) throw new Error('The folder move was stopped.');
		if (moved.length) await updateRawLinks(app, plan.chats);
		web.folder = to;
		await save();
		return plan.chats.length;
	} catch (error) {
		web.folder = from;
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
		throw error;
	}
}
