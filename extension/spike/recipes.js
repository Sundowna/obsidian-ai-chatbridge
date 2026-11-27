// Packaged page functions. Chrome serialises each one into the tab (world: MAIN), so every
// function must be self-contained: no outer variables, no shared helpers.
// No code strings, no eval: this works whatever the page's CSP or Trusted Types say.

/**
 * One request from the page, with the browser's own cookies.
 * `sign` adds what the site's own page adds, read inside the page, never returned:
 *   'wiz-at'      Gemini batchexecute: the `at` token in the form body, bl / f.sid in the query.
 *   'sapisidhash' Google APIs (AI Studio): Authorization from SAPISID, X-Goog-Api-Key from the page.
 * Returns {status, headers, body64} or {status: 401} when the page holds no login values.
 */
export async function pageFetch(req) {
	const toB64 = (buf) => {
		const bytes = new Uint8Array(buf);
		let s = '';
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s);
	};
	const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	let url = req.url;
	const headers = { ...(req.headers || {}) };
	let body = req.body64 != null ? fromB64(req.body64) : req.bodyText;

	if (req.sign === 'wiz-at') {
		const w = window.WIZ_global_data || {};
		if (typeof w.SNlM0e !== 'string') return { status: 401, headers: {}, body64: '' };
		const u = new URL(url, location.href);
		u.searchParams.set('bl', w.cfb2h || '');
		u.searchParams.set('f.sid', w.FdrFJe || '');
		url = u.toString();
		const form = new URLSearchParams(typeof body === 'string' ? body : '');
		form.set('at', w.SNlM0e);
		body = form.toString();
	} else if (req.sign === 'sapisidhash') {
		const key = (document.documentElement.innerHTML.match(/"WIu0Nc":"(AIza[\w-]{35})"/) || [])[1];
		const sid = (document.cookie.match(/(?:^|; )SAPISID=([^;]+)/) || [])[1];
		if (!key || !sid) return { status: 401, headers: {}, body64: '' };
		const ts = Math.floor(Date.now() / 1000);
		const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sid + ' ' + location.origin));
		const h = ts + '_' + Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
		headers['X-Goog-Api-Key'] = key;
		headers['Authorization'] = 'SAPISIDHASH ' + h + ' SAPISID1PHASH ' + h + ' SAPISID3PHASH ' + h;
	}

	const r = await fetch(url, {
		method: req.method || 'GET',
		credentials: 'include',
		redirect: req.redirect || 'follow',
		headers,
		body: req.method && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
	});
	return { status: r.status, headers: Object.fromEntries(r.headers), body64: toB64(await r.arrayBuffer()) };
}

/** Named ready checks, the same tests the plugin's login window uses today. */
export function readyCheck(name) {
	switch (name) {
		case 'gemini-signed-in':
			return location.origin === 'https://gemini.google.com' && typeof (window.WIZ_global_data || {}).SNlM0e === 'string';
		case 'studio-ready':
			return location.origin === 'https://aistudio.google.com'
				&& /(?:^|; )SAPISID=/.test(document.cookie)
				&& /"WIu0Nc":"AIza[\w-]{35}"/.test(document.documentElement.innerHTML);
		case 'loaded':
			return document.readyState === 'complete';
		default:
			return false;
	}
}

/** Spike only: which cookie names the page can see. Names, never values. */
export function cookieNames() {
	return document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
}
