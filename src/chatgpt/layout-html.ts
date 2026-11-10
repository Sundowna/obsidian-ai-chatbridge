// ChatGPT layout elements (cards, grids, badges, charts …) as HTML for Obsidian, styled by
// the plugin's ccs-gpt-* classes (styles.css) with the theme's own colours. Icons carry
// their Lucide name (data-icon) for the reading view to draw, and a text stand-in.

import { citeLinks } from './cites';
import { cellText, dedent, ICONS, isElement, literal, repeat, resolve, str, strings, type Ctx } from './layout-common';
import { BLOCK, blockHtml, esc, INLINE } from './layout-md';
import type { Attr, LayoutElement, LayoutNode } from './layout-parse';
import { renderSvg } from './layout-svg';

const COLORS: Record<string, string> = {
	secondary: 'muted', tertiary: 'muted', subtle: 'muted', muted: 'muted',
	success: 'success', warning: 'warning', danger: 'danger', error: 'danger', destructive: 'danger', info: 'info',
};
const SIZES: Record<string, string> = { '2xs': 'xs', xs: 'xs', sm: 'sm', lg: 'lg', xl: 'xl', '2xl': '2xl', '3xl': '2xl' };

function classes(base: string, a: Record<string, Attr>): string {
	const c = [base];
	const color = COLORS[str(a.color) ?? ''];
	if (color) c.push('ccs-gpt-' + color);
	const size = SIZES[str(a.size) ?? ''];
	if (size) c.push('ccs-gpt-size-' + size);
	if (str(a.align) === 'center' || str(a.textAlign) === 'center') c.push('ccs-gpt-center');
	if (/^(bold|semibold|medium)$/.test(str(a.weight) ?? '')) c.push('ccs-gpt-strong');
	return c.join(' ');
}

/** Children as HTML: Markdown text plus the elements in between, in order. */
export function htmlChildren(nodes: LayoutNode[], ctx: Ctx): string {
	const pieces: string[] = [];
	const token = (html: string, block: boolean) => {
		pieces.push(html);
		const t = (block ? BLOCK : INLINE) + (pieces.length - 1) + (block ? BLOCK : INLINE);
		return block ? '\n' + t + '\n' : t;
	};
	let text = '';
	for (const n of nodes) {
		if (typeof n === 'string') text += n;
		else if (!isElement(n)) text += literal(n.expr, ctx.scope);
		else if (n.tag === '#each') {
			for (const html of repeat(n, ctx, (c) => htmlChildren(n.children, c)) ?? ['<div class="ccs-gpt-p">…</div>']) text += token(html, true);
		} else {
			const r = element(n, ctx);
			text += token(r.html, r.block);
		}
	}
	return blockHtml(dedent(text), pieces);
}

/** Each child of a grid or row on its own (loops give one per item). */
function cells(nodes: LayoutNode[], ctx: Ctx): string[] {
	const out: string[] = [];
	// Text and inline pieces (names, links, icons …) next to each other form one cell,
	// so Markdown around them (**1. <Entity/>**) stays intact.
	let run: LayoutNode[] = [];
	const flush = () => {
		const html = run.some((n) => typeof n !== 'string' || n.trim()) ? htmlChildren(run, ctx) : '';
		if (html.trim()) out.push(html);
		run = [];
	};
	for (const n of nodes) {
		if (isElement(n) && n.tag === '#each') {
			flush();
			for (const group of repeat(n, ctx, (c) => cells(n.children, c)) ?? [['…']]) out.push(...group);
		} else if (isElement(n) && !INLINE_TAGS.has(n.tag)) {
			flush();
			out.push(element(n, ctx).html);
		} else run.push(n);
	}
	flush();
	return out;
}

const INLINE_TAGS = new Set(['Entity', 'Cite', 'CodeCite', 'MemoryCite', 'Link', 'icon', 'badge', 'button', 'input', 'slider', 'segmented-control']);

