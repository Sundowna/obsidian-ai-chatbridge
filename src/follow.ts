// Keeps the plugin's index right when you move or rename synced files/folders in
// Obsidian, so nothing is fetched again just because it moved. (Deletions need no
// handling here: the next sync notices missing files and restores them.)

import type { Settings } from './settings';

/** Rewrites every index path at or under `oldPath` to `newPath`. Returns how many changed. */
export function followRename(s: Settings, oldPath: string, newPath: string): number {
	const fix = (p: string): string =>
		p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? `${newPath}${p.slice(oldPath.length)}` : p;
	let changed = 0;
	// claude.ai and ChatGPT keep separate indexes; both follow moves.
	const sets: { index: Settings['index']; fileIndex: Settings['fileIndex'] }[] = [s];
	if (s.gpt) sets.push(s.gpt);
	for (const set of sets) {
		const pending = set === s.gpt ? Object.values(s.gpt.pendingCaptures ?? {}) : [];
		for (const entry of [...Object.values(set.index), ...pending]) {
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
		for (const [id, p] of Object.entries(set.fileIndex)) {
			if (p.startsWith('skipped: ')) continue;
			const next = fix(p);
			if (next !== p) {
				set.fileIndex[id] = next;
				changed++;
			}
		}
	}
	return changed;
}
