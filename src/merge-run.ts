// "Merge chat copies into one note": reading the vault for the plan (merge.ts) and carrying it
// out. Nothing here runs until you confirm the preview. Per chat, in this order, so a stop in
// the middle loses nothing: raw files of earlier versions are renamed to "(version …)", the
// note that stays gets the newest text, links to the other notes are rewritten, and only then
// do the other notes go to Obsidian's trash.

import { getLinkpath, normalizePath, TFile, TFolder, type App } from 'obsidian';
import { KIND_FOLDER, numbered } from './files';
import { followRename } from './follow';
import { appendLog } from './log';
import { copyKind, dirOf, extOf, nameOf, planMerge, rewriteLinks, stemOf, type CopyKind, type FoundNote, type KnownChat, type LinkRef, type MergeGroup, type MergePlan } from './merge';
import { dailyNoteName, localStamp } from './naming';
import { masterRaw, mirrorRaw, rawLink } from './raw-folders';
import type { Settings } from './settings';
import type { NoteState, RawVersion } from './types';
import { carryProperties, keepNoteAsVersion, noteHash, splitNote, versionPath, withVersionInfo } from './versions';
import { ensureFolder, findFile, freeFileName } from './vaultio';

const fileAt = (app: App, path: string): TFile | null => {
	const f = findFile(app, normalizePath(path));
	return f instanceof TFile ? f : null;
};

/** One chat in the sync history, whatever provider it came from, with a way to repoint it. */
interface Known extends KnownChat {
	state: NoteState;
	/** Points the history at the merged note and its raw files. */
	apply(md: string, raw: string | null, olderParts: string[] | null): void;
}

/** Every chat the sync history knows, by chat ID. */
function knownChats(s: Settings): Map<string, Known> {
	const out = new Map<string, Known>();
	const web = [...s.claude, ...s.chatgpt, ...s.lumo, ...s.gemini].map((a) => a.web.index);
	for (const a of s.gemini) web.push(a.studio.index);
	for (const index of web) {
		for (const [id, e] of Object.entries(index)) {
			out.set(id, {
				note: e.view ?? e.md,
				state: e,
				apply: (md, raw, older) => {
					e.md = md;
					// The merged note is the newest rendering; a sync compares against it again.
					e.view = md;
					delete e.viewHash;
					if (raw) e.json = raw;
					if (older && e.older) e.older = older;
				},
			});
		}
	}
	for (const idx of [...s.claude.map((a) => a.web.cloudIndex), ...s.chatgpt.map((a) => a.web.codexCloudIndex)]) {
		for (const [id, e] of Object.entries(idx ?? {})) {
			if (!e.md) continue;
			out.set(id, { note: e.md, state: e, apply: (md, raw) => { e.md = md; if (raw) e.json = raw; } });
		}
	}
	for (const a of [...s.claude, ...s.chatgpt]) {
		for (const [id, e] of Object.entries(a.desktop.index)) {
			out.set(id, { note: e.md, state: e, apply: (md, raw) => { e.md = md; if (raw) e.raw = raw; } });
		}
	}
	for (const p of s.hermes.profiles) {
		for (const [id, e] of Object.entries(p.index)) {
			out.set(id, { note: e.md, hermes: true, state: e, apply: (md, raw) => { e.md = md; if (raw) e.json = raw; } });
		}
	}
	return out;
}

/** Every note with a chat ID in its properties (uuid, session, or Hermes' session_id). */
export function findNotes(app: App): FoundNote[] {
	const out: FoundNote[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) continue;
		const id: unknown = fm.uuid ?? fm.session ?? fm.session_id;
		if (typeof id !== 'string' || !id) continue;
		const rawProp: unknown = fm.raw;
		const link = typeof rawProp === 'string' ? /^\[\[([^\]|#]+)/.exec(rawProp.trim())?.[1] : undefined;
		const raw = link ? app.metadataCache.getFirstLinkpathDest(link, f.path)?.path ?? null : null;
		// Hermes writes the day in "updated" and the minute in "updated_time".
		const when: unknown = fm.updated_time ?? fm.updated;
		const updated = when instanceof Date ? when.toISOString() : typeof when === 'string' ? when : '';
		out.push({ path: f.path, id, updated, raw, mtime: f.stat.mtime });
	}
	return out;
}

/** A chat in the preview: the plan plus what the vault says about links and files. */
export interface PreviewGroup extends MergeGroup {
	/** Links to the notes that go away, by the note that holds them. */
	links: Map<string, LinkRef[]>;
	/** Saved files (Artifacts/, Attachments/) that move to the staying note's folder. */
	fileMoves: { from: string; to: string }[];
}

export interface MergePreview {
	groups: PreviewGroup[];
	skipped: MergePlan['skipped'];
}

/** Links anywhere in the vault that point at one of these files, grouped by the note holding them. */
function linksTo(app: App, targets: ReadonlySet<string>): Map<string, LinkRef[]> {
	const out = new Map<string, LinkRef[]>();
	for (const [source, dests] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!Object.keys(dests).some((d) => targets.has(d))) continue;
		const file = fileAt(app, source);
		if (!file) continue;
		const cache = app.metadataCache.getFileCache(file);
		const refs: LinkRef[] = [];
		for (const l of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
			const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), source)?.path;
			if (dest && targets.has(dest)) refs.push({ original: l.original, from: dest });
		}
		// A canvas (or anything else without a link list) is named so it can be reported.
		out.set(source, refs);
	}
	return out;
}

