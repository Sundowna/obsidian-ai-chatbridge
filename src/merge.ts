// "Merge chat copies into one note": the plan. Older versions of this plugin wrote a second note
// whenever a chat continued ("… (updated <stamp>)"), a ChatGPT note was rendered again
// ("… (transcript <hash>)") or a deleted chat came back ("… (recovered)"). This decides, per chat,
// which note stays, which notes merge into it, and which raw files become earlier versions.
// Pure functions, no Obsidian: merge-run.ts reads the vault and carries the plan out.

const UPDATED = / \(updated \d{4}-\d\d-\d\d \d{4}\)/;
const TAIL = [
	/ \(transcript [0-9a-f]{6,}\)$/,
	/ \(updated \d{4}-\d\d-\d\d \d{4}\)$/,
	/ \(recovered\)$/,
];
/** The "(1a2b3c4d)" or "(1a2b3c4d) 2" a taken name got, after one of the endings above. */
const ID_TAIL = /( \((?:updated \d{4}-\d\d-\d\d \d{4}|recovered)\)) \([0-9a-f]{8}\)(?: \d+)?$/;

export const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/');
export const nameOf = (p: string): string => p.split('/').pop() ?? p;
export const stemOf = (p: string): string => nameOf(p).replace(/\.[^.]+$/, '');
export const extOf = (p: string): string => /\.[^./]+$/.exec(p)?.[0] ?? '';

export type CopyKind = 'updated' | 'recovered' | 'transcript';

/** What kind of copy a note is by its name, or null for a chat's first note. */
export function copyKind(path: string): CopyKind | null {
	const stem = stemOf(path);
	if (UPDATED.test(stem)) return 'updated';
	if (/ \(recovered\)/.test(stem)) return 'recovered';
	if (/ \(transcript [0-9a-f]{6,}\)$/.test(stem)) return 'transcript';
	return null;
}

/** The name without the endings copies got: "X (updated …) (transcript …)" -> "X". */
export function plainStem(stem: string): string {
	let s = stem;
	for (let changed = true; changed; ) {
		changed = false;
		const id = ID_TAIL.exec(s);
		if (id) {
			s = s.slice(0, id.index) + id[1]!;
			changed = true;
		}
		for (const re of TAIL) {
			if (re.test(s)) {
				s = s.replace(re, '');
				changed = true;
			}
		}
	}
	return s;
}

/** A note of a synced chat, as found in the vault. */
export interface FoundNote {
	path: string;
	/** The chat ID in its properties. */
	id: string;
	/** Its "updated" property (may be empty). */
	updated: string;
	/** The raw file its "raw:" property links, if that file exists. */
	raw: string | null;
	mtime: number;
}

/** What the sync history knows about a chat. */
export interface KnownChat {
	/** The note the history points at (for ChatGPT: the newest transcript). */
	note: string;
	/** Hermes sessions have no raw files: their old note texts are kept instead. */
	hermes?: boolean;
}

export interface OlderRaw {
	path: string;
	/** That version's "updated" time. */
	at: string;
}

export interface MergeGroup {
	id: string;
	/** Why this chat is listed: the most serious kind of copy it has. */
	kind: CopyKind;
	/** The note that stays (it may not exist yet, when the chat's first note was deleted). */
	target: string;
	targetExists: boolean;
	/** The note whose text the target gets. */
	newest: string;
	/** Notes that go to the trash once their text, raw file and links are taken care of. */
	remove: string[];
	/** The newest version's raw file, or null if it has none. */
	mainRaw: string | null;
	/** Where the main raw file belongs afterwards (next to it, under the target's name). */
	targetRaw: string | null;
	/** Earlier versions' raw files, oldest first. */
	olderRaws: OlderRaw[];
	/** Notes whose text is kept as an earlier version because they have no raw file (Hermes). */
	olderNotes: OlderRaw[];
	inHistory: boolean;
	/** Things you should know before agreeing. */
	notes: string[];
}

export interface MergePlan {
	groups: MergeGroup[];
	/** Chats left alone, with the reason. */
	skipped: { id: string; notes: string[]; reason: string }[];
}

const time = (n: FoundNote): number => {
	const t = Date.parse(n.updated);
	return Number.isNaN(t) ? 0 : t;
};

/** Oldest first; among notes of the same version the copy rendered later comes last. */
function byAge(a: FoundNote, b: FoundNote): number {
	return time(a) - time(b) || Number(copyKind(a.path) === 'transcript') - Number(copyKind(b.path) === 'transcript') || a.mtime - b.mtime || a.path.localeCompare(b.path);
}

/**
 * The plan for every chat that has more than one note.
 * @param notes   every note in the vault with a chat ID in its properties
 * @param known   chat ID -> what the sync history says
 * @param exists  is there a file or folder at this path?
 */
