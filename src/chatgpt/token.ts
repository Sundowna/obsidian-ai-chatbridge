// The chatgpt.com page carries the key its own requests send as "Authorization: Bearer …"
// (found 2026-11-06 with DevTools search: "accessToken" is in the HTML of chatgpt.com pages).
// Pure functions, testable offline. The key is never stored or logged.

import { cookiePairs, cookieText } from '../cookies';

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** Decode identifiers for cache partitioning only. Requests still authenticate on the server. */
export function inventoryIdentity(token: string, selectedWorkspace: string | null): [string, string] | null {
	try {
		const payload = token.split('.')[1];
		if (!payload) return null;
		const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
		const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
		const user = claims.sub ?? auth?.chatgpt_user_id ?? auth?.user_id;
		const workspace = selectedWorkspace || auth?.chatgpt_account_id;
		return typeof user === 'string' && user !== '' && typeof workspace === 'string' && workspace !== ''
			? [user, workspace] : null;
	} catch {
		return null;
	}
}

/**
 * The key: first the key-shaped value right after an "accessToken" label; if the page
 * stores the value elsewhere (e.g. referenced by position), the only key-shaped value
 * in the page. Null if neither.
 */
export function findAccessToken(html: string): string | null {
	let i = html.indexOf('accessToken');
	while (i >= 0) {
		const m = html.slice(i, i + 400).match(JWT);
		if (m?.[0]) return m[0];
		i = html.indexOf('accessToken', i + 11);
	}
	const all = [...new Set(html.match(JWT) ?? [])];
	return all.length === 1 ? all[0]! : null;
}

const SESSION_COOKIE = '__Secure-next-auth.session-token';
const COOKIE_VALUE = /^[A-Za-z0-9_.\-~+/=%]{20,}$/;

/**
 * The Cookie header for a pasted login, or null if it does not look like one. Accepts the
 * bare value of "__Secure-next-auth.session-token", or a whole "name=value; …" Cookie
 * header copied from DevTools (with or without "Cookie:"), which also covers the split
 * ".0"/".1" form. Never log the input or the result.
 */
export function fallbackCookie(pasted: string): string | null {
	const text = pasted.trim().replace(/^cookie:\s*/i, '');
	if (!text || /[\r\n]/.test(text)) return null;
	if (!text.includes(SESSION_COOKIE)) return COOKIE_VALUE.test(text) ? `${SESSION_COOKIE}=${text}` : null;
	const pairs = cookiePairs(text);
	const session = pairs?.some(([n, v]) => (n === SESSION_COOKIE || n.startsWith(`${SESSION_COOKIE}.`)) && v !== '');
	return pairs && session ? cookieText(pairs) : null;
}

/** Masks every key-shaped or long random-looking value. */
export function maskSecrets(text: string): string {
	return text.replace(JWT, '[key]').replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[hidden]');
}

/** What the page looked like, with all secrets masked – for the stop message when no key was found. */
export function describePage(html: string): string {
	const count = (s: string) => html.split(s).length - 1;
	const keys = new Set(html.match(JWT) ?? []).size;
	const title = /<title[^>]*>([^<]{0,80})/i.exec(html)?.[1]?.trim() ?? '';
	const i = html.indexOf('accessToken');
	const around = i >= 0 ? maskSecrets(html.slice(Math.max(0, i - 40), i + 120)).replace(/\s+/g, ' ') : '';
	return `page ${html.length} chars, title "${maskSecrets(title)}", "accessToken" ${count('accessToken')}×, key-shaped values ${keys}×${around ? `, around it: ${around}` : ''}`;
}
