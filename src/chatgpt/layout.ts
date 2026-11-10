// Turns ChatGPT's layout markup (boxes, grids, icons, source chips, charts …) into
// Obsidian Markdown that keeps the structure seen on screen: bordered boxes become
// quotes, grids and rows become tables, arrows stay arrows, sources become links.
// Falls back to ChatGPT's own flat Markdown (fallbackMarkdown) when unsure.

import { citeSources, formatCites, type CiteSources } from './cites';
import { hasLayout, LayoutError, parseLayout, type Attr, type LayoutElement, type LayoutNode } from './layout-parse';
import { renderSvg } from './layout-svg';
import { eachHead, evalExpr, type Scope } from './layout-eval';

interface Ctx {
	cites: CiteSources;
	/** Names of places, people … by ref, from the markers in ChatGPT's flat version. */
	names: Map<string, string>;
	/** 0 = the answer itself, more inside layout elements. */
	depth: number;
	/** Loop items in reach ({#each … as a} makes a). */
	scope: Scope;
}

const ICONS: Record<string, string> = {
	'arrow-up-down': '⇅', 'arrow-down-up': '⇅', 'arrow-down': '↓', 'arrow-up': '↑', 'arrow-right': '→', 'arrow-left': '←',
	'arrow-left-right': '⇄', 'arrow-right-left': '⇄', 'chevron-right': '›', 'chevron-left': '‹', 'chevron-down': '⌄', 'chevron-up': '⌃',
	plus: '+', minus: '−', equals: '=', check: '✓', 'check-circle': '✓', 'circle-check': '✓', x: '✗', 'x-circle': '✗', 'circle-x': '✗',
	'alert-triangle': '⚠', 'triangle-alert': '⚠', warning: '⚠', 'alert-circle': '⚠', info: 'ℹ', star: '★', clock: '🕒', calendar: '📅',
	'map-pin': '📍', mail: '✉', phone: '☎', link: '🔗', lock: '🔒', 'external-link': '↗', lightbulb: '💡', search: '🔍',
};

const BLOCK = '\u0001';
const str = (a: Attr | undefined): string | null => typeof a === 'string' ? a : typeof a === 'number' ? String(a) : null;
const strings = (a: Attr | undefined): string[] => Array.isArray(a) ? a.filter((v): v is string => typeof v === 'string') : typeof a === 'string' ? [a] : [];

/** Remove the indentation the markup adds, keeping relative indentation (nested lists). */
function dedent(text: string): string {
	const lines = text.split('\n');
	const indents = lines.filter((l) => l.trim() && !l.trim().startsWith(BLOCK)).map((l) => /^[ \t]*/.exec(l)![0].length);
	const cut = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.trim().startsWith(BLOCK) ? l.trim() : l.trim() ? l.slice(cut).trimEnd() : '').join('\n');
}

const tidy = (md: string) => md.replace(/\n{3,}/g, '\n\n').trim();
const quote = (md: string) => md.split('\n').map((l) => l ? '> ' + l : '>').join('\n');

