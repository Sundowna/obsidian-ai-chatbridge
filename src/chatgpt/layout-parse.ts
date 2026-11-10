// ChatGPT's newer answers mix layout markup into the Markdown text (seen 2026-11-10):
// JSX-like tags such as <box border>, <grid columns={3}>, <icon name="…"/>, <Cite refs={[…]}/>.
// This reads that text into a small tree. Only known tag names are parsed; anything
// else stays text. Throws LayoutError when the markup cannot be read safely.

export class LayoutError extends Error {}

export type Attr = string | number | boolean | unknown[] | Record<string, unknown> | { expr: string };

export interface LayoutElement {
	tag: string;
	attrs: Record<string, Attr>;
	children: LayoutNode[];
	/** Inner source for elements kept as they are (svg, CodeBlock). */
	raw?: string;
}

export type LayoutNode = string | LayoutElement | { expr: string };

export const LAYOUT_TAGS = new Set([
	'box', 'row', 'grid', 'grid-item', 'text', 'title', 'caption', 'icon', 'badge', 'divider', 'spacer',
	'list', 'list-item', 'table', 'table-row', 'table-cell', 'label', 'button', 'form', 'radio-group', 'radio',
	'input', 'slider', 'checkbox', 'segmented-control', 'Cite', 'CodeCite', 'MemoryCite', 'Link', 'Entity',
	'AsyncImage', 'AsyncImageGroup', 'Chart', 'CodeBlock', 'WritingBlock', 'MapWidgetV2', 'svg',
]);
const RAW_TAGS = new Set(['svg', 'CodeBlock']);

/** Does this text contain layout tags outside code? */
export function hasLayout(text: string): boolean {
	const prose = text.replace(/```[^]*?```/g, '').replace(/`[^`\n]*`/g, '');
	for (const m of prose.matchAll(/<([A-Za-z][\w-]*)[\s/>]/g)) if (LAYOUT_TAGS.has(m[1]!)) return true;
	return false;
}

/** Index just past the brace/bracket group that starts at s[i]. Skips strings inside. */
function skipGroup(s: string, i: number): number {
	const open = s[i]!;
	const close = open === '{' ? '}' : ']';
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		const ch = s[j]!;
		if (ch === '"' || ch === "'" || ch === '`') {
			const end = s.indexOf(ch, j + 1);
			if (end < 0) throw new LayoutError('unterminated string');
			j = end;
		} else if (ch === open) depth++;
		else if (ch === close && --depth === 0) return j + 1;
	}
	throw new LayoutError('unterminated ' + open);
}

function exprValue(inner: string): Attr {
	const t = inner.trim();
	try {
		const v = JSON.parse(t) as unknown;
		if (v !== null && (typeof v !== 'string' || /^"/.test(t))) return v as Attr;
	} catch {
		/* not plain data */
	}
	return { expr: t };
}

export function parseLayout(s: string): LayoutNode[] {
	let i = 0;

	const readTag = (): { el: LayoutElement; selfClosing: boolean } => {
		const name = /^<([A-Za-z][\w-]*)/.exec(s.slice(i))![1]!;
		i += name.length + 1;
		const attrs: Record<string, Attr> = {};
		for (;;) {
			while (/\s/.test(s[i] ?? '')) i++;
			if (i >= s.length) throw new LayoutError('unterminated tag ' + name);
			const selfClose = /^\/\s*>/.exec(s.slice(i, i + 20));
			if (selfClose) {
				i += selfClose[0].length;
				return { el: { tag: name, attrs, children: [] }, selfClosing: true };
			}
			if (s[i] === '>') {
				i++;
				return { el: { tag: name, attrs, children: [] }, selfClosing: false };
			}
			const key = /^[A-Za-z_][\w:-]*/.exec(s.slice(i))?.[0];
			if (!key) throw new LayoutError('bad attribute in ' + name);
			i += key.length;
			if (s[i] !== '=') {
				attrs[key] = true;
				continue;
			}
			i++;
			const q = s[i];
			if (q === '"' || q === "'") {
				const end = s.indexOf(q, i + 1);
				if (end < 0) throw new LayoutError('unterminated attribute');
				attrs[key] = s.slice(i + 1, end);
				i = end + 1;
			} else if (q === '{') {
				const end = skipGroup(s, i);
				attrs[key] = exprValue(s.slice(i + 1, end - 1));
				i = end;
			} else {
				const bare = /^[^\s/>]+/.exec(s.slice(i))?.[0] ?? '';
				attrs[key] = /^-?\d+(\.\d+)?$/.test(bare) ? Number(bare) : bare;
				i += bare.length;
			}
		}
	};

	const nodes = (closing: string | null): LayoutNode[] => {
		const out: LayoutNode[] = [];
		let text = '';
		const push = (n: LayoutNode) => {
			if (text) out.push(text);
			text = '';
			out.push(n);
		};
		while (i < s.length) {
			const rest = s.slice(i, i + 200);
			if (rest.startsWith('```')) {
				const end = s.indexOf('```', i + 3);
				const stop = end < 0 ? s.length : end + 3;
				text += s.slice(i, stop);
				i = stop;
				continue;
			}
			if (s[i] === '`') {
				const end = s.indexOf('`', i + 1);
				const nl = s.indexOf('\n', i + 1);
				if (end > 0 && (nl < 0 || end < nl)) {
					text += s.slice(i, end + 1);
					i = end + 1;
					continue;
				}
			}
			const end = closing === '#each' ? '{/each}' : '</' + closing + '>';
			if (closing !== null && rest.startsWith(end)) {
				i += end.length;
				if (text) out.push(text);
				return out;
			}
			const tag = /^<([A-Za-z][\w-]*)[\s/>]/.exec(rest)?.[1];
			if (tag && LAYOUT_TAGS.has(tag)) {
				const { el, selfClosing } = readTag();
				if (!selfClosing) {
					if (RAW_TAGS.has(tag)) {
						const end = s.indexOf('</' + tag + '>', i);
						if (end < 0) throw new LayoutError('unclosed ' + tag);
						el.raw = s.slice(i, end);
						i = end + tag.length + 3;
					} else el.children = nodes(tag);
				}
				push(el);
				continue;
			}
			if (rest.startsWith('</') && /^<\/[A-Za-z][\w-]*>/.test(rest) && LAYOUT_TAGS.has(/^<\/([\w-]+)/.exec(rest)![1]!)) {
				throw new LayoutError('unexpected closing tag');
			}
			// Template code: {@body const …} sets up state, {#each … as x} … {/each} repeats.
			// In the answer's own text only at the start of a line, so prose braces stay text.
			const lineStart = closing !== null || /(^|\n)[ \t]*$/.test(s.slice(Math.max(0, i - 200), i));
			if (s[i] === '{' && lineStart && /^\{[@#]/.test(rest)) {
				const close = skipGroup(s, i);
				const inner = s.slice(i + 1, close - 1);
				i = close;
				if (inner.startsWith('#each')) push({ tag: '#each', attrs: { head: { expr: inner } }, children: nodes('#each') });
				continue;
			}
			// Inside layout, {…} is code ChatGPT evaluates on screen (a variable, a loop item).
			if (closing !== null && s[i] === '{') {
				const end = skipGroup(s, i);
				push({ expr: s.slice(i + 1, end - 1) });
				i = end;
				continue;
			}
			text += s[i];
			i++;
		}
		if (closing !== null) throw new LayoutError('unclosed ' + closing);
		if (text) out.push(text);
		return out;
	};

	return nodes(null);
}
