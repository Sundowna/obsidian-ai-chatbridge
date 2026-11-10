// Sources behind ChatGPT's citation chips ("Nous Research +2", seen 2026-11-10).
// A chip names search results by ref (e.g. "turn704970search0"); the message metadata
// resolves them in model_dil_v2.appData.opGenui.componentResults and genui_components.

export interface CiteSource {
	url: string;
	label: string;
}

export type CiteSources = Map<string, CiteSource>;

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/[^<>\s]+$/i.test(v);
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0]!;

export function citeSources(metadata: unknown): CiteSources {
	const out: CiteSources = new Map();
	const md = rec(metadata);
	const results = rec(rec(rec(rec(md.model_dil_v2).appData).opGenui).componentResults);
	for (const result of Object.values(results)) {
		for (const item of list(rec(rec(result).state).items)) {
			const it = rec(item);
			const ref = str(it.ref_id);
			if (ref && isUrl(it.url)) out.set(ref, { url: it.url, label: str(it.source_label) ?? str(it.title) ?? host(it.url) });
		}
	}
	for (const component of list(md.genui_components)) {
		const c = rec(component);
		const urls = list(c.safe_urls).map((u) => isUrl(u) ? u : isUrl(rec(u).url) ? rec(u).url as string : null);
		const entities = list(c.entities);
		if (urls.length !== entities.length) continue;
		entities.forEach((e, k) => {
			const ref = str(rec(e).ref);
			const url = urls[k];
			if (ref && url && !out.has(ref)) out.set(ref, { url, label: host(url) });
		});
	}
	return out;
}

/** "[Nous Research](<url>), [Hermes Agent](<url>)", or "[Unresolved source]" when none is known. */
export function formatCites(refs: string[], sources: CiteSources): string {
	const seen = new Set<string>();
	const links: string[] = [];
	for (const ref of refs) {
		const s = sources.get(ref);
		if (!s || seen.has(s.url)) continue;
		seen.add(s.url);
		links.push('[' + s.label.replace(/[[\]]/g, '') + '](<' + s.url + '>)');
	}
	return links.length ? links.join(', ') : refs.length ? '[Unresolved source]' : '';
}
