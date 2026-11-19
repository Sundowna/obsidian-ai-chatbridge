// Links inside a canvas (JSON Canvas: { nodes: [...], edges: [...] }) for "Merge chat copies into
// one note". Two kinds of node can point at a note: a file node by its full vault path, and a text
// node by the links written in its Markdown. Everything else in the file is left exactly as it is.
// No Obsidian imports, so the offline test can run it.

import { rewriteLinks, type LinkRef } from './merge';

/** A link found in a canvas: a file node's `file` (written as the path itself) or a link in a text node. */
export interface CanvasRef extends LinkRef {
	kind: 'file' | 'text';
}

interface CanvasNode {
	type?: unknown;
	file?: unknown;
	text?: unknown;
	[key: string]: unknown;
}

interface Canvas {
	nodes: CanvasNode[];
	[key: string]: unknown;
}

/** The canvas, or null if the text is not JSON shaped like JSON Canvas (then it is left alone). */
export function parseCanvas(text: string): Canvas | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const c = data as Record<string, unknown>;
	const nodes = c.nodes;
	if (!Array.isArray(nodes) || !nodes.every((n) => typeof n === 'object' && n !== null && !Array.isArray(n))) return null;
	if (c.edges !== undefined && !Array.isArray(c.edges)) return null;
	return c as Canvas;
}

/** Every link written in a piece of Markdown, with the path it names (heading and alias cut off). */
export function linksInText(text: string): { original: string; linkpath: string }[] {
	const out: { original: string; linkpath: string }[] = [];
	for (const m of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
		const linkpath = (m[1]!.split('|')[0] ?? '').split('#')[0]!.trim();
		if (linkpath) out.push({ original: m[0], linkpath });
	}
	for (const m of text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)\)/g)) {
		let url = m[1]!.replace(/^<|>$/g, '').split('#')[0]!;
		if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // web links, obsidian:// and the like
		try {
			url = decodeURIComponent(url);
		} catch {
			continue;
		}
		out.push({ original: m[0], linkpath: url });
	}
	return out;
}

/**
 * The links in a canvas that point at one of `targets`. `resolve` finds the file a link path
 * means from this canvas (Obsidian's getFirstLinkpathDest). Null if the canvas cannot be read.
 */
export function canvasLinks(text: string, targets: ReadonlySet<string>, resolve: (linkpath: string) => string | null): CanvasRef[] | null {
	const canvas = parseCanvas(text);
	if (!canvas) return null;
	const out: CanvasRef[] = [];
	for (const node of canvas.nodes) {
		if (node.type === 'file' && typeof node.file === 'string' && targets.has(node.file)) {
			out.push({ kind: 'file', original: node.file, from: node.file });
		} else if (node.type === 'text' && typeof node.text === 'string') {
			for (const l of linksInText(node.text)) {
				const dest = resolve(l.linkpath);
				if (dest && targets.has(dest)) out.push({ kind: 'text', original: l.original, from: dest });
			}
		}
	}
	return out;
}

/** The indentation the file already uses ("\t" as Obsidian writes it), or none for one line. */
function indentOf(text: string): string {
	return /^\{\r?\n([ \t]+)\S/.exec(text)?.[1] ?? (text.includes('\n') ? '\t' : '');
}

/**
 * Rewrites the links of `refs` in a canvas. File nodes get the full path of the new file
 * (`pathOf`, null if it is gone) and keep their `subpath`; text nodes go through `rewriteLinks`
 * with `linktextOf`. Unchanged = the same text back, so nothing needs writing. Null if the canvas
 * cannot be read.
 */
export function rewriteCanvas(
	text: string,
	refs: readonly CanvasRef[],
	pathOf: (from: string) => string | null,
	linktextOf: (from: string) => string | null,
): { text: string; changed: number; failed: LinkRef[] } | null {
	const canvas = parseCanvas(text);
	if (!canvas) return null;
	const fileRefs = new Map(refs.filter((r) => r.kind === 'file').map((r) => [r.original, r]));
	const textRefs = refs.filter((r) => r.kind === 'text');
	let changed = 0;
	const failed: LinkRef[] = [];
	const failedFiles = new Set<string>();
	for (const node of canvas.nodes) {
		if (node.type === 'file' && typeof node.file === 'string') {
			const ref = fileRefs.get(node.file);
			if (!ref) continue;
			const to = pathOf(ref.from);
			if (to === null) {
				if (!failedFiles.has(ref.original)) failed.push(ref);
				failedFiles.add(ref.original);
				continue;
			}
			if (to === node.file) continue;
			node.file = to;
			changed++;
		} else if (node.type === 'text' && typeof node.text === 'string' && textRefs.length) {
			const out = rewriteLinks(node.text, textRefs, linktextOf);
			for (const f of out.failed) if (!failed.some((x) => x.original === f.original)) failed.push(f);
			if (out.changed) {
				node.text = out.text;
				changed += out.changed;
			}
		}
	}
	if (!changed) return { text, changed, failed };
	const trailing = /\s*$/.exec(text)?.[0] ?? '';
	return { text: JSON.stringify(canvas, null, indentOf(text)) + trailing, changed, failed };
}

/** Every path a canvas names (file nodes and text links), for the check after the run. */
export function canvasLinkpaths(text: string): string[] | null {
	const canvas = parseCanvas(text);
	if (!canvas) return null;
	const out: string[] = [];
	for (const node of canvas.nodes) {
		if (node.type === 'file' && typeof node.file === 'string') out.push(node.file);
		else if (node.type === 'text' && typeof node.text === 'string') for (const l of linksInText(node.text)) out.push(l.linkpath);
	}
	return out;
}
