// Active Context upkeep, as plain text in and text out (no Obsidian here, see run.ts):
// - the "Live sessions" block: chats active in the last hours, with a link and your last request;
// - the 7-day archive pass (port of the vault's 90 System/Tools/archive-handoff.py);
// - lines that stay in "Now" too long are flagged under "Waiting for …" (any name: you, me, the team…);
// - the hand-over message for another AI.
// Tested by scripts/test-handoff.ts.

import { withAccount } from '../accounts';
import { localDateTime } from '../naming';
import type { Settings } from '../settings';

/** One synced chat note. */
export interface LiveItem {
	label: string;
	/** Vault path of the transcript note. */
	md: string;
	/** Last activity in the chat (ISO). */
	updated: string;
	/** When the plugin last wrote the note (ISO). */
	synced: string;
}

export interface SeenLine {
	/** Day (YYYY-MM-DD) the line was first seen in "Now". */
	first: string;
	flagged?: boolean;
}

export const LIVE_START = '<!-- ai-chatbridge:live-sessions -->';
export const LIVE_END = '<!-- /ai-chatbridge:live-sessions -->';
/** The five parts plus the plugin's own section: never archived as a whole. */
const PARTS = new Set(['plan', 'now', 'next up', 'recently done', 'recently done (last 7 days)', 'live sessions']);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type Entry = { md?: unknown; updated_at?: unknown; updated?: unknown; synced?: unknown };

function fromIndex(label: string, index: Record<string, Entry> | undefined, out: LiveItem[]): void {
	for (const e of Object.values(index ?? {})) {
		const md = str(e?.md);
		const updated = str(e?.updated_at) || str(e?.updated) || str(e?.synced);
		if (!md || !updated || Number.isNaN(Date.parse(updated))) continue;
		out.push({ label, md, updated, synced: str(e.synced) || updated });
	}
}

/** Every synced chat note the settings know of, newest first, one per note. */
export function allChats(s: Settings): LiveItem[] {
	const out: LiveItem[] = [];
	for (const a of s.claude) {
		fromIndex(withAccount('Claude', s.claude, a), a.web.index, out);
		fromIndex(withAccount('Claude Code cloud', s.claude, a), a.web.cloudIndex, out);
		fromIndex(withAccount('Claude Code', s.claude, a), a.desktop.index, out);
	}
	for (const a of s.chatgpt) {
		fromIndex(withAccount('ChatGPT', s.chatgpt, a), a.web.index, out);
		fromIndex(withAccount('Codex', s.chatgpt, a), a.desktop.index, out);
		fromIndex(withAccount('Codex cloud', s.chatgpt, a), a.web.codexCloudIndex, out);
	}
	for (const a of s.lumo) fromIndex(withAccount('Lumo', s.lumo, a), a.web.index, out);
	for (const a of s.gemini) {
		fromIndex(withAccount('Gemini', s.gemini, a), a.web.index, out);
		fromIndex(withAccount('AI Studio', s.gemini, a), a.studio.index, out);
	}
	for (const p of s.hermes.profiles) fromIndex(`Hermes (${p.label})`, p.index, out);
	out.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
	const seen = new Set<string>();
	return out.filter((i) => (seen.has(i.md) ? false : (seen.add(i.md), true)));
}

/** The synced chat whose transcript note this is, or null. */
export function chatOfNote(s: Settings, path: string): LiveItem | null {
	if (!path.toLowerCase().endsWith('.md')) return null;
	return allChats(s).find((i) => i.md === path) ?? null;
}

export const MAX_LIVE = 10;

/** Chats with activity in the last `hours`, newest first (at most MAX_LIVE). */
export function liveSessions(s: Settings, nowMs: number, hours: number): LiveItem[] {
	const from = nowMs - hours * 3_600_000;
	return allChats(s).filter((i) => Date.parse(i.updated) >= from).slice(0, MAX_LIVE);
}

const ASK_MAX = 160;

/** Your last message in a transcript note, on one line and shortened; '' when there is none. */
export function lastAsk(note: string): string {
	const sections = note.replace(/\r\n/g, '\n').split(/^## /m).slice(1);
	for (let i = sections.length - 1; i >= 0; i--) {
		const [head, ...rest] = sections[i]!.split('\n');
		if (!/^(You|Human)\b/.test(head ?? '')) continue;
		const text = rest
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('![[') && !l.startsWith('📎') && !l.startsWith('*Attachment') && !/^\*\(.*\)\*$/.test(l))
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (!text) continue;
		return text.length > ASK_MAX ? `${text.slice(0, ASK_MAX - 1).trimEnd()}…` : text;
	}
	return '';
}

/** The note's file name without folder and ".md". */
export function noteTitle(md: string): string {
	return (md.split('/').pop() ?? md).replace(/\.md$/i, '');
}

