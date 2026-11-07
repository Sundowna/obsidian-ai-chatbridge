import { ShapeError } from '../schema';
import { checkGptList } from './schema';
import type { GptListItem } from './types';

const MAX_PAGES = 300;
const WEEK = 7 * 24 * 60 * 60_000;
export const DEFAULT_OVERLAP_MINUTES = 10;

type ListKey = 'active-normal' | 'active-tpp' | 'archived-normal' | 'archived-tpp';

interface Checkpoint {
	watermark: number | null;
	fullAt: number;
}

export interface Inventory {
	scope: string;
	generation: number;
	checkpoints: Partial<Record<ListKey, Checkpoint>>;
	manual?: ListKey[];
	known: Record<string, { item: GptListItem; generation: number }>;
	queue: Record<string, GptListItem>;
}

export interface Inventories {
	accounts: Record<string, Inventory>;
	session?: { key: string; inventory: Inventory };
}

export function accountInventory(state: Inventories, key: string, scope: string): Inventory {
	const fresh = (): Inventory => ({ scope, generation: 0, checkpoints: {}, known: {}, queue: {} });
	let inventory: Inventory;
	if (key.startsWith('session:')) {
		if (state.session?.key !== key) state.session = { key, inventory: fresh() };
		inventory = state.session.inventory;
	} else {
		inventory = state.accounts[key] ??= fresh();
	}
	if (inventory.scope !== scope) {
		inventory.scope = scope;
		inventory.generation++;
		inventory.checkpoints = {};
		delete inventory.manual;
	}
	return inventory;
}

/** Compare service timestamps, including fractional seconds finer than Date.parse supports. */
export function compareRevision(a: string, b: string): number {
	const millis = Date.parse(a) - Date.parse(b);
	if (millis) return millis;
	const fraction = (value: string) => /\.(\d+)Z$/i.exec(value)?.[1]?.padEnd(9, '0') ?? '';
	const left = fraction(a);
	const right = fraction(b);
	return left === right ? 0 : left > right ? 1 : -1;
}

export function completeInventoryJob(inventory: Inventory, id: string, capturedRevision: string): void {
	if (inventory.queue[id]?.update_time === capturedRevision) delete inventory.queue[id];
}

interface ScanOptions {
	archived: boolean;
	overlapMinutes: number;
	forceFull: boolean;
	now: number;
	fetch: (offset: number, tpp: boolean, archived: boolean) => Promise<unknown>;
	save: () => Promise<void>;
	needsCapture: (item: GptListItem) => boolean;
}

export interface ScanStats {
	requests: number;
	fullLists: number;
	incrementalLists: number;
	seen: Set<string>;
}

/** Each completed page persists discoveries before a separate save advances the list watermark. */
export async function scanInventory(inventory: Inventory, options: ScanOptions, stats: ScanStats): Promise<void> {
	const lists: ListKey[] = ['active-normal', 'active-tpp'];
	if (options.archived) lists.push('archived-normal', 'archived-tpp');
	if (options.forceFull && !inventory.manual?.length) {
		inventory.manual = [...lists];
		await options.save();
	}
	const configured = options.overlapMinutes;
	const overlap = (Number.isFinite(configured) ? Math.max(1, Math.min(1440, configured)) : DEFAULT_OVERLAP_MINUTES) * 60_000;
	for (const list of lists) {
		const previous = inventory.checkpoints[list];
		let full = !previous || options.now - previous.fullAt >= WEEK || inventory.manual?.includes(list) === true;
		const cutoff = !full && previous?.watermark != null ? previous.watermark - overlap : -Infinity;
		let ordered = true;
		let reliableTime = true;
		let head: number | null = null;
		let oldest = Infinity;
		let offset = 0;
		let repeats = 0;
		const listSeen = new Set<string>();
		for (let page = 0; ; page++) {
			if (page >= MAX_PAGES) throw new ShapeError('ChatGPT inventory exceeded its page limit.');
			stats.requests++;
			const response = checkGptList(await options.fetch(offset, list.endsWith('-tpp'), list.startsWith('archived-')));
			if (response.offset !== offset) throw new ShapeError('ChatGPT list returned the wrong offset.');
			let pageNewest = -Infinity;
			let newestInPage = Infinity;
			let discovered = 0;
			for (const item of response.items) {
				const time = Date.parse(item.update_time);
				if (time > options.now + 5 * 60_000) reliableTime = false;
				if (time > newestInPage) ordered = false;
				newestInPage = time;
				pageNewest = Math.max(pageNewest, time);
				if (!listSeen.has(item.id)) {
					if (time > oldest) ordered = false;
					oldest = time;
					listSeen.add(item.id);
					discovered++;
				}
				stats.seen.add(item.id);
				const known = inventory.known[item.id];
				if (!known || compareRevision(item.update_time, known.item.update_time) >= 0) {
					inventory.known[item.id] = { item, generation: inventory.generation };
				}
				const job = inventory.queue[item.id];
				if (options.needsCapture(item) && (!job || compareRevision(item.update_time, job.update_time) >= 0)) {
					inventory.queue[item.id] = item;
				}
			}
			if (page === 0 && response.items.length) head = pageNewest;
			if (head !== null && previous?.watermark === null) full = true;
			if (response.items.length) await options.save();
			if (!ordered || !reliableTime) full = true;
			const end = response.items.length === 0 || offset + response.items.length >= response.total;
			if (end || (!full && pageNewest < cutoff)) break;
			repeats = discovered ? 0 : repeats + 1;
			if (repeats >= 3) throw new ShapeError('ChatGPT inventory kept repeating the same rows.');
			// Overlap offsets as well as timestamps. An edit can move a row to the head mid-scan.
			offset += response.items.length - Math.min(2, response.items.length - 1);
		}
		const beforeManual = inventory.manual;
		inventory.checkpoints[list] = { watermark: ordered && reliableTime ? head : null, fullAt: full ? options.now : previous!.fullAt };
		if (beforeManual) inventory.manual = beforeManual.filter((key) => key !== list);
		try {
			await options.save();
		} catch (error) {
			if (previous) inventory.checkpoints[list] = previous;
			else delete inventory.checkpoints[list];
			inventory.manual = beforeManual;
			throw error;
		}
		if (full) stats.fullLists++;
		else stats.incrementalLists++;
	}
}
