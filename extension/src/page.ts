// Functions the extension runs inside a tab of the site (world: MAIN), as packaged code: Chrome
// copies each function into the page, so each must be self-contained (no outer variables, no
// shared helpers). No code strings, no eval: this works whatever the page's CSP says.
// They read login values inside the page and never hand them out. They run in a web page, not
// in Obsidian, so they use the page's own window.fetch (Obsidian's requestUrl does not exist here).

/** One request from the page, with the browser's own cookies. Body in and out as base64. */
export async function pageFetch(req: { url: string; method: string; headers: Record<string, string>; body64?: string; redirect?: 'follow' | 'manual' }): Promise<{ status: number; headers: Record<string, string>; body64: string }> {
	const toB64 = (buf: ArrayBuffer): string => {
		const bytes = new Uint8Array(buf);
		let s = '';
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(s);
	};
	const body = req.body64 === undefined ? undefined : Uint8Array.from(atob(req.body64), (c) => c.charCodeAt(0));
	const r = await window.fetch(req.url, {
		method: req.method,
		credentials: 'include',
		redirect: req.redirect ?? 'follow',
		headers: req.headers,
		body: req.method === 'GET' ? undefined : body,
	});
	const headers: Record<string, string> = {};
	r.headers.forEach((v, k) => { headers[k] = v; });
	return { status: r.status, headers, body64: toB64(await r.arrayBuffer()) };
}

/**
 * One signed call, signed the way the site's own page signs it:
 *   'wiz-at'      Gemini batchexecute: `at` in the form body, `bl` / `f.sid` in the query.
 *   'sapisidhash' Google APIs (AI Studio): Authorization from SAPISID, X-Goog-Api-Key from the page.
 * Answers {status: 401} when the page holds no login values.
 */
export async function pageCall(c: { url: string; method: string; headers: Record<string, string>; body: string; sign: string }): Promise<{ status: number; text: string; headers: Record<string, string> }> {
	const collect = (h: Headers): Record<string, string> => {
		const out: Record<string, string> = {};
		h.forEach((v, k) => { out[k] = v; });
		return out;
	};
	if (c.sign === 'wiz-at') {
		const w = ((window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data) ?? {};
		if (typeof w.SNlM0e !== 'string') return { status: 401, text: '', headers: {} };
		const u = new URL(c.url, location.href);
		u.searchParams.set('bl', typeof w.cfb2h === 'string' ? w.cfb2h : '');
		u.searchParams.set('f.sid', typeof w.FdrFJe === 'string' ? w.FdrFJe : '');
		const body = new URLSearchParams(c.body);
		body.set('at', w.SNlM0e);
		const r = await window.fetch(u.toString(), { method: c.method, credentials: 'same-origin', headers: c.headers, body });
		return { status: r.status, text: await r.text(), headers: collect(r.headers) };
	}
	if (c.sign === 'sapisidhash') {
		const key = (/"WIu0Nc":"(AIza[\w-]{35})"/.exec(document.documentElement.innerHTML) ?? [])[1];
		const sid = (/(?:^|; )SAPISID=([^;]+)/.exec(document.cookie) ?? [])[1];
		if (!key || !sid) return { status: 401, text: '', headers: {} };
		const ts = Math.floor(Date.now() / 1000);
		const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sid} ${location.origin}`));
		const h = `${ts}_${Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')}`;
		const headers = { ...c.headers, 'X-Goog-Api-Key': key, Authorization: `SAPISIDHASH ${h} SAPISID1PHASH ${h} SAPISID3PHASH ${h}` };
		const r = await window.fetch(c.url, { method: c.method, credentials: 'include', headers, body: c.body });
		return { status: r.status, text: await r.text(), headers: collect(r.headers) };
	}
	return { status: 400, text: '', headers: {} };
}

/** Named page values (not secret): the same values the plugin's login window reads. */
export function pageRead(name: string): string {
	const w = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data ?? {};
	switch (name) {
		case 'google-account-id':
			return typeof w.S06Grb === 'string' ? w.S06Grb : '';
		case 'claude-org':
		case 'chatgpt-device-id':
		case 'chatgpt-workspace': {
			const cookie = { 'claude-org': 'lastActiveOrg', 'chatgpt-device-id': 'oai-did', 'chatgpt-workspace': '_account' }[name];
			const m = new RegExp(`(?:^|; )${cookie}=([^;]*)`).exec(document.cookie);
			return m ? decodeURIComponent(m[1] ?? '') : '';
		}
		default:
			return '';
	}
}

/** Named ready checks: the same tests the plugin's login window uses. */
export function readyCheck(name: string): boolean {
	const w = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data ?? {};
	switch (name) {
		case 'gemini-signed-in':
			return location.origin === 'https://gemini.google.com' && typeof w.SNlM0e === 'string';
		case 'studio-ready':
			return location.origin === 'https://aistudio.google.com' && /(?:^|; )SAPISID=/.test(document.cookie) && /"WIu0Nc":"AIza[\w-]{35}"/.test(document.documentElement.innerHTML);
		case 'loaded':
			return document.readyState === 'complete';
		default:
			return false;
	}
}
