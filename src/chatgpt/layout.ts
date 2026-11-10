// Turns ChatGPT's layout answers into the note: the Markdown stays Markdown, and each
// visual block (cards, grids, badges, charts, drawings …) becomes one HTML block that
// the plugin's styles draw like ChatGPT does. Source chips become named links.
// Falls back to ChatGPT's own flat Markdown (fallbackMarkdown) when unsure.

import { citeSources, formatCites } from './cites';
import { dedent, ICONS, isElement, literal, resolve, str, type Ctx } from './layout-common';
import { layoutBlock } from './layout-html';
import { hasLayout, LayoutError, parseLayout, type LayoutElement, type LayoutNode } from './layout-parse';

const BLOCK = '\u0001';
const tidy = (md: string) => md.replace(/\n{3,}/g, '\n\n').trim();
const quote = (md: string) => md.split('\n').map((l) => l ? '> ' + l : '>').join('\n');

/** The answer's own level: Markdown text with inline sources and links, blocks in between. */
function children(nodes: LayoutNode[], ctx: Ctx): string {
	const blocks: string[] = [];
	let text = '';
	const addBlock = (md: string) => {
		blocks.push(md);
		text += '\n' + BLOCK + (blocks.length - 1) + BLOCK + '\n';
	};
	for (const n of nodes) {
		if (typeof n === 'string') text += n;
		else if (!isElement(n)) text += literal(n.expr, ctx.scope);
		else {
			const r = element(n, ctx);
			if (r.block) addBlock(r.md);
			else text += r.md;
		}
	}
	return tidy(dedent(text).replace(new RegExp(BLOCK + '(\\d+)' + BLOCK, 'g'), (_m, k: string) => '\n\n' + blocks[Number(k)]! + '\n\n'));
}

function element(el: LayoutElement, ctx: Ctx): { md: string; block: boolean } {
	const a = resolve(el.attrs, ctx.scope);
	const inline = (md: string) => ({ md, block: false });
	const block = (md: string) => ({ md, block: true });
	const oneLine = () => children(el.children, ctx).replace(/\s*\n+\s*/g, ' ');
	switch (el.tag) {
		case 'Cite':
			return inline(formatCites([...(Array.isArray(a.refs) ? a.refs : []), ...(typeof a.ref === 'string' ? [a.ref] : [])].filter((r): r is string => typeof r === 'string'), ctx.cites));
		case 'Link': {
			const title = str(a.title) ?? oneLine();
			const url = str(a.url);
			if (!url || !/^https?:\/\//i.test(url)) return inline(title);
			return inline(`[${title.replace(/[[\]]/g, '')}](${/[\s()<>]/.test(url) ? '<' + url + '>' : url})`);
		}
		case 'Entity':
			return inline(str(a.value) ?? ctx.names.get(str(a.ref) ?? '') ?? oneLine());
		case 'icon':
			return inline(ICONS[str(a.name) ?? ''] ?? '');
		case 'CodeCite':
		case 'MemoryCite':
		case 'spacer':
			return inline('');
		case 'title':
			return block('### ' + oneLine());
		case 'caption':
			return block('*' + oneLine() + '*');
		case 'divider':
			return block('---');
		case 'CodeBlock':
			return block('```' + (str(a.language) ?? '') + '\n' + dedent(el.raw ?? '').replace(/^\n+|\n+$/g, '') + '\n```');
		case 'WritingBlock': {
			// A draft (email, document) to copy: kept as Markdown so headings and lists stay editable.
			const subject = str(a.subject);
			return block(quote((subject ? `**Subject:** ${subject}\n\n` : '') + children(el.children, ctx)));
		}
		default:
			return block(layoutBlock(el, ctx));
	}
}

/** entity markers in the flat version: entity["turn1business2","Name",…] */
function markerNames(flat: string): Map<string, string> {
	const names = new Map<string, string>();
	for (const m of flat.matchAll(/entity([^]*)/g)) {
		try {
			const v = JSON.parse(m[1]!) as unknown;
			if (Array.isArray(v) && typeof v[0] === 'string' && /^turn\d+/.test(v[0]) && typeof v[1] === 'string') names.set(v[0], v[1]);
		} catch {
			/* not a name */
		}
	}
	return names;
}

/** Text the parser left as text that still looks like markup (an unknown tag). */
function strayMarkup(nodes: LayoutNode[]): boolean {
	return nodes.some((n) => {
		if (typeof n === 'string') {
			const prose = n.replace(/```[^]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/<br\s*\/?>/gi, '');
			return /<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/.test(prose);
		}
		return isElement(n) && strayMarkup(n.children);
	});
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []));

/**
 * The answer with its layout, or null when the message has no layout markup or the result
 * would lose words that ChatGPT's own flat version (fallback) has.
 */
export function layoutMarkdown(text: string, metadata: unknown, fallback: string | null): string | null {
	if (!hasLayout(text)) return null;
	let md: string;
	try {
		const tree = parseLayout(text);
		if (strayMarkup(tree)) return null;
		md = children(tree, { cites: citeSources(metadata), names: markerNames(fallback ?? ''), scope: {} });
	} catch (e) {
		if (e instanceof LayoutError) return null;
		throw e;
	}
	if (fallback) {
		const have = words(md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
		// Hidden markers (sources, names, image searches) are not visible words.
		const visible = fallback.replace(/[^]*/g, ' ')
			.replace(/^:::[\w-]+\{([^}]*)\}/gm, (_m, a: string) => [...a.matchAll(/(?:subject|title)="([^"]*)"/g)].map((v) => v[1]).join(' '));
		const want = [...words(visible)];
		const missing = want.filter((w) => !have.has(w)).length;
		if (want.length && missing / want.length > 0.05) return null;
	}
	return md;
}
