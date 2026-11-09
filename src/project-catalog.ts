// The list behind the project picker, and what ticking a box does to the saved selection.
// Pure functions, testable offline.

import { NO_PROJECT } from './select';
import type { ListItem } from './types';

export interface CatalogRow {
	id: string;
	name: string;
	/** Known only where the fetch reads the chat list (claude.ai, Lumo). */
	chats?: number;
	/** Not on the list the previous fetch returned. */
	isNew?: boolean;
}

/** Saved per account, so the picker opens without asking the website again. */
export interface ProjectCatalog {
	fetchedAt: string;
	rows: CatalogRow[];
	/** Why the list may be incomplete. */
	note?: string;
}

export interface PickerRow extends CatalogRow {
	/** Selected, but the last fetch did not list it. */
	orphan?: boolean;
}

const NO_PROJECT_ROW: CatalogRow = { id: NO_PROJECT, name: 'Chats without a project' };

function sorted(rows: CatalogRow[]): CatalogRow[] {
	return [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** One row per project in the chats or in `known`, with "no project" first. */
export function rowsFromChats(items: ListItem[], known: { uuid: string; name: string }[] = []): CatalogRow[] {
	const byId = new Map<string, CatalogRow>(known.map((p) => [p.uuid, { id: p.uuid, name: p.name, chats: 0 }]));
	let loose = 0;
	for (const { project } of items) {
		if (!project) {
			loose++;
			continue;
		}
		const row = byId.get(project.uuid);
		if (row) row.chats = (row.chats ?? 0) + 1;
		else byId.set(project.uuid, { id: project.uuid, name: project.name, chats: 1 });
	}
	return [{ ...NO_PROJECT_ROW, chats: loose }, ...sorted([...byId.values()])];
}

/** One row per project the website named, with "no project" first. */
export function rowsFromProjects(projects: { id: string; name: string }[]): CatalogRow[] {
	return [{ ...NO_PROJECT_ROW }, ...sorted(projects.map((p) => ({ id: p.id, name: p.name })))];
}

/** Marks what the previous fetch did not have. The first fetch marks nothing. */
export function markNew(rows: CatalogRow[], previous: ProjectCatalog | undefined): CatalogRow[] {
	if (!previous) return rows;
	const known = new Set(previous.rows.map((r) => r.id));
	return rows.map((r) => (known.has(r.id) || r.id === NO_PROJECT ? r : { ...r, isNew: true }));
}

/** A saved entry can be an ID, or a name from when projects were typed in by hand. */
function entryMatches(entry: string, row: CatalogRow, recent: string): boolean {
	const e = entry.trim().toLowerCase();
	if (e === row.id.toLowerCase()) return true;
	return e === (row.id === NO_PROJECT ? recent : row.name).trim().toLowerCase();
}

export function isSelected(row: CatalogRow, selected: string[], recent: string): boolean {
	return selected.some((e) => entryMatches(e, row, recent));
}

/** The catalog without its unselected rows, or undefined if none are left. For what gets saved. */
export function onlySelected(catalog: ProjectCatalog | undefined, selected: string[], recent: string): ProjectCatalog | undefined {
	if (!catalog) return undefined;
	const rows = catalog.rows.filter((r) => isSelected(r, selected, recent)).map(({ isNew: _isNew, ...r }) => r);
	return rows.length ? { fetchedAt: catalog.fetchedAt, rows } : undefined;
}

/** The rows to show: the fetched list, then anything selected that it does not contain. */
export function pickerRows(catalog: ProjectCatalog | undefined, selected: string[], recent: string): PickerRow[] {
	const rows: PickerRow[] = catalog ? [...catalog.rows] : [];
	const wanted = [...new Set(selected.map((e) => e.trim()).filter(Boolean))];
	if (!catalog && wanted.some((e) => entryMatches(e, NO_PROJECT_ROW, recent))) rows.push(NO_PROJECT_ROW);
	for (const e of wanted) {
		if (!rows.some((r) => entryMatches(e, r, recent))) rows.push({ id: e, name: e, orphan: !!catalog });
	}
	return rows;
}

/**
 * The selection after ticking or unticking `ids`. Entries are rewritten as IDs where the
 * list knows them, so renaming a project later does not drop it.
 */
export function setRows(selected: string[], rows: PickerRow[], recent: string, ids: string[], on: boolean): string[] {
	const next = new Set<string>();
	for (const entry of selected) {
		const e = entry.trim();
		if (!e) continue;
		const hits = rows.filter((r) => entryMatches(e, r, recent));
		if (hits.length) hits.forEach((r) => next.add(r.id));
		else next.add(e);
	}
	for (const id of ids) {
		if (on) next.add(id);
		else next.delete(id);
	}
	return [...next];
}
