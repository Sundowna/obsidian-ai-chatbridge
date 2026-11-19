// Reading and writing the computer files and the busy marker, in the plugin's own folder
// (<vault>/.obsidian/plugins/ai-chatbridge/), which travels with the vault. See split.ts.

import { Platform, type DataAdapter } from 'obsidian';
import { computerName } from '../computer';
import { normalizeSettings } from '../migrate';
import type { Settings } from '../settings';
import { BUSY_FILE, busyElsewhere, idleMarker, parseBusy, runningMarker, type BusyMarker } from './busy';
import { mergeOthers } from './merge';
import {
	COMPUTER_FILE_VERSION, hasMachinePart, isUnsplit, joinSaved, machinePart, machinePaths, parseComputerFile, splitSettings, withoutMachinePart, type ComputerFile,
} from './split';

/** Desktop and Hermes history found in data.json on a computer it did not come from, kept for that one. */
const UNCLAIMED = '_unclaimed.json';
const FOLDER = 'computers';

/** Whether a folder or file path exists on this computer (desktop only). */
function pathExists(path: string): boolean {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (typeof req !== 'function') return false;
		const fs = req('fs') as { existsSync(p: string): boolean };
		const os = req('os') as { homedir(): string };
		const full = path.startsWith('~') ? os.homedir() + path.slice(1) : path;
		return fs.existsSync(full);
	} catch {
		return false;
	}
}

/** True when the desktop and Hermes history in `f` belongs to this computer (or it has none). */
export function belongsHere(f: ComputerFile, exists: (p: string) => boolean = pathExists): boolean {
	const paths = machinePaths(f);
	return paths.length === 0 || paths.some((p) => exists(p));
}

export interface Loaded {
	/** data.json joined with this computer's file, for normalizeSettings. */
	raw: unknown;
	/** data.json still held everything: keep a copy and save once, which splits it. */
	firstSplit: boolean;
	/** Desktop or Hermes history that was not this computer's and was put aside. */
	putAside: boolean;
}

export class ComputerStore {
	/** This computer's name, also its file name. */
	readonly here = computerName();
	private lastOwn = '';
	private lastShared = '';

	constructor(private readonly adapter: () => DataAdapter, private readonly pluginDir: () => string | undefined) {}

	private dir(): string | null {
		const d = this.pluginDir();
		return d ? `${d}/${FOLDER}` : null;
	}

	private ownPath(): string | null {
		const dir = this.dir();
		return dir ? `${dir}/${this.here}.json` : null;
	}

	private async read(path: string): Promise<string | null> {
		try {
			return (await this.adapter().exists(path)) ? await this.adapter().read(path) : null;
		} catch {
			return null;
		}
	}

	private async write(path: string, text: string): Promise<void> {
		const dir = path.slice(0, path.lastIndexOf('/'));
		if (!(await this.adapter().exists(dir))) await this.adapter().mkdir(dir);
		await this.adapter().write(path, text);
	}

	/** data.json (as loaded) plus this computer's file. Splits an old data.json the first time. */
	async load(shared: unknown): Promise<Loaded> {
		this.lastShared = JSON.stringify(shared ?? null);
		const ownPath = this.ownPath();
		// No plugin folder known (never the case inside Obsidian): everything stays in data.json.
		if (!ownPath) return { raw: shared, firstSplit: false, putAside: false };
		let own = parseComputerFile((await this.read(ownPath)) ?? '');
		if (own) this.lastOwn = comparable(own);
		if (shared === null || shared === undefined) return { raw: shared, firstSplit: false, putAside: false };
		if (isUnsplit(shared)) {
			// Everything still sits in data.json. Its web history is fine anywhere (combining only
			// adds); its desktop and Hermes history is only right on the computer it came from.
			const { local } = splitSettings(normalizeSettings(shared).settings, this.here);
			let keep = own ?? local;
			let putAside = false;
			if (!own && hasMachinePart(local) && !belongsHere(local)) {
				await this.putAside(machinePart(local));
				keep = withoutMachinePart(local);
				putAside = true;
			}
			return { raw: joinSaved(shared, keep), firstSplit: true, putAside };
		}
		if (!own) own = await this.adoptUnclaimed();
		return { raw: joinSaved(shared, own), firstSplit: false, putAside: false };
	}

