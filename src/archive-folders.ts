import { dirOf, mirrorRaw, rawBase, type ChatFolders } from './raw-folders';
import { plainFolder } from './select';
import type { Settings } from './settings';
import type { ArchiveLinkPlan } from './archive-links';

export interface ArchivedPlacement {
	root: string;
	active: ChatFolders;
	/** Overrides for older pages or versions that were already in another folder. */
	rawOrigins?: Record<string, string>;
}

export interface ArchiveMoveFile {
	from: string;
	to: string;
	size: number;
	mtime: number;
	ctime: number;
}

export interface ArchiveMove {
	files: ArchiveMoveFile[];
	placement?: ArchivedPlacement;
	transcript: { from: string; to: string };
	links: ArchiveLinkPlan;
	linksDone?: boolean;
}

export const pathKey = (path: string): string => path.normalize('NFC').toLowerCase();

export function subpath(path: string, root: string): string | undefined {
	if (!root) return path;
	const parts = path.split('/');
	const prefix = root.split('/');
	if (prefix.some((part, i) => pathKey(part) !== pathKey(parts[i] ?? ''))) return undefined;
	return parts.slice(prefix.length).join('/');
}

export const joinFolder = (folder: string, child: string): string => folder && child ? `${folder}/${child}` : folder || child;

export function archiveRoot(settings: Settings, provider: 'claude' | 'chatgpt', id: string, base: string): string {
	const owners = [
		...settings.claude.map(({ id, web }) => ({ id, provider: 'claude', base: web.chatFolder })),
		...settings.chatgpt.map(({ id, web }) => ({ id, provider: 'chatgpt', base: web.folder })),
	];
	const primary = owners.find((a) => pathKey(plainFolder(a.base) ?? '') === pathKey(base));
	return primary && (primary.id !== id || primary.provider !== provider) ? `${base}/Archived/_Accounts/${provider}-${id}` : `${base}/Archived`;
}

export function archivedMd(active: string, base: string, root: string, projectSubfolders: boolean): string {
	if (!projectSubfolders) return root;
	const relative = subpath(active, base);
	// Reserve _External and _Accounts for the layouts distinguished by those path components.
	if (relative === undefined) return joinFolder(`${root}/_External`, active);
	return /^_(External|Accounts|Projects)(\/|$)/i.test(relative) ? `${root}/_Projects/${relative}` : joinFolder(root, relative);
}

export function archivedRaw(active: ChatFolders, md: string, base: string, root: string, rawSetting: string | undefined, rawRoot: string | undefined, projectRaw = false): string {
	if (rawRoot !== undefined) return mirrorRaw(md, rawRoot);
	if (projectRaw) return active.raw;
	if (pathKey(active.md) === pathKey(active.raw)) return md;
	const accountRaw = rawBase(rawSetting);
	if (!accountRaw) return active.raw;
	const sub = subpath(active.raw, accountRaw);
	if (sub === undefined) return active.raw; // An explicit external override keeps its own raw folder.
	return joinFolder(joinFolder(accountRaw, subpath(root, base) ?? 'Archived'), sub);
}

export function rawDestination(from: string, active: ChatFolders, md: string, raw: string, rawRoot: string | undefined): string {
	const folder = dirOf(from);
	if (pathKey(folder) === pathKey(active.raw) || rawRoot !== undefined) return raw;
	if (pathKey(folder) === pathKey(active.md)) return md;
	return folder;
}