/** One Markdown table cell, or null when the content cannot sit in a cell. */
function cell(md: string): string | null {
	if (/```|^\s*\||<svg/m.test(md)) return null;
	const lines = md.split('\n').map((l) => l.replace(/^(>\s?)+/, '').trim()).filter((l) => l && l !== '---');
	return lines.join('<br>').replace(/\|/g, '\\|');
}

function table(rows: string[][]): string {
	const width = Math.max(...rows.map((r) => r.length));
	const line = (r: string[]) => '| ' + Array.from({ length: width }, (_v, k) => r[k] || ' ').join(' | ') + ' |';
	return [line(rows[0]!), '|' + ' --- |'.repeat(width), ...rows.slice(1).map(line)].join('\n');
}

/** A {…} child: plain text written as a string is shown; anything computed on screen is not. */
function literal(expr: string, scope: Scope): string {
	const t = expr.trim();
	const v = evalExpr(t, scope);
	if (typeof v === 'string' || typeof v === 'number') return String(v);
	if (/^`[^`]*`$/.test(t) && !t.includes('${')) return t.slice(1, -1);
	if (/^"[^"\\]*"$|^'[^'\\]*'$/.test(t)) return t.slice(1, -1);
	return '…';
}

/** The source of a {…} attribute that is code rather than data, else null. */
function exprOf(a: Attr | undefined): string | null {
	const e = a !== null && typeof a === 'object' && !Array.isArray(a) ? (a as { expr?: unknown }).expr : undefined;
	return typeof e === 'string' ? e : null;
}

/** One result per loop item; a loop over data only known on screen shows "…". */
function repeat<T>(el: LayoutElement, ctx: Ctx, render: (c: Ctx) => T): (T | string)[] {
	const head = eachHead(exprOf(el.attrs.head) ?? '', ctx.scope);
	if (!head) return ['…'];
	return head.list.map((item, k) => render({ ...ctx, scope: { ...ctx.scope, [head.name]: item, ...(head.index ? { [head.index]: k } : {}) } }));
}

const isElement = (n: LayoutNode): n is LayoutElement => typeof n === 'object' && 'tag' in n;

function children(nodes: LayoutNode[], ctx: Ctx): string {
	const blocks: string[] = [];
	let text = '';
	for (const n of nodes) {
		if (typeof n === 'string') text += n;
		else if (!isElement(n)) text += literal(n.expr, ctx.scope);
		else if (n.tag === '#each') {
			for (const md of repeat(n, ctx, (c) => children(n.children, c))) {
				blocks.push(md);
				text += '\n' + BLOCK + (blocks.length - 1) + BLOCK + '\n';
			}
		} else {
			const r = element(n, ctx);
			if (r.block) {
				blocks.push(r.md);
				text += '\n' + BLOCK + (blocks.length - 1) + BLOCK + '\n';
			} else text += r.md;
		}
	}
	const out = dedent(text).replace(new RegExp(BLOCK + '(\\d+)' + BLOCK, 'g'), (_m, k: string) => '\n\n' + blocks[Number(k)]! + '\n\n');
	return tidy(out);
}

/** The items of a grid or row, each rendered on its own. */
function items(nodes: LayoutNode[], ctx: Ctx): string[] {
	const out: string[] = [];
	for (const n of nodes) {
		if (isElement(n) && n.tag === '#each') {
			for (const group of repeat(n, ctx, (c) => items(n.children, c))) out.push(...group);
			continue;
		}
		const md = typeof n === 'string' ? tidy(dedent(n)) : isElement(n) ? tidy(element(n, ctx).md) : literal(n.expr, ctx.scope);
		if (md) out.push(md);
	}
	return out;
}

function grid(cells: string[], columns: number): string {
	const safe = cells.map(cell);
	if (safe.some((c) => c === null) || !cells.length) return cells.join('\n\n');
	const rows: string[][] = [];
	for (let k = 0; k < safe.length; k += columns) rows.push(safe.slice(k, k + columns) as string[]);
	return table(rows);
}

const cellText = (v: unknown): string => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

function chart(content: Attr | undefined): string {
	const c = content !== null && typeof content === 'object' && !Array.isArray(content) && !('expr' in content) ? content : null;
	const data = Array.isArray(c?.data) ? c.data as Record<string, unknown>[] : null;
	const series = Array.isArray(c?.series) ? c.series as { dataKey?: string; label?: string }[] : null;
	if (!c || !data || !series || typeof c.xKey !== 'string') return '*[chart – see raw JSON]*';
	const meta = (c.meta ?? {}) as { title?: unknown; footer?: unknown };
	const keys = [c.xKey, ...series.map((s) => s.dataKey ?? '')];
	const rows = [[c.xKey, ...series.map((s) => s.label ?? s.dataKey ?? '')], ...data.map((d) => keys.map((k) => cellText(d[k])))];
	const parts = [typeof meta.title === 'string' ? `**${meta.title}**` : '', `*Chart (${typeof c.chartType === 'string' ? c.chartType : 'chart'}):*`,
		table(rows.map((r) => r.map((v) => v.replace(/\|/g, '\\|')))), typeof meta.footer === 'string' ? `*${meta.footer}*` : ''];
	return parts.filter(Boolean).join('\n\n');
}

/** Attributes such as value={a.name} filled from the loop item. */
function resolve(attrs: Record<string, Attr>, scope: Scope): Record<string, Attr> {
	const out: Record<string, Attr> = {};
	for (const [k, v] of Object.entries(attrs)) {
		const expr = exprOf(v);
		const got = expr === null ? undefined : evalExpr(expr, scope);
		out[k] = typeof got === 'string' || typeof got === 'number' ? got : v;
	}
	return out;
}

function element(el: LayoutElement, outer: Ctx): { md: string; block: boolean } {
	const ctx = { ...outer, depth: outer.depth + 1 };
	const a = resolve(el.attrs, ctx.scope);
	const inner = () => children(el.children, ctx);
	const inline = (md: string) => ({ md, block: false });
	const block = (md: string) => ({ md, block: true });
	switch (el.tag) {
		case 'box': {
			const md = inner();
			return block(md && (a.border || a.background) ? quote(md) : md);
		}
		case 'grid-item':
		case 'form':
			return block(inner());
		case 'grid': {
			const cells = items(el.children, ctx);
			const n = Number(str(a.columns));
			return block(grid(cells, Number.isInteger(n) && n > 0 ? Math.min(n, 6) : Math.min(cells.length, 4) || 1));
		}
		case 'row': {
			const cells = items(el.children, ctx);
			if (cells.length <= 1 || cells.every((c) => !c.includes('\n') && !c.startsWith('>'))) return block(cells.join(' · '));
			return block(grid(cells, cells.length));
		}
		case 'text':
		case 'label':
			return inline(inner());
		case 'title':
			return block(outer.depth === 0 ? '### ' + inner().replace(/\n+/g, ' ') : `**${inner().replace(/\n+/g, ' ')}**`);
		case 'caption':
			return block(`*${inner().replace(/\n+/g, ' ')}*`);
		case 'icon':
			return inline(ICONS[str(a.name) ?? ''] ?? '');
		case 'badge': {
			const t = inner().replace(/\s+/g, ' ').trim();
			return inline(t && !t.includes('`') ? '`' + t + '`' : t);
		}
		case 'divider':
			return block('---');
		case 'spacer':
		case 'CodeCite':
		case 'MemoryCite':
			return inline('');
		case 'list': {
			const numbered = str(a.marker) === 'number';
			const entries = el.children.filter(isElement).map((c) => tidy(element(c, ctx).md));
			return block(entries.map((e, k) => {
				const mark = numbered ? `${k + 1}. ` : '- ';
				return mark + e.split('\n').join('\n' + ' '.repeat(mark.length));
			}).join('\n'));
		}
		case 'list-item':
			return block(inner());
		case 'WritingBlock': {
			const subject = str(a.subject);
			return block(quote((subject ? `**Subject:** ${subject}

` : '') + inner()));
		}
		case 'table': {
			const rows = el.children.filter(isElement).map((r) => r.children.filter(isElement).map((c) => cell(children(c.children, ctx))));
			if (!rows.length || rows.some((r) => r.some((c) => c === null))) return block(inner());
			return block(table(rows as string[][]));
		}
		case 'table-row':
		case 'table-cell':
			return block(inner());
		case 'radio-group':
			return block(el.children.filter(isElement).map((r) => '- ○ ' + children(r.children, ctx)).join('\n'));
		case 'radio':
			return inline('○ ' + inner());
		case 'checkbox':
			return inline('☐ ' + (str(a.label) ?? inner()));
		case 'button':
			return inline('[' + inner().replace(/\s+/g, ' ') + ']');
		case 'input':
			return inline('[____]');
		case 'slider':
			return inline(`[slider ${str(a.min) ?? ''}–${str(a.max) ?? ''}]`);
		case 'segmented-control': {
			const options = Array.isArray(a.options) ? a.options.map((o) => typeof o === 'string' ? o : str((o as { label?: Attr }).label) ?? '') : [];
			return inline('[' + options.filter(Boolean).join(' | ') + ']');
		}
		case 'Cite':
			return inline(formatCites([...strings(a.refs), ...strings(a.ref)], ctx.cites));
		case 'Link': {
			const title = str(a.title) ?? inner();
			const url = str(a.url);
			if (!url || !/^https?:\/\//i.test(url)) return inline(title);
			return inline(`[${title.replace(/[[\]]/g, '')}](${/[\s()<>]/.test(url) ? '<' + url + '>' : url})`);
		}
		case 'Entity':
			return inline(str(a.value) ?? ctx.names.get(str(a.ref) ?? '') ?? inner());
		case 'AsyncImage': {
			const what = str(a.alt) ?? str(a.query);
			return block(what ? `*[image: ${what}]*` : '*[image]*');
		}
		case 'AsyncImageGroup': {
			const what = strings(a.query);
			return block(what.length ? `*[images: ${what.join('; ')}]*` : '*[images]*');
		}
		case 'Chart':
			return block(chart(a.content));
		case 'CodeBlock': {
			const code = dedent(el.raw ?? '').replace(/^\n+|\n+$/g, '');
			return block('```' + (str(a.language) ?? '') + '\n' + code + '\n```');
		}
		case 'MapWidgetV2':
			return block([`*[map: ${str(a.title) ?? 'see raw JSON'}]*`, str(a.narrative) ?? ''].filter(Boolean).join('\n\n'));
		case 'svg':
			return block(renderSvg(el, ctx.scope) ?? '*[diagram – see raw JSON]*');
		default:
			return block(inner());
	}
}

/** entity markers in the flat version: entity["turn1business2","Name",…] */
function markerNames(flat: string): Map<string, string> {
	const names = new Map<string, string>();
	for (const m of flat.matchAll(/\uE200entity\uE202([^\uE201]*)\uE201/g)) {
		try {
			const v = JSON.parse(m[1]!) as unknown;
			if (Array.isArray(v) && typeof v[0] === 'string' && /^turn\d+/.test(v[0]) && typeof v[1] === 'string') names.set(v[0], v[1]);
		} catch {
			/* not a name */
		}
	}
	return names;
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []));

/**
 * The answer as structured Markdown, or null when the message has no layout markup or the
 * result would lose words that ChatGPT's own flat version (fallback) has.
 */
export function layoutMarkdown(text: string, metadata: unknown, fallback: string | null): string | null {
	if (!hasLayout(text)) return null;
	let md: string;
	try {
		md = children(parseLayout(text), { cites: citeSources(metadata), names: markerNames(fallback ?? ''), depth: 0, scope: {} });
	} catch (e) {
		if (e instanceof LayoutError) return null;
		throw e;
	}
	const prose = md.replace(/```[^]*?```/g, '').replace(/<svg[^]*?<\/svg>/g, '');
	if (/<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/.test(prose.replace(/<br\s*\/?>/gi, ''))) return null;
	if (fallback) {
		const have = words(md);
		// Hidden markers (sources, names, image searches) are not visible words.
		const visible = fallback.replace(/\uE200[^\uE201]*\uE201/g, ' ')
			.replace(/^:::[\w-]+\{([^}]*)\}/gm, (_m, a: string) => [...a.matchAll(/(?:subject|title)="([^"]*)"/g)].map((v) => v[1]).join(' '));
		const want = [...words(visible)];
		const missing = want.filter((w) => !have.has(w)).length;
		if (want.length && missing / want.length > 0.05) return null;
	}
	return md;
}
