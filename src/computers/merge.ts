// What the other computers synced, read before each sync: a chat that another computer saved
// yesterday is known here too, so it is not fetched again and no second note is written.
// Combining only ever adds. Pure functions, no Obsidian.

import type { LastRun } from '../last-run';
import type { ProjectCatalog } from '../project-catalog';
import type { Settings } from '../settings';
import { accountKey, type ComputerFile, PROVIDERS, type Provider } from './split';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which saved note a history entry points to, and when it was written. */
interface Entry {
	md?: unknown;
	synced?: unknown;
	updated?: unknown;
	updated_at?: unknown;
}

const stamp = (e: Entry): string => (typeof e.synced === 'string' ? e.synced : '') || (typeof e.updated === 'string' ? e.updated : '') || (typeof e.updated_at === 'string' ? e.updated_at : '');

/**
 * Two computers remember the same chat differently: the one whose note is in the vault wins
 * (the other may still point to a name from before a rename), then the newer one, then ours.
 */
export function pickEntry<T>(ours: T, theirs: T, exists: (path: string) => boolean): T {
	if (JSON.stringify(ours) === JSON.stringify(theirs)) return ours;
	const a = ours as Entry;
	const b = theirs as Entry;
	const aHere = typeof a.md === 'string' && a.md !== '' && exists(a.md);
	const bHere = typeof b.md === 'string' && b.md !== '' && exists(b.md);
	if (aHere !== bHere) return aHere ? ours : theirs;
	return stamp(b) > stamp(a) ? theirs : ours;
}

/** Adds `theirs` into `ours` (in place). Returns how many entries were new or replaced. */
export function mergeIndex(ours: Obj, theirs: unknown, exists: (path: string) => boolean): number {
	if (!isObj(theirs)) return 0;
	let n = 0;
	for (const [id, entry] of Object.entries(theirs)) {
		if (!isObj(entry)) continue;
		const mine = ours[id];
		if (mine === undefined) {
			ours[id] = entry;
			n++;
		} else if (pickEntry(mine, entry, exists) !== mine) {
			ours[id] = entry;
			n++;
		}
	}
	return n;
}

/** file_uuid -> vault path: a file someone already downloaded is not downloaded again. */
function mergeFiles(ours: Record<string, string>, theirs: unknown): number {
	if (!isObj(theirs)) return 0;
	let n = 0;
	for (const [id, path] of Object.entries(theirs)) {
		if (typeof path === 'string' && ours[id] === undefined) {
			ours[id] = path;
			n++;
		}
	}
	return n;
}

function newerCatalog(ours: ProjectCatalog | undefined, theirs: unknown): ProjectCatalog | undefined {
	if (!isObj(theirs) || typeof theirs.fetchedAt !== 'string' || !Array.isArray(theirs.rows)) return ours;
	if (ours && ours.fetchedAt >= theirs.fetchedAt) return ours;
	return theirs as unknown as ProjectCatalog;
}

/** Index fields per provider that are combined (the rest of a computer's state stays its own). */
const MERGED: Record<Provider, readonly string[]> = {
	claude: ['index', 'cloudIndex'],
	chatgpt: ['index', 'codexCloudIndex'],
	lumo: ['index'],
	gemini: ['index'],
};

/**
 * Brings what the other computers synced into `s` (in place). Desktop apps and Hermes are not
 * combined: their sessions live on one computer. Returns the number of chats learned or updated.
 */
export function mergeOthers(s: Settings, others: ComputerFile[], here: string, exists: (path: string) => boolean): number {
	let n = 0;
	for (const other of others) {
		if (other.computer === here) continue;
		for (const provider of PROVIDERS) {
			for (const account of s[provider]) {
				const own = other.accounts[accountKey(provider, account.id)];
				if (!own) continue;
				const web = account.web as unknown as Obj;
				if (own.web) {
					for (const field of MERGED[provider]) {
						if (own.web[field] === undefined) continue;
						if (!isObj(web[field])) web[field] = {};
						n += mergeIndex(web[field] as Obj, own.web[field], exists);
					}
					if (provider === 'claude' || provider === 'chatgpt') {
						if (!isObj(web.fileIndex)) web.fileIndex = {};
						mergeFiles(web.fileIndex as Record<string, string>, own.web.fileIndex);
					}
					if ('projectCatalog' in own.web) web.projectCatalog = newerCatalog(web.projectCatalog as ProjectCatalog | undefined, own.web.projectCatalog);
				}
				if (provider === 'gemini' && own.studio && 'studio' in account) {
					const studio = account.studio as unknown as Obj;
					if (!isObj(studio.index)) studio.index = {};
					n += mergeIndex(studio.index as Obj, own.studio.index, exists);
				}
			}
		}
		// AI memory: the web sources are the same account everywhere; local ones are named after
		// their computer, so they never meet.
		if (isObj(other.memoryStates)) {
			const states = s.memory.states as unknown as Obj;
			for (const [key, state] of Object.entries(other.memoryStates)) {
				if (!isObj(state)) continue;
				const mine = states[key];
				const at = (o: Obj): string => (typeof o.synced === 'string' ? o.synced : '');
				if (!isObj(mine) || at(state) > at(mine)) states[key] = state;
			}
		}
		if (isObj(other.lastRuns)) mergeRuns(s.lastRuns, other.lastRuns, other.computer, here);
	}
	return n;
}

/** The newest run of each kind, marked with the computer that ran it when that was not this one. */
export function mergeRuns(ours: Record<string, LastRun>, theirs: Obj, computer: string, here: string): number {
	let n = 0;
	for (const [key, run] of Object.entries(theirs)) {
		if (!isObj(run) || typeof run.at !== 'number') continue;
		const r = { ...(run as unknown as LastRun) };
		const by = r.device ?? computer;
		if (by === here) delete r.device;
		else r.device = by;
		const mine = ours[key];
		if (!mine || r.at > mine.at) {
			ours[key] = r;
			n++;
		}
	}
	return n;
}
