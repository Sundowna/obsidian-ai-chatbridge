// Helpers shared by the Markdown and HTML renderers of ChatGPT layout answers.

import type { CiteSources } from './cites';
import { eachHead, evalExpr, type Scope } from './layout-eval';
import type { Attr, LayoutElement, LayoutNode } from './layout-parse';

export interface Ctx {
	cites: CiteSources;
	/** Names of places, people … by ref, from the markers in ChatGPT's flat version. */
	names: Map<string, string>;
	/** Loop items in reach ({#each … as a} makes a). */
	scope: Scope;
}

/** Text stand-ins for ChatGPT's (Lucide) icons, shown where Obsidian has no such icon. */
export const ICONS: Record<string, string> = {
	'arrow-up-down': '⇅', 'arrow-down-up': '⇅', 'arrow-down': '↓', 'arrow-up': '↑', 'arrow-right': '→', 'arrow-left': '←',
	'arrow-left-right': '⇄', 'arrow-right-left': '⇄', 'chevron-right': '›', 'chevron-left': '‹', 'chevron-down': '⌄', 'chevron-up': '⌃',
	plus: '+', minus: '−', equals: '=', check: '✓', 'check-circle': '✓', 'circle-check': '✓', x: '✗', 'x-circle': '✗', 'circle-x': '✗',
	'alert-triangle': '⚠', 'triangle-alert': '⚠', warning: '⚠', 'alert-circle': '⚠', info: 'ℹ', star: '★', clock: '🕒', calendar: '📅',
	'map-pin': '📍', mail: '✉', phone: '☎', link: '🔗', lock: '🔒', 'external-link': '↗', lightbulb: '💡', search: '🔍',
};

export const str = (a: Attr | undefined): string | null => typeof a === 'string' ? a : typeof a === 'number' ? String(a) : null;
export const strings = (a: Attr | undefined): string[] => Array.isArray(a) ? a.filter((v): v is string => typeof v === 'string') : typeof a === 'string' ? [a] : [];
export const cellText = (v: unknown): string => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
export const isElement = (n: LayoutNode): n is LayoutElement => typeof n === 'object' && 'tag' in n;

/** Remove the indentation the markup adds, keeping relative indentation (nested lists). Lines holding only a marker char are ignored. */
export function dedent(text: string, marker = '\u0001'): string {
	const lines = text.split('\n');
	const indents = lines.filter((l) => l.trim() && !l.trim().startsWith(marker)).map((l) => /^[ \t]*/.exec(l)![0].length);
	const cut = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.trim().startsWith(marker) ? l.trim() : l.trim() ? l.slice(cut).trimEnd() : '').join('\n');
}

/** A {…} child: data and simple expressions are shown; anything computed on screen shows "…". */
export function literal(expr: string, scope: Scope): string {
	const t = expr.trim();
	const v = evalExpr(t, scope);
	if (typeof v === 'string' || typeof v === 'number') return String(v);
	if (/^`[^`]*`$/.test(t) && !t.includes('${')) return t.slice(1, -1);
	if (/^"[^"\\]*"$|^'[^'\\]*'$/.test(t)) return t.slice(1, -1);
	return '…';
}

/** The source of a {…} attribute that is code rather than data, else null. */
export function exprOf(a: Attr | undefined): string | null {
	const e = a !== null && typeof a === 'object' && !Array.isArray(a) ? (a as { expr?: unknown }).expr : undefined;
	return typeof e === 'string' ? e : null;
}

/** One result per loop item; a loop over data only known on screen gives null. */
export function repeat<T>(el: LayoutElement, ctx: Ctx, render: (c: Ctx) => T): T[] | null {
	const head = eachHead(exprOf(el.attrs.head) ?? '', ctx.scope);
	if (!head) return null;
	return head.list.map((item, k) => render({ ...ctx, scope: { ...ctx.scope, [head.name]: item, ...(head.index ? { [head.index]: k } : {}) } }));
}

/** Attributes such as value={a.name} filled from the loop item. */
export function resolve(attrs: Record<string, Attr>, scope: Scope): Record<string, Attr> {
	const out: Record<string, Attr> = {};
	for (const [k, v] of Object.entries(attrs)) {
		const expr = exprOf(v);
		const got = expr === null ? undefined : evalExpr(expr, scope);
		out[k] = typeof got === 'string' || typeof got === 'number' ? got : v;
	}
	return out;
}