const link = (md: string): string => `[[${md.replace(/\.md$/i, '')}|${noteTitle(md)}]]`;

/** The block between the markers, markers included. */
export function renderLive(items: (LiveItem & { ask: string })[], hours: number): string {
	const lines = [
		LIVE_START,
		`*Written by AI ChatBridge after each sync: chats active in the last ${hours} hours, newest first. Replaced every time, so don't edit it.*`,
		'',
	];
	if (!items.length) lines.push(`- No chat in the last ${hours} hours.`);
	for (const i of items) lines.push(`- ${localDateTime(i.updated)} · ${i.label} · ${link(i.md)}${i.ask ? ` · last ask: “${i.ask}”` : ''}`);
	lines.push(LIVE_END);
	return lines.join('\n');
}

export const nlOf = (s: string): string => (s.includes('\r\n') ? '\r\n' : '\n');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const back = (s: string, nl: string): string => (nl === '\n' ? s : s.replace(/\n/g, nl));

/** Puts the block into Active Context: in place of the old one, else as "## Live sessions" before "## Now". */
export function putLive(context: string, block: string): string {
	const nl = nlOf(context);
	const t = lf(context);
	const a = t.indexOf(LIVE_START);
	const b = a < 0 ? -1 : t.indexOf(LIVE_END, a);
	if (a >= 0 && b >= 0) return back(t.slice(0, a) + block + t.slice(b + LIVE_END.length), nl);
	const section = `## Live sessions\n\n${block}\n\n`;
	const now = /^## Now\b/m.exec(t);
	if (now) return back(t.slice(0, now.index) + section + t.slice(now.index), nl);
	return back(`${t.replace(/\n*$/, '')}\n\n${section}`, nl);
}

