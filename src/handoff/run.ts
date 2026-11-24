// Active Context upkeep in the vault: reads the note, applies core.ts, writes it back.
// Nothing is deleted: archived entries are written to the month file before they leave the note.

import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { handoffArchive, handoffNote, type HandoffSettings, type Settings } from '../settings';
import { ensureFolder, writeOver } from '../vaultio';
import {
	addToArchive,
	archiveFileName,
	flagStale,
	lastAsk,
	liveSessions,
	newContextNote,
	nlOf,
	noteTitle,
	putLive,
	renderLive,
	setFrontmatter,
	splitOld,
	type LiveItem,
	type Moved,
} from './core';

async function readNote(app: App, path: string): Promise<{ file: TFile; text: string } | null> {
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) return null;
	return { file, text: await app.vault.read(file) };
}

/** Your last request in a synced chat's note ('' when the note is gone or has none). */
export async function askOf(app: App, item: LiveItem): Promise<string> {
	const note = await readNote(app, item.md);
	return note ? lastAsk(note.text) : '';
}

/**
 * The Active Context note, made with the five empty parts when the folder has none yet.
 * Null when its place is taken by a folder.
 */
export async function ensureContextNote(app: App, h: HandoffSettings, today: string): Promise<{ file: TFile; text: string; created: boolean } | null> {
	const path = handoffNote(h);
	const found = await readNote(app, path);
	if (found) return { ...found, created: false };
	if (app.vault.getAbstractFileByPath(path) !== null) return null;
	await ensureFolder(app, h.folder);
	await app.vault.create(path, newContextNote(today));
	const made = await readNote(app, path);
	return made ? { ...made, created: true } : null;
}

/** Rewrites the Live sessions block. False when the Active Context note is missing. */
export async function updateLive(app: App, s: Settings, nowMs: number): Promise<boolean> {
	const h = s.handoff;
	const path = handoffNote(h);
	if (!(await readNote(app, path))) return false;
	const items = [];
	for (const i of liveSessions(s, nowMs, h.liveHours)) items.push({ ...i, ask: await askOf(app, i) });
	// Read right before writing: an AI may have saved the note while the chats were read.
	const ctx = await readNote(app, path);
	if (!ctx) return false;
	const next = putLive(ctx.text, renderLive(items, h.liveHours));
	if (next !== ctx.text) await app.vault.modify(ctx.file, next);
	return true;
}

const OLD_MONTH = /^(\d{4}-\d\d)\.md$/;

/** Month files from before system files started with "_" ("2026-11.md") get the "_"; a taken name is left alone. */
export async function renameOldMonthFiles(app: App, h: HandoffSettings): Promise<string[]> {
	const folder = app.vault.getAbstractFileByPath(handoffArchive(h));
	if (!(folder instanceof TFolder)) return [];
	const renamed: string[] = [];
	for (const f of [...folder.children]) {
		const m = f instanceof TFile ? OLD_MONTH.exec(f.name) : null;
		if (!m) continue;
		const to = normalizePath(`${folder.path}/${archiveFileName(m[1]!)}`);
		if (app.vault.getAbstractFileByPath(to) !== null) continue;
		await app.fileManager.renameFile(f, to);
		renamed.push(to);
	}
	return renamed;
}

export interface DailyResult {
	found: boolean;
	created: boolean;
	moved: number;
	flagged: number;
	/** Month files written, vault paths. */
	archives: string[];
}

/** The archive pass and the stale "Now" check, once a day. Archive files are written first. */
export async function dailyUpkeep(app: App, h: HandoffSettings, today: string): Promise<DailyResult> {
	const ctx = await ensureContextNote(app, h, today);
	if (!ctx) return { found: false, created: false, moved: 0, flagged: 0, archives: [] };
	await renameOldMonthFiles(app, h);
	const { keep, moved } = splitOld(ctx.text, today, h.keepDays);
	const archives: string[] = [];
	if (moved.length) {
		const byMonth = new Map<string, Moved[]>();
		for (const m of moved) byMonth.set(m.date.slice(0, 7), [...(byMonth.get(m.date.slice(0, 7)) ?? []), m]);
		const dir = handoffArchive(h);
		await ensureFolder(app, dir);
		for (const [month, items] of [...byMonth].sort()) {
			const path = normalizePath(`${dir}/${archiveFileName(month)}`);
			const old = await readNote(app, path);
			await writeOver(app, path, addToArchive(old?.text ?? null, month, items, today, noteTitle(handoffNote(h)), nlOf(ctx.text)));
			archives.push(path);
		}
	}
	const stale = h.staleDays > 0 ? flagStale(keep, h.nowSeen, today, h.staleDays) : { text: keep, seen: h.nowSeen, flagged: 0 };
	h.nowSeen = stale.seen;
	h.lastDaily = today;
	if (stale.text !== ctx.text) await app.vault.modify(ctx.file, setFrontmatter(stale.text, 'updated', today));
	return { found: true, created: ctx.created, moved: moved.length, flagged: stale.flagged, archives };
}
