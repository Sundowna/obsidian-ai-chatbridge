// Markdown inside ChatGPT layout cards (**bold**, lists, links …) as HTML, because Obsidian
// does not read Markdown inside an HTML block. Small on purpose: the text in cards is short.
// Tokens \u0002n\u0002 (inline) and lines \u0001n\u0001 (block) stand for already rendered HTML.

export const INLINE = '\u0002';
export const BLOCK = '\u0001';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeUrl = (u: string) => /^https?:\/\//i.test(u) ? esc(u) : null;

/** Inline Markdown → HTML. `html` holds the rendered pieces the tokens point to. */
export function inlineHtml(text: string, html: string[]): string {
	const code: string[] = [];
	let s = text.replace(/`([^`\n]+)`/g, (_m, c: string) => {
		code.push('<code>' + esc(c) + '</code>');
		return '' + (code.length - 1) + '';
	});
	const links: string[] = [];
	s = s.replace(/\[([^\]\n]+)\]\(<?(https?:\/\/[^)\s>]+)>?\)/g, (m, label: string, url: string) => {
		const u = safeUrl(url);
		if (!u) return m;
		links.push(`<a href="${u}">${esc(label)}</a>`);
		return '' + (links.length - 1) + '';
	});
	s = esc(s)
		.replace(/\\([\\`*_[\]().!#|-])/g, '$1')
		.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
		.replace(/__([^_]+?)__/g, '<strong>$1</strong>')
		.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
		.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
	return s
		.replace(/(\d+)/g, (_m, k: string) => code[Number(k)]!)
		.replace(/(\d+)/g, (_m, k: string) => links[Number(k)]!)
		.replace(new RegExp(INLINE + '(\\d+)' + INLINE, 'g'), (_m, k: string) => html[Number(k)]!);
}

/** Block Markdown (paragraphs, lists, headings, code fences) → HTML without blank lines. */
export function blockHtml(text: string, html: string[]): string {
	const out: string[] = [];
	let para: string[] = [];
	let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
	const flushPara = () => {
		if (para.length) out.push('<div class="ccs-gpt-p">' + para.map((l) => inlineHtml(l, html)).join('<br>') + '</div>');
		para = [];
	};
	const flushList = () => {
		if (list) out.push(`<${list.tag}>` + list.items.map((i) => '<li>' + inlineHtml(i, html) + '</li>').join('') + `</${list.tag}>`);
		list = null;
	};
	const lines = text.split('\n');
	for (let k = 0; k < lines.length; k++) {
		const line = lines[k]!.trim();
		const blockToken = new RegExp('^' + BLOCK + '(\\d+)' + BLOCK + '$').exec(line);
		const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (!line) {
			flushPara();
			flushList();
		} else if (blockToken) {
			flushPara();
			flushList();
			out.push(html[Number(blockToken[1])]!);
		} else if (line.startsWith('```')) {
			flushPara();
			flushList();
			const body: string[] = [];
			while (++k < lines.length && !lines[k]!.trim().startsWith('```')) body.push(lines[k]!);
			out.push('<pre><code>' + body.map(esc).join('&#10;') + '</code></pre>');
		} else if (/^#{1,6}\s/.test(line)) {
			flushPara();
			flushList();
			out.push('<div class="ccs-gpt-heading">' + inlineHtml(line.replace(/^#+\s+/, ''), html) + '</div>');
		} else if (item) {
			flushPara();
			const tag = /\d/.test(item[1]!) ? 'ol' : 'ul';
			if (list && list.tag !== tag) flushList();
			list ??= { tag, items: [] };
			list.items.push(item[2]!);
		} else if (list && /^\s{2,}\S/.test(lines[k]!)) {
			list.items[list.items.length - 1] += INLINE + (html.push('<br>') - 1) + INLINE + line;
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return out.join('\n');
}
