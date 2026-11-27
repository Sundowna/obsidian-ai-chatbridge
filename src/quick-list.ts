// Quick list: a sync that reads only the recent part of a service's chat list.
//
// A service that hands out its chats newest change first lets a sync stop at the first page
// that holds nothing new. The rest of the list is taken from the catalog: the rows as they
// were last read. So everything after the list (changed chats, restoring deleted notes, missing
// files, starred, archive) still sees the whole list, as before.
//
// The order is never assumed: a quick read is only trusted when the last full read of this
// account really came newest change first, from the first row to the last. The whole list is
// read again once a week (chats deleted on the service, and star or archive changes on old
// chats, do not move a chat to the top), after a run that failed, and whenever the scope changes.
// Pure: no Obsidian, no requests.

import type { ListItem } from './types';

export const FULL_LIST_EVERY = 7 * 24 * 3600_000;

export interface CatalogRow {
	item: ListItem;
	/** Read from the service's list of archived chats. null = seen in both lists. */
	archived: boolean | null;
}

export interface ListCatalog {
	/** What the list covered. A different scope means a full read. */
	scope: string;
	/** When the whole list was last read (ms). */
	fullAt: number;
	/** That full read, and every read since, came newest change first throughout. */
	ordered: boolean;
	/** A run failed since: the next one reads the whole list. */
	stale?: boolean;
	rows: CatalogRow[];
}

/** Only what the sync uses of a list row; the service sends much more. */
function slim(it: ListItem): ListItem {
	const out: ListItem = { uuid: it.uuid, name: it.name, created_at: it.created_at, updated_at: it.updated_at };
	if (it.project) out.project = { name: it.project.name, uuid: it.project.uuid };
	else if (it.project === null) out.project = null;
	if (typeof it.project_uuid === 'string') out.project_uuid = it.project_uuid;
	if (typeof it.platform === 'string') out.platform = it.platform;
	if (typeof it.is_starred === 'boolean') out.is_starred = it.is_starred;
	return out;
}

const same = (a: ListItem, b: ListItem): boolean => JSON.stringify(slim(a)) === JSON.stringify(slim(b));

/** Whether this run has to read the whole list. */
export function needsFullList(catalog: ListCatalog | undefined, scope: string, now: number): boolean {
	return !catalog || !Array.isArray(catalog.rows) || catalog.scope !== scope || !catalog.ordered || catalog.stale === true ||
		!(now - catalog.fullAt < FULL_LIST_EVERY) || catalog.fullAt > now;
}

/** One list read: fed page by page, it says when to stop and puts the list together at the end. */
export class ListRead {
	private readonly known = new Map<string, CatalogRow>();
	private readonly seen: CatalogRow[] = [];
	private readonly last = new Map<boolean, number>();
	private ordered = true;
	private changed = false;
	/** A list was left before its end. */
	cut = false;

	constructor(private readonly catalog: ListCatalog | undefined, private readonly scope: string, private readonly now: number, private readonly full: boolean) {
		if (!full) for (const row of catalog!.rows) this.known.set(row.item.uuid, row);
	}

	/** Takes one page of the normal or the archived list. True = nothing new on it, stop reading this list. */
	page(items: ListItem[], archived: boolean): boolean {
		let settled = items.length > 0;
		for (const item of items) {
			const at = Date.parse(item.updated_at);
			const before = this.last.get(archived);
			if (!Number.isFinite(at) || (before !== undefined && at > before)) this.ordered = false;
			else this.last.set(archived, at);
			this.seen.push({ item: slim(item), archived });
			const row = this.known.get(item.uuid);
			if (!row || row.archived !== archived || !same(row.item, item)) {
				settled = false;
				this.changed = true;
			}
		}
		if (this.full || !this.ordered || !settled) return false;
		this.cut = true;
		return true;
	}

	/** The whole list (read rows first, then the remembered rest), each chat once, and the catalog to keep. */
	done(): { rows: CatalogRow[]; catalog: ListCatalog; changed: boolean } {
		const byId = new Map<string, CatalogRow>();
		const rows: CatalogRow[] = [];
		for (const row of this.seen) {
			const first = byId.get(row.item.uuid);
			if (first) {
				if (first.archived !== row.archived) first.archived = null;
				continue;
			}
			byId.set(row.item.uuid, row);
			rows.push(row);
		}
		if (this.cut) for (const row of this.catalog!.rows) if (!byId.has(row.item.uuid)) rows.push(row);
		const catalog: ListCatalog = { scope: this.scope, fullAt: this.cut ? this.catalog!.fullAt : this.now, ordered: this.ordered, rows };
		return { rows, catalog, changed: this.changed || !this.cut || !this.ordered };
	}
}
