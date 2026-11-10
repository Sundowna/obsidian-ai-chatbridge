// ChatGPT builds some layouts with small templates: {#each [{name:"A"},{name:"B"}] as a} … {a.name} … {/each}.
// This reads the literal data and simple expressions (a.name, n.x+n.w/2) without running
// any code. Anything else (state, function calls) gives undefined and stays unshown.

export type Scope = Record<string, unknown>;

/** A JS array/object/number/string literal as data (unquoted keys, 'single quotes', .5 allowed). */
export function parseLiteral(src: string): unknown {
	let json = '';
	let i = 0;
	let last = '';
	while (i < src.length) {
		const ch = src[i]!;
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			let s = '';
			while (j < src.length && src[j] !== ch) {
				if (src[j] === '\\') {
					s += src[j + 1] ?? '';
					j += 2;
				} else s += src[j++];
			}
			if (j >= src.length) return undefined;
			json += JSON.stringify(s);
			i = j + 1;
			last = '"';
			continue;
		}
		const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
		if (ident) {
			const after = src.slice(i + ident[0].length).trimStart();
			if (after.startsWith(':') && (last === '{' || last === ',')) json += JSON.stringify(ident[0]);
			else if (/^(true|false|null)$/.test(ident[0])) json += ident[0];
			else return undefined;
			i += ident[0].length;
			last = 'a';
			continue;
		}
		const num = /^\.\d+/.exec(src.slice(i));
		if (num && !/[\d.]/.test(last)) {
			json += '0' + num[0];
			i += num[0].length;
			last = '0';
			continue;
		}
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if ((ch === '}' || ch === ']') && last === ',') json = json.replace(/,$/, '');
		json += ch;
		last = ch;
		i++;
	}
	try {
		return JSON.parse(json) as unknown;
	} catch {
		return undefined;
	}
}

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'path'; v: string[] } | { k: 'op'; v: string };

function tokens(src: string): Tok[] | null {
	const out: Tok[] = [];
	const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|"([^"\\]*)"|'([^'\\]*)'|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)|([-+*/()]))/y;
	let m: RegExpExecArray | null;
	while (re.lastIndex < src.length) {
		if (!src.slice(re.lastIndex).trim()) break;
		const at = re.lastIndex;
		m = re.exec(src);
		if (!m || re.lastIndex === at) return null;
		if (m[1] !== undefined) out.push({ k: 'num', v: Number(m[1]) });
		else if (m[2] !== undefined || m[3] !== undefined) out.push({ k: 'str', v: m[2] ?? m[3]! });
		else if (m[4] !== undefined) out.push({ k: 'path', v: m[4].replace(/\[(\d+)\]/g, '.$1').split('.') });
		else out.push({ k: 'op', v: m[5]! });
	}
	return out;
}

/** Value of a simple expression in this scope, or undefined. */
export function evalExpr(src: string, scope: Scope): unknown {
	// A template string: `M ${n.x+n.w/2} 54`
	const tpl = /^`([^`]*)`$/.exec(src.trim());
	if (tpl) {
		let ok = true;
		const out = tpl[1]!.replace(/\$\{([^{}]*)\}/g, (_m, e: string) => {
			const v = evalExpr(e, scope);
			if (typeof v !== 'string' && typeof v !== 'number') ok = false;
			return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
		});
		return ok ? out : undefined;
	}
	const toks = tokens(src);
	if (!toks?.length) return undefined;
	let i = 0;
	const fail = Symbol('fail');
	const atom = (): unknown => {
		const t = toks[i++];
		if (!t) return fail;
		if (t.k === 'num' || t.k === 'str') return t.v;
		if (t.k === 'path') {
			let v: unknown = scope;
			for (const key of t.v) {
				if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, key)) return fail;
				v = (v as Record<string, unknown>)[key];
			}
			return v;
		}
		if (t.v === '(') {
			const v = sum();
			return toks[i++]?.v === ')' ? v : fail;
		}
		if (t.v === '-') {
			const v = atom();
			return typeof v === 'number' ? -v : fail;
		}
		return fail;
	};
	const product = (): unknown => {
		let v = atom();
		while (toks[i]?.k === 'op' && (toks[i]!.v === '*' || toks[i]!.v === '/')) {
			const op = toks[i++]!.v;
			const r = atom();
			if (typeof v !== 'number' || typeof r !== 'number') return fail;
			v = op === '*' ? v * r : v / r;
		}
		return v;
	};
	const sum = (): unknown => {
		let v = product();
		while (toks[i]?.k === 'op' && (toks[i]!.v === '+' || toks[i]!.v === '-')) {
			const op = toks[i++]!.v;
			const r = product();
			if (v === fail || r === fail) return fail;
			if (op === '+' && (typeof v === 'string' || typeof r === 'string')) v = String(v) + String(r);
			else if (typeof v === 'number' && typeof r === 'number') v = op === '+' ? v + r : v - r;
			else return fail;
		}
		return v;
	};
	const v = sum();
	return v === fail || i !== toks.length ? undefined : v;
}

/** {#each LIST as name} or {#each LIST as name, i} → the items and names, or null. */
export function eachHead(head: string, scope: Scope): { list: unknown[]; name: string; index?: string } | null {
	const m = /^#each\s+([^]*)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*$/.exec(head.trim());
	if (!m) return null;
	const list = /^[[]/.test(m[1]!.trim()) ? parseLiteral(m[1]!) : evalExpr(m[1]!, scope);
	return Array.isArray(list) ? { list, name: m[2]!, index: m[3] } : null;
}

/** Expand {#each}…{/each} and fill {expr} in raw markup (SVG). Null when something stays unknown. */
export function expandRaw(raw: string, scope: Scope): string | null {
	let out = '';
	let i = 0;
	while (i < raw.length) {
		const open = raw.indexOf('{', i);
		if (open < 0) break;
		out += raw.slice(i, open);
		const close = matchBrace(raw, open);
		if (close < 0) return null;
		const inner = raw.slice(open + 1, close);
		if (inner.startsWith('#each')) {
			const end = findEnd(raw, close + 1);
			if (end < 0) return null;
			const head = eachHead(inner, scope);
			if (!head) return null;
			const body = raw.slice(close + 1, end);
			for (const [k, item] of head.list.entries()) {
				const piece = expandRaw(body, { ...scope, [head.name]: item, ...(head.index ? { [head.index]: k } : {}) });
				if (piece === null) return null;
				out += piece;
			}
			i = end + '{/each}'.length;
			continue;
		}
		const v = evalExpr(inner, scope);
		if (typeof v !== 'string' && typeof v !== 'number') return null;
		// In an attribute (x={n.x}) keep the braces so the SVG reader sees a literal.
		out += /=\s*$/.test(out) ? '{' + JSON.stringify(v) + '}' : String(v);
		i = close + 1;
	}
	return out + raw.slice(i);
}

export function matchBrace(s: string, open: number): number {
	let depth = 0;
	for (let j = open; j < s.length; j++) {
		const ch = s[j]!;
		if (ch === '"' || ch === "'" || ch === '`') {
			const end = s.indexOf(ch, j + 1);
			if (end < 0) return -1;
			j = end;
		} else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return j;
	}
	return -1;
}

/** Index of the {/each} that closes an {#each} whose body starts at `from`. */
export function findEnd(s: string, from: number): number {
	let depth = 1;
	const re = /\{(#each\b|\/each\})/g;
	re.lastIndex = from;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		if (m[1] === '/each}') {
			if (--depth === 0) return m.index;
		} else depth++;
	}
	return -1;
}