function chart(content: Attr | undefined): string {
	const c = content !== null && typeof content === 'object' && !Array.isArray(content) && !('expr' in content) ? content : null;
	const data = Array.isArray(c?.data) ? c.data as Record<string, unknown>[] : null;
	const series = Array.isArray(c?.series) ? c.series as { dataKey?: string; label?: string }[] : null;
	if (!c || !data || !series || typeof c.xKey !== 'string') return '<div class="ccs-gpt-caption">Chart – see raw JSON</div>';
	const xKey = c.xKey;
	const meta = (c.meta ?? {}) as { title?: unknown; footer?: unknown };
	const out: string[] = [];
	if (typeof meta.title === 'string') out.push(`<div class="ccs-gpt-title">${esc(meta.title)}</div>`);
	for (const s of series) {
		const key = s.dataKey ?? '';
		const values = data.map((d) => Number(d[key]));
		const max = Math.max(...values.filter((v) => Number.isFinite(v) && v > 0), 0);
		if (series.length > 1) out.push(`<div class="ccs-gpt-label">${esc(s.label ?? key)}</div>`);
		out.push('<div class="ccs-gpt-bars">' + data.map((d, k) => {
			const v = values[k]!;
			const width = max > 0 && Number.isFinite(v) && v > 0 ? Math.round((v / max) * 100) : 0;
			return `<div class="ccs-gpt-bar-row"><span class="ccs-gpt-bar-label">${esc(cellText(d[xKey]))}</span><span class="ccs-gpt-bar-track"><span class="ccs-gpt-bar" style="width:${width}%"></span></span><span class="ccs-gpt-bar-value">${esc(cellText(d[key]))}</span></div>`;
		}).join('') + '</div>');
	}
	if (typeof meta.footer === 'string') out.push(`<div class="ccs-gpt-caption">${esc(meta.footer)}</div>`);
	return out.join('\n');
}

/** A single paragraph without its wrapper, to sit on one line after a mark (○ label). */
function flat(html: string): string {
	const m = /^<div class="ccs-gpt-p">([^]*)<\/div>$/.exec(html);
	return m && !m[1]!.includes('ccs-gpt-p') ? m[1]! : html;
}

function icon(name: string, a: Record<string, Attr>): string {
	return `<span class="${classes('ccs-gpt-icon', a)}" data-icon="${esc(name)}">${esc(ICONS[name] ?? '')}</span>`;
}

