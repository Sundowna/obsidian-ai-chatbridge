// "Merge N chats" pressed while a sync runs: the merge waits for that sync and then starts by
// itself, instead of being refused with a notice that is easy to miss. While it waits, only a
// sync started by hand may go first; the automatic sync, a retry and another device's request wait.

/** What the merge needs from the plugin while it waits. */
export interface MergeStartHost {
	/** A sync (or a project-list fetch) is running. */
	running(): boolean;
	/** The plugin is being switched off or reloaded. */
	unloaded(): boolean;
	/** Tries to start the merge. True when it ran; false when it was refused or something got in first. */
	start(): Promise<boolean>;
	/** Resolves when the running sync has ended (or the plugin is unloaded). */
	idle(): Promise<void>;
	/** Called once, the first time the merge has to wait. */
	waiting(): void;
}

/** More waits than this means something keeps starting in between: give up rather than wait for ever. */
const MAX_WAITS = 50;

/** Starts the merge now, or as soon as the running sync has ended. True when it ran. */
export async function startMergeWhenIdle(host: MergeStartHost): Promise<boolean> {
	let told = false;
	for (let waits = 0; waits <= MAX_WAITS; ) {
		if (host.unloaded()) return false;
		if (host.running()) {
			if (!told) host.waiting();
			told = true;
			waits++;
			await host.idle();
			continue;
		}
		if (await host.start()) return true;
		// Refused (you said no because another computer syncs, the plugin was unloaded, …), unless
		// a sync started by hand slipped in first: then wait for that one too.
		if (!host.running()) return false;
	}
	return false;
}

/** Which syncs may start while a merge waits: only one started by hand. */
export function mayStartWhileMergeWaits(trigger: string, mergeWaiting: boolean): boolean {
	return !mergeWaiting || trigger === 'manual';
}

export const MERGE_WAITING_TEXT = 'A sync is running. The merge starts by itself when it has finished.';
export const MERGE_NOT_STARTED_TEXT = 'The merge did not start. Nothing was changed.';
export const MERGE_NOT_STOPPED_TEXT = "Merging chat copies: it finishes by itself in a few minutes. To stop it anyway, run the command 'Stop the running sync'.";