	private async putAside(part: ComputerFile): Promise<void> {
		const dir = this.dir();
		if (!dir) return;
		try {
			await this.write(`${dir}/${UNCLAIMED}`, JSON.stringify(part));
		} catch (e) {
			console.error('AI ChatBridge: could not put the other computer\'s history aside', e instanceof Error ? e.message : e);
		}
	}

	/** A new computer with no file yet takes the history put aside earlier, if it was this one's. */
	private async adoptUnclaimed(): Promise<ComputerFile | null> {
		const dir = this.dir();
		if (!dir) return null;
		const f = parseComputerFile((await this.read(`${dir}/${UNCLAIMED}`)) ?? '');
		if (!f || !hasMachinePart(f) || machinePaths(f).length === 0 || !belongsHere(f)) return null;
		// Left empty rather than deleted: nothing in the plugin's folders is ever deleted.
		await this.write(`${dir}/${UNCLAIMED}`, JSON.stringify({ v: COMPUTER_FILE_VERSION, computer: '', savedAt: new Date().toISOString(), accounts: {} }));
		return { ...f, computer: this.here };
	}

	/** Writes data.json (only when what you set changed) and this computer's file (when its history changed). */
	async save(s: Settings, saveData: (data: unknown) => Promise<void>): Promise<void> {
		// No plugin folder known: keep everything in data.json, as before, rather than lose the history.
		if (!this.ownPath()) {
			await saveData(s);
			return;
		}
		const { shared, local } = splitSettings(s, this.here);
		const sharedText = JSON.stringify(shared);
		if (sharedText !== this.lastShared) {
			await saveData(shared);
			this.lastShared = sharedText;
		}
		// A phone does not sync by itself, so it has no history of its own to keep.
		if (Platform.isMobile) return;
		const text = comparable(local);
		const path = this.ownPath();
		if (!path || text === this.lastOwn) return;
		await this.write(path, JSON.stringify(local));
		this.lastOwn = text;
	}

	/** data.json changed on disk: is it something other than what we wrote? */
	isNewShared(loaded: unknown): boolean {
		return JSON.stringify(loaded ?? null) !== this.lastShared;
	}

	noteShared(loaded: unknown): void {
		this.lastShared = JSON.stringify(loaded ?? null);
	}

	/** Every other computer's file (and copies a sync tool made of one when both changed it). */
	async others(): Promise<ComputerFile[]> {
		const dir = this.dir();
		if (!dir) return [];
		let files: string[];
		try {
			if (!(await this.adapter().exists(dir))) return [];
			files = (await this.adapter().list(dir)).files;
		} catch {
			return [];
		}
		const out: ComputerFile[] = [];
		const own = this.ownPath();
		for (const path of files) {
			if (!path.endsWith('.json') || path === own || path.endsWith(`/${UNCLAIMED}`)) continue;
			const f = parseComputerFile((await this.read(path)) ?? '');
			if (f) out.push(f);
		}
		return out;
	}

	/** Brings in what the other computers synced. Returns how many chats were learned or updated. */
	async mergeOthers(s: Settings, exists: (path: string) => boolean): Promise<number> {
		if (Platform.isMobile) return 0;
		return mergeOthers(s, await this.others(), this.here, exists);
	}

	// --- the busy marker ---------------------------------------------------------

	private busyPath(): string | null {
		const d = this.pluginDir();
		return d ? `${d}/${BUSY_FILE}` : null;
	}

	/** Another computer that is syncing right now, or null. */
	async busyElsewhere(now = Date.now()): Promise<BusyMarker | null> {
		const path = this.busyPath();
		if (!path) return null;
		return busyElsewhere(parseBusy((await this.read(path)) ?? ''), this.here, now);
	}

	async markRunning(startedAt: number): Promise<void> {
		await this.writeBusy(runningMarker(this.here, startedAt, Date.now()));
	}

	async markIdle(): Promise<void> {
		await this.writeBusy(idleMarker(this.here, Date.now()));
	}

	private async writeBusy(m: BusyMarker): Promise<void> {
		const path = this.busyPath();
		if (!path) return;
		try {
			await this.adapter().write(path, JSON.stringify(m));
		} catch (e) {
			console.error('AI ChatBridge: could not write the busy marker', e instanceof Error ? e.message : e);
		}
	}
}

/** A computer file without its save time, to tell whether anything changed. */
function comparable(f: ComputerFile): string {
	return JSON.stringify({ ...f, savedAt: '' });
}