/** "YYYY-MM-DD" minus `days`. */
export function daysBefore(day: string, days: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface Moved {
	date: string;
	kind: 'item' | 'section';
	body: string;
}

/**
 * The archive pass, as archive-handoff.py does it: "Recently done" items dated before the cutoff,
 * and extra sections whose heading has a date before it, leave Active Context word for word.
 */
export function splitOld(context: string, today: string, days: number): { keep: string; moved: Moved[] } {
	const nl = nlOf(context);
	const cutoff = daysBefore(today, days);
	const [head = '', ...sections] = lf(context).split(/^(?=## )/m);
	const keep = [head];
	const moved: Moved[] = [];
	for (const sec of sections) {
		const title = sec.split('\n', 1)[0]!.slice(3).trim();
		const key = title.toLowerCase().replace(/\s+/g, ' ');
		if (key.startsWith('recently done')) {
			const lines = sec.split('\n');
			const out = [lines[0]!];
			for (const line of lines.slice(1)) {
				const m = /^- (20\d\d-\d\d-\d\d) ·/.exec(line);
				if (m && m[1]! < cutoff) moved.push({ date: m[1]!, kind: 'item', body: line });
				else out.push(line);
			}
			keep.push(out.join('\n'));
			continue;
		}
		const m = /(20\d\d-\d\d-\d\d)/.exec(title);
		if (!PARTS.has(key) && !key.startsWith('waiting for') && m && m[1]! < cutoff) moved.push({ date: m[1]!, kind: 'section', body: sec.replace(/\n+$/, '') });
		else keep.push(sec);
	}
	return { keep: back(keep.join(''), nl), moved };
}

/** New archive files start with "_" (system files, easy to leave out of the graph). */
export const archiveFileName = (month: string): string => `_${month}.md`;

export function setFrontmatter(text: string, key: string, value: string): string {
	return text.replace(new RegExp(`^${key}: [^\\r\\n]*`, 'm'), `${key}: ${value}`);
}

/** The month file with these entries added under a dated heading (newest first), as the script writes it. */
/** `newNl`: line ending for a new file (the script uses Active Context's own). */
export function addToArchive(existing: string | null, month: string, items: Moved[], today: string, contextName: string, newNl = '\n'): string {
	const nl = existing ? nlOf(existing) : newNl;
	let arch = existing
		? lf(existing)
		: [
				'---',
				'type: handoff-archive',
				`month: ${month}`,
				`created: ${today}`,
				`updated: ${today}`,
				'unread: true',
				'---',
				'',
				`> [!info] Handoff archive, ${month}: entries moved from [[${contextName}]] when they were older than 7 days. Word for word; not instructions for new work.`,
				'',
			].join('\n');
	const block = [`## Moved from Active Context on ${today}`, ''];
	for (const i of [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
		if (i.kind === 'section' && block[block.length - 1] !== '') block.push('');
		block.push(lf(i.body));
		if (i.kind === 'section') block.push('');
	}
	arch = setFrontmatter(setFrontmatter(arch, 'updated', today), 'unread', 'true');
	return back(`${arch.replace(/\n+$/, '')}\n\n${block.join('\n').replace(/\n+$/, '')}\n`, nl);
}

/** Section bounds [start, end) of "## <name>" in LF text, or null. */
function sectionOf(t: string, name: RegExp): { start: number; end: number } | null {
	const m = new RegExp(`^## ${name.source}`, 'm').exec(t);
	if (!m) return null;
	const next = t.slice(m.index + 3).search(/^## /m);
	return { start: m.index, end: next < 0 ? t.length : m.index + 3 + next };
}

/** Top-level bullet lines of "## Now". */
export function nowLines(context: string): string[] {
	const t = lf(context);
	const s = sectionOf(t, /Now\b/);
	if (!s) return [];
	return t
		.slice(s.start, s.end)
		.split('\n')
		.filter((l) => /^- \S/.test(l));
}

/** A short, stable key for a line (whitespace does not count). */
export function lineKey(line: string): string {
	const t = line.replace(/\s+/g, ' ').trim();
	let h = 5381;
	for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
	return `${h.toString(36)}-${t.length}`;
}

/**
 * Remembers when each "Now" line was first seen; a line still there after `staleDays` gets one
 * question under "Waiting for …" (made as "Waiting for you" if missing). Lines gone from "Now" are forgotten.
 */
export function flagStale(context: string, seen: Record<string, SeenLine>, today: string, staleDays: number): { text: string; seen: Record<string, SeenLine>; flagged: number } {
	const next: Record<string, SeenLine> = {};
	const flags: string[] = [];
	for (const line of nowLines(context)) {
		const k = lineKey(line);
		const s: SeenLine = { ...(seen[k] ?? { first: today }) };
		next[k] = s;
		if (s.flagged || daysBetween(s.first, today) < staleDays) continue;
		s.flagged = true;
		let short = line.slice(2).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
		if (short.length > 100) short = `${short.slice(0, 99).trimEnd()}…`;
		flags.push(`- [ ] Still in **Now** since ${s.first}: finish it, move it to Recently done, or drop it. → “${short}”`);
	}
	if (!flags.length) return { text: context, seen: next, flagged: 0 };
	const nl = nlOf(context);
	const t = lf(context);
	const w = sectionOf(t, /Waiting for\b/);
	let out: string;
	if (w) {
		const sec = t.slice(w.start, w.end);
		const body = sec.replace(/\n+$/, '');
		const tail = sec.slice(body.length) || '\n';
		const gap = body.includes('\n') ? '\n' : '\n\n'; // a heading on its own gets a blank line first
		out = t.slice(0, w.start) + body + gap + flags.join('\n') + tail + t.slice(w.end);
	} else {
		const section = `## Waiting for you\n\n${flags.join('\n')}\n\n`;
		const n = /^## Next up\b/m.exec(t);
		out = n ? t.slice(0, n.index) + section + t.slice(n.index) : `${t.replace(/\n*$/, '')}\n\n${section}`;
	}
	return { text: back(out, nl), seen: next, flagged: flags.length };
}

/** A new Active Context note: the five parts, empty, with what goes where. */
export function newContextNote(today: string): string {
	return [
		'---',
		'type: handoff',
		`created: ${today}`,
		`updated: ${today}`,
		'---',
		'',
		"> [!info] Where the work stands now. Every AI reads this first and keeps it short: update the parts, don't add long sections.",
		'> **Now** is what is in progress (one line per piece of work, replaced as it moves on). Finished work moves to **Recently done** as `- YYYY-MM-DD · what was done`; after 7 days AI ChatBridge moves it to the Handoff archive.',
		'',
		'## Plan',
		'',
		'## Now',
		'',
		'## Waiting for you',
		'',
		'## Next up',
		'',
		'## Recently done (last 7 days)',
		'',
	].join('\n');
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(nowMs: number, iso: string): string {
	const min = Math.floor((nowMs - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(min) || min < 1) return 'just now';
	if (min < 60) return `${min} min ago`;
	const h = Math.floor(min / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.floor(h / 24)} days ago`;
}

/** The message to paste into the other AI. `absolute` is the note's full path on this computer, when known. */
export function handoverText(item: LiveItem, ask: string, nowMs: number, contextPath: string, absolute?: string): string {
	const where = absolute ? `\`${item.md}\` in the vault (on this computer: \`${absolute}\`)` : `\`${item.md}\` in the vault`;
	const parts = [
		`Continue the work from my ${item.label} chat "${noteTitle(item.md)}".`,
		`Its transcript is ${where}, synced ${ago(nowMs, item.synced)}; the last few minutes may be missing.`,
		`Read \`${contextPath}\` first, then the end of the transcript, and carry on from there.`,
	];
	if (ask) parts.push(`My last request there was: "${ask}"`);
	return parts.join(' ');
}