/** The files saved for a note that is going away, and where each goes next to the staying note. */
function savedFileMoves(app: App, g: MergeGroup): { from: string; to: string }[] {
	const out: { from: string; to: string }[] = [];
	for (const note of g.remove) {
		for (const kind of Object.values(KIND_FOLDER)) {
			const dir = findFile(app, `${dirOf(note)}/${kind}/${stemOf(note)}`);
			if (!(dir instanceof TFolder)) continue;
			for (const f of dir.children) {
				if (f instanceof TFile) out.push({ from: f.path, to: `${dirOf(g.target)}/${kind}/${stemOf(g.target)}/${f.name}` });
			}
		}
	}
	return out;
}

/** What would be merged. Reads only. */
export function previewMerge(app: App, s: Settings): MergePreview {
	const known = knownChats(s);
	const plan = planMerge(findNotes(app), known, (p) => findFile(app, normalizePath(p)) !== null);
	const groups: PreviewGroup[] = plan.groups.map((g) => {
		const fileMoves = savedFileMoves(app, g);
		const raws = [g.mainRaw, ...g.olderRaws.map((o) => o.path)].flatMap((raw) => (raw ? [raw, ...olderParts(app, raw).map((f) => f.path)] : []));
		const links = linksTo(app, new Set([...g.remove, ...fileMoves.map((m) => m.from), ...raws]));
		// Links inside the notes that go away do not need fixing, and the note that stays is written anew.
		for (const gone of [...g.remove, g.target]) links.delete(gone);
		// A note that only links a raw file which keeps its place needs nothing either.
		if (g.mainRaw && g.mainRaw === g.targetRaw && !g.olderRaws.length) for (const [source, refs] of links) if (refs.length && refs.every((x) => raws.includes(x.from))) links.delete(source);
		return { ...g, links, fileMoves };
	});
	return { groups, skipped: plan.skipped };
}

export const linkCount = (g: PreviewGroup): number => [...g.links.values()].reduce((n, refs) => n + Math.max(1, refs.length), 0);

