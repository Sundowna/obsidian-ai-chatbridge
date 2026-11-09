// Keeps the plugin's index right when you move or rename synced files/folders in
// Obsidian, so nothing is fetched again just because it moved. (Deletions need no
// handling here: the next sync notices missing files and restores them.)

import type { IndexEntry } from './types';
import type { Settings } from './settings';

/** Rewrites every index path at or under `oldPath` to `newPath`. Returns how many changed. */
export function followRename(s: Settings, oldPath: string, newPath: string): number {
	const fix = (p: string): string =>
		p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? `${newPath}${p.slice(oldPath.length)}` : p;
	let changed = 0;

	const followIndex = (entries: IndexEntry[], fileIndex: Record<string, string>): void => {
		for (const entry of entries) {
			for (const key of ['json', 'md', 'view'] as const) {
				const previous = entry[key];
				if (!previous) continue;
				const next = fix(previous);
				if (next !== previous) {
					entry[key] = next;
					changed++;
				}
			}
			entry.older = entry.older?.map((p) => {
				const next = fix(p);
				if (next !== p) changed++;
				return next;
			});
		}
		for (const [id, p] of Object.entries(fileIndex)) {
			if (p.startsWith('skipped: ')) continue;
			const next = fix(p);
			if (next !== p) {
				fileIndex[id] = next;
				changed++;
			}
		}
	};

	// Every account keeps its own indexes; all of them follow moves.
	for (const { web } of s.claude) followIndex(Object.values(web.index), web.fileIndex);
	for (const { web } of s.chatgpt) followIndex([...Object.values(web.index), ...Object.values(web.pendingCaptures ?? {})], web.fileIndex);

	// Desktop app sessions: transcript and raw copy.
	for (const { desktop } of [...s.claude, ...s.chatgpt]) {
		for (const entry of Object.values(desktop.index)) {
			for (const key of ['md', 'raw'] as const) {
				const previous = entry[key];
				if (!previous) continue;
				const next = fix(previous);
				if (next !== previous) {
					entry[key] = next;
					changed++;
				}
			}
		}
	}
	return changed;
}