function element(el: LayoutElement, ctx: Ctx): { html: string; block: boolean } {
	const a = resolve(el.attrs, ctx.scope);
	const inner = () => htmlChildren(el.children, ctx);
	const block = (html: string) => ({ html, block: true });
	const inline = (html: string) => ({ html, block: false });
	const div = (cls: string, style = '') => block(`<div class="${classes(cls, a)}"${style}>${inner()}</div>`);
	switch (el.tag) {
		case 'box': {
			const c = ['ccs-gpt-box'];
			if (a.border) c.push('ccs-gpt-border');
			if (a.background) c.push('ccs-gpt-fill');
			if (!a.border && !a.background) c.push('ccs-gpt-plain');
			if (str(a.direction) === 'row') c.push('ccs-gpt-dir-row');
			// In a row: flex="1" takes the rest, a set width (flex="0 0 126px", width="40px") stays that wide.
			const flex = str(a.flex) ?? '';
			const width = /^\d{1,4}(px|%)$/.exec(str(a.width) ?? '')?.[0] ?? /(\d{1,4}px)$/.exec(flex)?.[1];
			if (/^1(\s|$)/.test(flex)) c.push('ccs-gpt-grow');
			if (width) c.push('ccs-gpt-fixed');
			return div(c.join(' '), width ? ` style="width:${width}"` : '');
		}
		case 'grid': {
			const n = Number(str(a.columns));
			const all = cells(el.children, ctx);
			const cols = Number.isInteger(n) && n > 0 ? Math.min(n, 6) : Math.min(all.length, 4) || 1;
			return block(`<div class="ccs-gpt-grid ccs-gpt-cols-${cols}">` + all.map((h) => h.startsWith('<div class="ccs-gpt-cell') ? h : `<div class="ccs-gpt-cell">${h}</div>`).join('\n') + '</div>');
		}
		case 'grid-item':
			return div('ccs-gpt-cell');
		case 'row': {
			const c = ['ccs-gpt-row'];
			const justify = str(a.justify);
			if (justify && /^(center|between|end)$/.test(justify)) c.push('ccs-gpt-justify-' + justify);
			if (str(a.align) === 'start') c.push('ccs-gpt-align-start');
			return block(`<div class="${c.join(' ')}">` + cells(el.children, ctx).join('\n') + '</div>');
		}
		case 'text':
			return div('ccs-gpt-text');
		case 'title':
			return div('ccs-gpt-title');
		case 'caption':
			return div('ccs-gpt-caption');
		case 'label':
			return div('ccs-gpt-label');
		case 'form':
			return div('ccs-gpt-form');
		case 'list-item':
			return div('ccs-gpt-text');
		case 'icon':
			return inline(icon(str(a.name) ?? '', a));
		case 'badge':
			return inline(`<span class="${classes('ccs-gpt-badge', a)}">${inner().replace(/<\/?div[^>]*>/g, '')}</span>`);
		case 'divider':
			return block('<div class="ccs-gpt-divider"></div>');
		case 'spacer':
			return block('<div class="ccs-gpt-spacer"></div>');
		case 'CodeCite':
		case 'MemoryCite':
			return inline('');
		case 'list': {
			const tag = str(a.marker) === 'number' ? 'ol' : 'ul';
			const items = el.children.filter(isElement).map((c) => '<li>' + htmlChildren(c.children, ctx) + '</li>');
			return block(`<${tag} class="ccs-gpt-list${a.connector ? ' ccs-gpt-timeline' : ''}">` + items.join('') + `</${tag}>`);
		}
		case 'table': {
			const rows = el.children.filter(isElement).map((r) => '<tr>' + r.children.filter(isElement).map((c) => {
				const t = c.attrs.header ? 'th' : 'td';
				return `<${t}>${htmlChildren(c.children, ctx)}</${t}>`;
			}).join('') + '</tr>');
			return block('<table class="ccs-gpt-table">' + rows.join('') + '</table>');
		}
		case 'table-row':
		case 'table-cell':
			return div('ccs-gpt-text');
		case 'radio-group':
			return block('<div class="ccs-gpt-radios">' + el.children.filter(isElement).map((r) => `<div class="ccs-gpt-radio">○ ${flat(htmlChildren(r.children, ctx))}</div>`).join('') + '</div>');
		case 'radio':
			return block(`<div class="ccs-gpt-radio">○ ${flat(inner())}</div>`);
		case 'checkbox':
			return block(`<div class="ccs-gpt-radio">☐ ${str(a.label) !== null ? esc(str(a.label)!) : flat(inner())}</div>`);
		case 'button':
			return inline(`<span class="ccs-gpt-button">${inner().replace(/<\/?div[^>]*>/g, '')}</span>`);
		case 'input':
			return inline('<span class="ccs-gpt-input"></span>');
		case 'slider':
			return inline(`<span class="ccs-gpt-slider"><span>${esc(str(a.min) ?? '')}</span><span class="ccs-gpt-slider-track"></span><span>${esc(str(a.max) ?? '')}</span></span>`);
		case 'segmented-control': {
			const options = Array.isArray(a.options) ? a.options.map((o) => typeof o === 'string' ? o : str((o as { label?: Attr }).label) ?? '') : [];
			return inline('<span class="ccs-gpt-segments">' + options.filter(Boolean).map((o) => `<span>${esc(o)}</span>`).join('') + '</span>');
		}
		case 'Cite': {
			const refs = [...strings(a.refs), ...strings(a.ref)];
			const links = citeLinks(refs, ctx.cites);
			if (!links.length) return inline(refs.length ? '<span class="ccs-gpt-chip">Unresolved source</span>' : '');
			return inline(links.map((s) => `<a class="ccs-gpt-chip" href="${esc(s.url)}">${esc(s.label)}</a>`).join(' '));
		}
		case 'Link': {
			const url = str(a.url);
			const title = str(a.title);
			const label = title !== null ? esc(title) : inner().replace(/<\/?div[^>]*>/g, '');
			return inline(url && /^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${label}</a>` : label);
		}
		case 'Entity':
			return inline(esc(str(a.value) ?? ctx.names.get(str(a.ref) ?? '') ?? '') || inner());
		case 'AsyncImage':
		case 'AsyncImageGroup': {
			const what = str(a.alt) ?? strings(a.query).join('; ');
			return block(`<div class="ccs-gpt-image">${icon('image', {})}<span>${esc(what || 'Image')}</span></div>`);
		}
		case 'Chart':
			return block(`<div class="ccs-gpt-box ccs-gpt-border">${chart(a.content)}</div>`);
		case 'CodeBlock': {
			const code = dedent(el.raw ?? '').replace(/^\n+|\n+$/g, '');
			return block('<pre><code>' + code.split('\n').map(esc).join('&#10;') + '</code></pre>');
		}
		case 'WritingBlock': {
			const subject = str(a.subject);
			return block('<div class="ccs-gpt-box ccs-gpt-border ccs-gpt-writing">' + (subject ? `<div class="ccs-gpt-title">${esc(subject)}</div>` : '') + inner() + '</div>');
		}
		case 'MapWidgetV2':
			return block(`<div class="ccs-gpt-box ccs-gpt-border"><div class="ccs-gpt-title">${icon('map-pin', {})} ${esc(str(a.title) ?? 'Map')}</div>` +
				(str(a.narrative) ? `<div class="ccs-gpt-caption">${esc(str(a.narrative)!)}</div>` : '') + '</div>');
		case 'svg':
			return block(renderSvg(el, ctx.scope) ?? '<div class="ccs-gpt-caption">Diagram – see raw JSON</div>');
		default:
			return block(inner());
	}
}

/** One top-level layout element as an HTML block for the note (no blank lines inside). */
export function layoutBlock(el: LayoutElement, ctx: Ctx): string {
	const html = el.tag === '#each' ? htmlChildren([el], ctx) : element(el, ctx).html;
	return '<div class="ccs-gpt">' + html.replace(/\n\s*\n/g, '\n') + '</div>';
}
