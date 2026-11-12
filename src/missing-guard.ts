// A safety stop before a sync restores or downloads again the chats it cannot find.
//
// One or two missing chats are normal (you deleted a note; the sync puts it back). Many at
// once means the sync history points at the wrong place: chats moved outside Obsidian, or an
// older copy of the settings. Restoring them all would fill the old folders with duplicates
// (and, for ChatGPT, download every chat again), so the sync stops and says what to do.

export class MassMissingError extends Error {}

/** Many missing at once: at least 10, and more than a fifth of what was saved. */
export function massMissing(saved: number, missing: number): boolean {
	return missing >= 10 && missing > saved * 0.2;
}

/** Stops the sync (throws) when too many saved chats are missing. */
export function guardMissing(label: string, saved: number, missing: number): void {
	if (!massMissing(saved, missing)) return;
	throw new MassMissingError(
		`${missing} of ${saved} saved ${label} are not where the sync history says, so nothing was restored or downloaded again. ` +
		'If you moved them outside Obsidian, select "Refresh index" in the General tab, then sync again.',
	);
}
