// Active Context upkeep in the vault: reads the note, applies core.ts, writes it back.
// Nothing is deleted: archived entries are written to the month file before they leave the note.

import { normalizePath, TFile, type App } from 'obsidian';
import type { HandoffSettings, Settings } from '../settings';
import { ensureFolder, writeOver } from '../vaultio';
import {
	addToArchive,
	archiveFileName,
	flagStale,
	lastAsk,
	legacyArchiveFileName,
	nlOf,
	liveSessions,
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

/** Rewrites the Live sessions block. False when the Active Context note is missing. */
export async function updateLive(app: App, s: Settings, nowMs: number): Promise<boolean> {
	const h = s.handoff;
	if (!(await readNote(app, h.file))) return false;
	const items = [];
	for (const i of liveSessions(s, nowMs, h.liveHours)) items.push({ ...i, ask: await askOf(app, i) });
	// Read right before writing: an AI may have saved the note while the chats were read.
	const ctx = await readNote(app, h.file);
	if (!ctx) return false;
	const next = putLive(ctx.text, renderLive(items, h.liveHours));
	if (next !== ctx.text) await app.vault.modify(ctx.file, next);
	return true;
}

export interface DailyResult {
	found: boolean;
	moved: number;
	flagged: number;
	/** Month files written, vault paths. */
	archives: string[];
}

/** The archive pass and the stale "Now" check, once a day. Archive files are written first. */
export async function dailyUpkeep(app: App, h: HandoffSettings, today: string): Promise<DailyResult> {
	const ctx = await readNote(app, h.file);
	if (!ctx) return { found: false, moved: 0, flagged: 0, archives: [] };
	const { keep, moved } = splitOld(ctx.text, today, h.keepDays);
	const archives: string[] = [];
	if (moved.length) {
		const byMonth = new Map<string, Moved[]>();
		for (const m of moved) byMonth.set(m.date.slice(0, 7), [...(byMonth.get(m.date.slice(0, 7)) ?? []), m]);
		await ensureFolder(app, h.archiveFolder);
		for (const [month, items] of [...byMonth].sort()) {
			const legacy = normalizePath(`${h.archiveFolder}/${legacyArchiveFileName(month)}`);
			const path = app.vault.getAbstractFileByPath(legacy) instanceof TFile ? legacy : normalizePath(`${h.archiveFolder}/${archiveFileName(month)}`);
			const old = await readNote(app, path);
			await writeOver(app, path, addToArchive(old?.text ?? null, month, items, today, noteTitle(h.file), nlOf(ctx.text)));
			archives.push(path);
		}
	}
	const stale = h.staleDays > 0 ? flagStale(keep, h.nowSeen, today, h.staleDays) : { text: keep, seen: h.nowSeen, flagged: 0 };
	h.nowSeen = stale.seen;
	h.lastDaily = today;
	if (stale.text !== ctx.text) await app.vault.modify(ctx.file, setFrontmatter(stale.text, 'updated', today));
	return { found: true, moved: moved.length, flagged: stale.flagged, archives };
}
