import { getLinkpath, type App, type TFile } from 'obsidian';
import { dirOf, rawLink } from './raw-folders';
import { relink } from './merge';
import { noteHash } from './versions';
import type { IndexEntry } from './types';

function relativeTo(source: string, target: string): string {
	const from = dirOf(source).split('/').filter(Boolean);
	const to = target.split('/');
	while (from.length && from[0] === to[0]) {
		from.shift();
		to.shift();
	}
	return [...from.map(() => '..'), ...to].join('/');
}

function newLink(original: string, source: string, target: string): string | null {
	if (/^!?\[\[/.test(original)) {
		const link = target.includes('/') ? target : relativeTo(source, target);
		return relink(original, link.replace(/\.md$/i, ''));
	}
	const path = relativeTo(source, target).split('/').map((part) =>
		encodeURIComponent(part).replace(/[()]/g, (c) => c === '(' ? '%28' : '%29'),
	).join('/');
	const markdown = /^(!?\[[\s\S]*\]\()(?:(<)([^>\r\n]*)(>)|([^\r\n]*?))([ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?\)$/.exec(original);
	if (!markdown) return null;
	const [, prefix, open = '', angle, close = '', bare, title = ''] = markdown;
	const subpath = /#.*$/.exec(angle ?? bare ?? '')?.[0] ?? '';
	return `${prefix}${open}${path}${subpath}${close}${title})`;
}

export interface ArchiveLinkPlan {
	edits: { original: string; start: number; end: number; replacement: string }[];
	properties: [string, string][];
	generated: [string, string][];
}

/** Resolve outgoing links from their original location, before any part of the chat moves. */
export function planArchiveLinks(app: App, entry: IndexEntry, file: TFile, to: string, moved: ReadonlyMap<string, string>): ArchiveLinkPlan {
	const from = file.path;
	const cache = app.metadataCache?.getFileCache(file);
	const resolve = (link: string, source: string) => app.metadataCache?.getFirstLinkpathDest(getLinkpath(link), source)?.path;
	const edits = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].flatMap((ref) => {
		const target = resolve(ref.link, from);
		if (!target || (!moved.has(target) && resolve(ref.link, to) === target && /^!?\[\[/.test(ref.original))) return [];
		const replacement = newLink(ref.original, to, moved.get(target) ?? target);
		return replacement && replacement !== ref.original
			? [{ original: ref.original, start: ref.position.start.offset, end: ref.position.end.offset, replacement }] : [];
	}).sort((a, b) => b.start - a.start);
	const properties = new Map<string, string>();
	for (const ref of cache?.frontmatterLinks ?? []) {
		const target = resolve(ref.link, from);
		if (!target || (!moved.has(target) && resolve(ref.link, to) === target)) continue;
		const replacement = newLink(ref.original, to, moved.get(target) ?? target);
		if (replacement) properties.set(ref.original, replacement);
	}
	// Also handle plugin properties before the metadata cache has read a new/restored note.
	for (const raw of [entry.json, ...(entry.versions ?? []).map((v) => v.files[0]).filter((p): p is string => !!p)]) {
		const before = `[[${rawLink(dirOf(from), raw)}]]`;
		properties.set(before, `[[${rawLink(dirOf(to), moved.get(raw) ?? raw)}]]`);
	}
	return { edits, properties: [...properties], generated: cache ? [] : [...moved] };
}

/** Write only links. Do this after moving the transcript so Obsidian indexes relative URLs from its new path. */
export async function rebaseArchiveLinks(app: App, entry: IndexEntry, file: TFile, { edits, properties, generated }: ArchiveLinkPlan): Promise<void> {
	const propertyLinks = new Map(properties);
	const generatedLinks = new Map(generated);
	const knownLink = (link: string): string => {
		const path = /^!?\[\[([^#|\]]+)/.exec(link)?.[1];
		const target = path ? generatedLinks.get(path) : undefined;
		return target ? newLink(link, file.path, target) ?? link : link;
	};
	const change = (current: string): string => {
		let next = current;
		for (const { original, start, end, replacement } of edits) {
			if (current.slice(start, end) === original) next = next.slice(0, start) + replacement + next.slice(end);
		}
		const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(next)?.[0] ?? '';
		// A freshly written transcript can precede its metadata cache. Its generated links use exact vault paths.
		const body = next.slice(frontmatter.length);
		return frontmatter.replace(/!?\[\[[^\r\n]*?\]\]/g, (link) => propertyLinks.get(link) ?? link) +
			(generatedLinks.size ? body.replace(/!?\[\[[^\r\n]*?\]\]/g, knownLink) : body);
	};
	const current = await app.vault.read(file);
	if (current === change(current)) return;
	await app.vault.process(file, (text) => {
		const next = change(text);
		// Changes to links alone must not cause a false edited-note warning on a later update.
		if (entry.noteHash && entry.noteHash === noteHash(text)) entry.noteHash = noteHash(next);
		return next;
	});
}
