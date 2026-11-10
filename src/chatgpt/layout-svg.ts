// ChatGPT draws some diagrams as SVG written in JSX style (strokeWidth={2}, fillOpacity=".14").
// A static drawing becomes plain inline SVG that Obsidian shows; one built by code on
// screen ({#each …}, x={n.x}) cannot be drawn without running it and returns null.

import type { LayoutElement } from './layout-parse';
import { expandRaw, type Scope } from './layout-eval';

/** SVG attributes that are camelCase in SVG itself; every other camelCase name is kebab-case. */
const KEEP = new Set(['viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform', 'patternUnits',
	'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerWidth',
	'markerHeight', 'markerUnits', 'refX', 'refY', 'textLength', 'lengthAdjust', 'stdDeviation', 'numOctaves',
	'baseFrequency', 'spreadMethod', 'startOffset', 'pathLength']);
const ALLOWED = /^(svg|g|defs|rect|circle|ellipse|line|polyline|polygon|path|text|tspan|title|desc|linearGradient|radialGradient|stop|clipPath|mask|pattern|marker|use|symbol)$/;

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function attrName(name: string): string {
	return KEEP.has(name) ? name : name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function attrs(source: string): string | null {
	let out = '';
	const re = /\s*([A-Za-z_][\w:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|\{[^{}]*\}))?/gy;
	let m: RegExpExecArray | null;
	let pos = 0;
	while ((m = re.exec(source)) && m[0]) {
		pos = re.lastIndex;
		const [, name, raw] = m;
		if (/^on/i.test(name!) || name === 'key' || name === 'style') continue;
		let value = raw === undefined ? '' : raw.slice(1, -1);
		if (raw?.startsWith('{')) {
			const v = value.trim();
			if (/^-?\d+(\.\d+)?$/.test(v)) value = v;
			else if (/^"[^"]*"$|^'[^']*'$/.test(v)) value = v.slice(1, -1);
			else return null;
		}
		// Links only to parts of the same drawing (<use href="#a"/>): nothing loads from elsewhere when the note opens.
		// (xlink:href and JSX's xlinkHref become the plain href SVG 2 reads.)
		if (/href$/i.test(name!)) {
			if (!value.trim().startsWith('#')) continue;
			out += ` href="${escapeAttr(value)}"`;
			continue;
		}
		out += ` ${attrName(name!)}="${escapeAttr(value)}"`;
	}
	return source.slice(pos).trim() ? null : out;
}

export function renderSvg(el: LayoutElement, scope: Scope = {}): string | null {
	const raw = expandRaw(el.raw ?? '', scope);
	if (raw === null) return null;
	if (/\{/.test(raw.replace(/<[^>]*>/g, ''))) return null; // code between the tags
	let body = '';
	let last = 0;
	for (const m of raw.matchAll(/<(\/?)([A-Za-z][\w-]*)([^<>]*?)(\/?)>/g)) {
		body += raw.slice(last, m.index).replace(/&(?![a-z#\d]+;)/gi, '&amp;');
		last = m.index + m[0].length;
		const [, close, tag, rest, self] = m;
		if (!ALLOWED.test(tag!)) return null;
		if (close) body += `</${tag}>`;
		else {
			const a = attrs(rest!);
			if (a === null) return null;
			body += `<${tag}${a}${self ? '/' : ''}>`;
		}
	}
	body += raw.slice(last);
	const own = Object.entries(el.attrs).map(([k, v]) => typeof v === 'string' || typeof v === 'number' ? ` ${attrName(k)}="${escapeAttr(String(v))}"` : '').join('');
	// One line: a blank line would end the HTML block in Markdown.
	const svg = `<svg xmlns="http://www.w3.org/2000/svg"${own.replace(/ xmlns="[^"]*"/, '')}>${body}</svg>`;
	return svg.replace(/\s*\n\s*/g, ' ');
}