export function planMerge(notes: readonly FoundNote[], known: ReadonlyMap<string, KnownChat>, exists: (path: string) => boolean): MergePlan {
	const byId = new Map<string, FoundNote[]>();
	for (const n of notes) {
		// Your own copies (see versions.ts) are yours: never merged.
		if (/ \(my edits [^)]*\)$/.test(stemOf(n.path))) continue;
		const list = byId.get(n.id) ?? [];
		list.push(n);
		byId.set(n.id, list);
	}
	const plan: MergePlan = { groups: [], skipped: [] };
	for (const [id, found] of byId) {
		if (found.length < 2) continue;
		let members = [...found].sort(byAge);
		// A second note without a copy ending is not one this plugin made (a copy of yours): left alone.
		const firsts = members.filter((m) => copyKind(m.path) === null);
		const extras = new Set(firsts.slice(1).map((m) => m.path));
		members = members.filter((m) => !extras.has(m.path));
		const kinds = members.map((m) => copyKind(m.path));
		const kind: CopyKind | null = kinds.includes('updated') ? 'updated' : kinds.includes('recovered') ? 'recovered' : kinds.includes('transcript') ? 'transcript' : null;
		const paths = members.map((m) => m.path);
		if (members.length < 2) continue;
		if (!kind) {
			plan.skipped.push({ id, notes: paths, reason: 'several notes carry this chat ID, but none is named like a copy this plugin made' });
			continue;
		}
		const history = known.get(id);
		let newest = members[members.length - 1]!;
		if (history) {
			const pointed = members.find((m) => m.path === history.note);
			if (!pointed) {
				plan.skipped.push({ id, notes: paths, reason: `the sync history points at a note that is not among them (${history.note}). Run "Refresh index" first` });
				continue;
			}
			// The history is right about which note is current, unless a later version is plainly there.
			if (time(pointed) >= time(newest)) newest = pointed;
		}
		const info: string[] = [];
		let target = firsts[0]?.path;
		let targetExists = true;
		if (!target) {
			const wanted = `${dirOf(newest.path)}/${plainStem(stemOf(newest.path))}.md`;
			if (exists(wanted)) {
				target = newest.path;
				info.push(`the name "${nameOf(wanted)}" is taken by another file, so the newest note keeps its name`);
			} else {
				target = wanted;
				targetExists = false;
			}
		}
		if (extras.size) info.push(`left alone, another note with this chat ID: ${[...extras].join(', ')}`);
		if (!history) info.push('not in the sync history (an account that was removed, or notes copied in): merged, but the next sync does not know this chat');

		// Raw files: one per version, the newest's is the main one.
		const mainRaw = newest.raw;
		const seen = new Set<string>(mainRaw ? [mainRaw] : []);
		const olderRaws: OlderRaw[] = [];
		const olderNotes: OlderRaw[] = [];
		for (const m of members) {
			if (m.path === newest.path) continue;
			if (m.raw) {
				if (seen.has(m.raw)) continue;
				seen.add(m.raw);
				olderRaws.push({ path: m.raw, at: m.updated || new Date(m.mtime).toISOString() });
			} else if (history?.hermes && copyKind(m.path) !== 'transcript' && time(m) < time(newest)) {
				olderNotes.push({ path: m.path, at: m.updated || new Date(m.mtime).toISOString() });
			}
		}
		if (!mainRaw && !history?.hermes) info.push('the newest note has no raw file in the vault');
		const targetRaw = mainRaw ? `${dirOf(mainRaw)}/${stemOf(target)}${extOf(mainRaw)}` : null;
		plan.groups.push({
			id, kind, target, targetExists, newest: newest.path,
			remove: paths.filter((p) => p !== target),
			mainRaw, targetRaw, olderRaws, olderNotes,
			inHistory: !!history, notes: info,
		});
	}
	plan.groups.sort((a, b) => a.target.localeCompare(b.target));
	return plan;
}

/** One place a link to a merged note (or a moved file) was written. */
export interface LinkRef {
	/** The link exactly as written, e.g. "[[X (updated 2026-11-07 1951)|that chat]]". */
	original: string;
	/** The file it pointed at. */
	from: string;
}

/**
 * The link rewritten to its new file. `linktext` is how Obsidian would write a link to the new
 * file from this note. Null for a form that is not understood (reported, never guessed).
 */
export function relink(original: string, linktext: string): string | null {
	const wiki = /^(!?)\[\[([^\]|#]*)(#[^\]|]*)?(\|[\s\S]*)?\]\]$/.exec(original);
	if (wiki) return `${wiki[1]}[[${linktext}${wiki[3] ?? ''}${wiki[4] ?? ''}]]`;
	const md = /^(!?)\[([^\]]*)\]\((<?)([^#>]*)(#[^>]*)?(>?)\)$/.exec(original);
	if (md) {
		const path = /\.[A-Za-z0-9]+$/.test(linktext) ? linktext : `${linktext}.md`;
		const url = md[3] ? path : path.replace(/ /g, '%20');
		return `${md[1]}[${md[2]}](${md[3]}${url}${md[5] ?? ''}${md[6]})`;
	}
	return null;
}

/** Applies link rewrites to a note's text. Returns the new text and the links it could not rewrite. */
export function rewriteLinks(text: string, refs: readonly LinkRef[], linktextOf: (from: string) => string | null): { text: string; failed: LinkRef[]; changed: number } {
	let out = text;
	let changed = 0;
	const failed: LinkRef[] = [];
	const done = new Set<string>();
	for (const ref of refs) {
		if (done.has(ref.original)) continue;
		done.add(ref.original);
		const to = linktextOf(ref.from);
		const next = to === null ? null : relink(ref.original, to);
		if (next === null) {
			failed.push(ref);
			continue;
		}
		const pieces = out.split(ref.original);
		if (pieces.length === 1) continue; // already rewritten (Obsidian did it, or the text changed)
		changed += pieces.length - 1;
		out = pieces.join(next);
	}
	return { text: out, failed, changed };
}