export interface MergeResult {
	merged: number;
	notesTrashed: number;
	versionsKept: number;
	linksFixed: number;
	filesMoved: number;
	/** Links that still point at a merged note, as "note: link". */
	linksLeft: string[];
	/** Anything else that was left as it was, in plain words. */
	left: string[];
	/** Chats that could not be merged, with the error. */
	failed: string[];
	report?: string;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

/** Does `whole` start with `part`? (a session file that only grew) */
function startsWith(whole: ArrayBuffer, part: ArrayBuffer): boolean {
	if (part.byteLength > whole.byteLength) return false;
	return sameBytes(whole.slice(0, part.byteLength), part);
}

/**
 * Moves a file and keeps the history right. A plain move: links to it are rewritten here
 * afterwards (see `moved`), the same way whatever "Automatically update internal links" says,
 * and without Obsidian asking about each file.
 */
async function move(app: App, s: Settings, file: TFile, to: string, moved: Map<string, string>): Promise<void> {
	const from = file.path;
	await ensureFolder(app, dirOf(to));
	await app.vault.rename(file, to);
	followRename(s, from, to); // also done by the rename event; repeating it changes nothing
	moved.set(from, to);
}

/** ChatGPT's older pages of a raw file: "<stem> (older N).json" next to it, in order. */
function olderParts(app: App, raw: string): TFile[] {
	const out: TFile[] = [];
	for (let n = 1; n < 1000; n++) {
		const f = fileAt(app, `${dirOf(raw)}/${stemOf(raw)} (older ${n})${extOf(raw)}`);
		if (!f) break;
		out.push(f);
	}
	return out;
}

/** A free place for an earlier version of `targetRaw` (and its parts), numbered if the minute is taken. */
function freeVersion(app: App, targetRaw: string, at: string, parts: number): number {
	const stem = stemOf(targetRaw);
	for (let n = 1; n < 1000; n++) {
		const names = [versionPath(targetRaw, stem, at, n), ...Array.from({ length: parts }, (_x, i) => versionPath(`${dirOf(targetRaw)}/${stem} (older ${i + 1})${extOf(targetRaw)}`, stem, at, n))];
		if (names.every((p) => findFile(app, p) === null)) return n;
	}
	throw new Error(`No free file name for an earlier version of ${targetRaw}`);
}

async function mergeOne(app: App, s: Settings, g: PreviewGroup, known: Map<string, Known>, r: MergeResult): Promise<void> {
	const newest = fileAt(app, g.newest);
	if (!newest) throw new Error(`the newest note is gone: ${g.newest}`);
	let text = await app.vault.read(newest);
	const targetFolder = dirOf(g.target);
	const history = known.get(g.id);
	const versions: RawVersion[] = [...(history?.state.versions ?? [])];
	/** Every file that got a new place: old path -> new path. */
	const moved = new Map<string, string>();

	// 1. Raw files. Earlier versions first, so the main file's name is free for the newest.
	let mainRaw = g.mainRaw;
	const main = mainRaw ? fileAt(app, mainRaw) : null;
	const mainBytes = main && extOf(main.path) === '.jsonl' ? await app.vault.readBinary(main) : null;
	if (g.targetRaw) {
		for (const older of g.olderRaws) {
			const file = fileAt(app, older.path);
			if (!file) continue;
			// A session file only grows: a copy the newest one starts with holds nothing more.
			if (main && mainBytes && startsWith(mainBytes, await app.vault.readBinary(file))) {
				moved.set(file.path, main.path); // a link to it now means the file that contains it
				await app.fileManager.trashFile(file);
				continue;
			}
			const parts = olderParts(app, older.path);
			const n = freeVersion(app, g.targetRaw, older.at, parts.length);
			const stem = stemOf(g.targetRaw);
			const to = versionPath(g.targetRaw, stem, older.at, n);
			const files = [to];
			for (const [i, part] of parts.entries()) {
				const partTo = versionPath(`${dirOf(g.targetRaw)}/${stem} (older ${i + 1})${extOf(g.targetRaw)}`, stem, older.at, n);
				await move(app, s, part, partTo, moved);
				files.push(partTo);
			}
			await move(app, s, file, to, moved);
			versions.push({ at: older.at, files });
			r.versionsKept++;
		}
	}
	// Hermes: no raw files, so an older note's text is what is kept.
	if (g.olderNotes.length) {
		const root = masterRaw(s);
		const rawPath = `${root !== undefined ? mirrorRaw(targetFolder, root) : targetFolder}/${stemOf(g.target)}.json`;
		for (const older of g.olderNotes) {
			const kept = await keepNoteAsVersion(app, older.path, rawPath, older.at);
			if (kept) {
				versions.push(kept);
				r.versionsKept++;
			}
		}
	}
	let mainParts: string[] | null = null;
	if (main && g.targetRaw && main.path !== g.targetRaw) {
		const parts = olderParts(app, main.path);
		const partTargets = parts.map((_p, i) => `${dirOf(g.targetRaw!)}/${stemOf(g.targetRaw!)} (older ${i + 1})${extOf(g.targetRaw!)}`);
		if ([g.targetRaw, ...partTargets].some((p) => findFile(app, p) !== null)) {
			r.left.push(`${g.targetRaw}: the name is taken, so the raw file stays ${main.path}`);
		} else {
			for (const [i, part] of parts.entries()) await move(app, s, part, partTargets[i]!, moved);
			await move(app, s, main, g.targetRaw, moved);
			mainRaw = g.targetRaw;
			mainParts = partTargets;
		}
	} else if (main) mainParts = olderParts(app, main.path).map((f) => f.path);

	// 2. Saved files move next to the note that stays (the same file twice is kept once).
	const rawMoves = new Set(moved.keys());
	for (const m of g.fileMoves) {
		const file = fileAt(app, m.from);
		if (!file) continue;
		const there = fileAt(app, m.to);
		if (!there && findFile(app, m.to) === null) {
			await move(app, s, file, m.to, moved);
			r.filesMoved++;
		} else if (there && sameBytes(await app.vault.readBinary(there), await app.vault.readBinary(file))) {
			followRename(s, m.from, m.to);
			moved.set(m.from, m.to);
			await app.fileManager.trashFile(file);
		} else {
			// Two versions saved different files under one name: both are kept, the later one numbered.
			const dir = dirOf(m.to);
			const to = `${dir}/${freeFileName(app, dir, nameOf(m.to), numbered)}`;
			await move(app, s, file, to, moved);
			r.filesMoved++;
		}
	}
	for (const m of g.fileMoves) {
		const dir = findFile(app, dirOf(m.from));
		if (dir instanceof TFolder && dir.children.length === 0) await app.fileManager.trashFile(dir);
	}

	// 3. The note that stays gets the newest text, pointing at its raw file and saved files.
	const parts = splitNote(text);
	if (parts && mainRaw) {
		const line = `raw: ${JSON.stringify(`[[${rawLink(targetFolder, mainRaw)}]]`)}`;
		const at = parts.fm.findIndex((l) => /^raw:/.test(l));
		if (at >= 0) parts.fm[at] = line;
		text = `---\n${parts.fm.join('\n')}\n---\n${parts.body}`;
	}
	for (const [from, to] of moved) if (!rawMoves.has(from)) text = text.split(from).join(to);
	text = withVersionInfo(text, versions, targetFolder);
	let target = fileAt(app, g.target);
	if (target) {
		const next = target.path === newest.path ? text : carryProperties(await app.vault.read(target), text);
		await app.vault.modify(target, next);
	} else {
		await ensureFolder(app, targetFolder);
		target = await app.vault.create(g.target, text);
	}

	// 4. Links to the notes that go away now point at the note that stays.
	const destOf = (from: string): string => {
		let to = from;
		for (let i = 0; i < 5 && moved.has(to); i++) to = moved.get(to)!;
		return to === from && g.remove.includes(from) ? g.target : to;
	};
	for (const [was, refs] of g.links) {
		// A saved file that links to the chat has itself just moved.
		const source = moved.get(was) ?? was;
		const file = fileAt(app, source);
		if (!file) continue;
		if (!refs.length) {
			r.linksLeft.push(`${source}: links to ${g.remove.map(nameOf).join(', ')} (not a note, check by hand)`);
			continue;
		}
		const linktextOf = (from: string): string | null => {
			const dest = fileAt(app, destOf(from));
			return dest ? app.metadataCache.fileToLinktext(dest, source, true) : null;
		};
		let failed: LinkRef[] = [];
		await app.vault.process(file, (current) => {
			const out = rewriteLinks(current, refs, linktextOf);
			failed = out.failed;
			r.linksFixed += out.changed;
			return out.text;
		});
		for (const f of failed) r.linksLeft.push(`${source}: ${f.original}`);
	}

	// 5. The history points at the one note; then the others go to the trash.
	if (history) {
		history.apply(g.target, mainRaw, mainParts);
		history.state.versions = versions.length ? versions : undefined;
		history.state.noteHash = noteHash(text);
	}
	for (const path of g.remove) {
		const file = fileAt(app, path);
		if (file) {
			await app.fileManager.trashFile(file);
			r.notesTrashed++;
		}
	}
	r.merged++;
}

/** Carries the preview out, chat by chat. `save` is called after each chat, so a stop loses nothing. */
export async function runMerge(app: App, s: Settings, groups: readonly PreviewGroup[], save: () => Promise<void>, progress: (done: number, total: number, name: string) => void, stop: () => boolean): Promise<MergeResult> {
	const r: MergeResult = { merged: 0, notesTrashed: 0, versionsKept: 0, linksFixed: 0, filesMoved: 0, linksLeft: [], left: [], failed: [] };
	const known = knownChats(s);
	const gone = new Map<string, string>();
	for (const [i, g] of groups.entries()) {
		if (stop()) {
			r.left.push(`stopped after ${i} of ${groups.length} chats; run the command again for the rest`);
			break;
		}
		progress(i, groups.length, stemOf(g.target));
		try {
			await mergeOne(app, s, g, known, r);
			for (const p of g.remove) gone.set(p, g.target);
		} catch (e) {
			r.failed.push(`${stemOf(g.target)}: ${e instanceof Error ? e.message : String(e)}`);
		}
		await save();
	}
	// A last look, once Obsidian has read the changed notes again: is any link to a merged note left?
	await new Promise((resolve) => window.setTimeout(resolve, 1500));
	const stems = new Map([...gone.keys()].map((p) => [stemOf(p).toLowerCase(), p]));
	for (const [source, links] of Object.entries(app.metadataCache.unresolvedLinks)) {
		for (const link of Object.keys(links)) {
			const hit = stems.get(stemOf(getLinkpath(link)).toLowerCase()) ?? stems.get(nameOf(getLinkpath(link)).toLowerCase());
			const line = `${source}: [[${link}]]`;
			if (hit && !r.linksLeft.includes(line)) r.linksLeft.push(line);
		}
	}
	return r;
}

const KIND_TEXT: Record<CopyKind, string> = { updated: '"(updated …)" notes', recovered: '"(recovered)" notes', transcript: '"(transcript …)" copies' };

/** The preview or the result as a note's text: what merges into what. */
export function mergeReportText(groups: readonly PreviewGroup[], skipped: MergePlan['skipped'], result?: MergeResult): string {
	const out: string[] = [];
	if (result) {
		out.push(`Merged ${result.merged} chats: ${result.notesTrashed} notes moved to the trash, ${result.versionsKept} earlier versions kept as raw files, ${result.linksFixed} links rewritten, ${result.filesMoved} saved files moved.`, '');
		if (result.failed.length) out.push('## Could not be merged', '', ...result.failed.map((l) => `- ${l}`), '');
		if (result.linksLeft.length) out.push('## Links that could not be fixed', '', ...result.linksLeft.map((l) => `- ${l.replace(/\[\[/g, '`[[').replace(/\]\]/g, ']]`')}`), '');
		if (result.left.length) out.push('## Left as it was', '', ...result.left.map((l) => `- ${l}`), '');
	}
	for (const kind of ['updated', 'recovered', 'transcript'] as const) {
		const list = groups.filter((g) => g.kind === kind);
		if (!list.length) continue;
		out.push(`## Chats with ${KIND_TEXT[kind]} (${list.length})`, '');
		for (const g of list) {
			out.push(`- **${stemOf(g.target)}** in \`${dirOf(g.target)}\`${g.targetExists ? '' : ' (new name)'}`);
			out.push(`    - text from: \`${nameOf(g.newest)}\``);
			for (const p of g.remove) out.push(`    - merged, then to the trash: \`${nameOf(p)}\``);
			for (const o of g.olderRaws) out.push(`    - earlier version kept: \`${nameOf(o.path)}\` → \`${nameOf(versionPath(g.targetRaw ?? o.path, stemOf(g.target), o.at))}\``);
			for (const o of g.olderNotes) out.push(`    - earlier version kept (note text as JSON): \`${nameOf(o.path)}\``);
			if (g.mainRaw && g.targetRaw && g.mainRaw !== g.targetRaw) out.push(`    - raw file renamed: \`${nameOf(g.mainRaw)}\` → \`${nameOf(g.targetRaw)}\``);
			if (g.fileMoves.length) out.push(`    - ${g.fileMoves.length} saved files move to the note's own Artifacts/Attachments folder`);
			for (const [source, refs] of g.links) out.push(`    - ${Math.max(1, refs.length)} link${refs.length > 1 ? 's' : ''} rewritten in \`${source}\``);
			for (const n of g.notes) out.push(`    - note: ${n}`);
		}
		out.push('');
	}
	if (skipped.length) {
		out.push(`## Left alone (${skipped.length})`, '');
		for (const sk of skipped) out.push(`- ${sk.reason}: ${sk.notes.map((p) => `\`${p}\``).join(', ')}`);
		out.push('');
	}
	return out.join('\n');
}

/** Saves the preview or the result as a note next to the sync log, and adds a line to the log. */
export async function writeMergeReport(app: App, s: Settings, title: string, body: string, logLine?: string): Promise<string> {
	const now = new Date();
	const dir = dirOf(s.logPath);
	const base = `${dir ? `${dir}/` : ''}AI ChatBridge ${title} ${localStamp(now.toISOString())}`;
	let path = `${base}.md`;
	for (let n = 2; findFile(app, path) !== null; n++) path = `${base} ${n}.md`;
	await ensureFolder(app, dir);
	await app.vault.create(path, `---\nunread: true\n---\n\n${body}\n`);
	if (logLine) {
		const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
		await appendLog(app, s.logPath, `- [[${dailyNoteName(now)}]] ${time} – ${logLine}: [[${stemOf(path)}]]`, now);
	}
	return path;
}

export { copyKind };
