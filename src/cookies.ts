// Reading a pasted Cookie header (copied from DevTools) for the session fallbacks.
// Pure code, testable offline. Never log the input or the result.

import type { App } from 'obsidian';

/** The pasted session from Obsidian's secret storage, or null if none is set. */
export function pastedSession(app: App, secretId: string): string | null {
	return secretId ? app.secretStorage.getSecret(secretId) || null : null;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const VALUE = /^[^\s;,"\\]*$/;

/**
 * The name=value pairs of a "name=value; …" Cookie header, with or without a leading
 * "Cookie:". Null if any part is malformed or the text spans lines (so nothing pasted can
 * add a header of its own).
 */
export function cookiePairs(pasted: string): [string, string][] | null {
	const text = pasted.trim().replace(/^cookie:\s*/i, '');
	if (!text || /[\r\n]/.test(text)) return null;
	const pairs: [string, string][] = [];
	for (const part of text.split(';')) {
		const p = part.trim();
		if (!p) continue;
		const eq = p.indexOf('=');
		const name = p.slice(0, eq);
		const value = p.slice(eq + 1);
		if (eq <= 0 || !NAME.test(name) || !VALUE.test(value)) return null;
		pairs.push([name, value]);
	}
	return pairs.length ? pairs : null;
}

/** The pairs back as one Cookie header. */
export function cookieText(pairs: readonly [string, string][]): string {
	return pairs.map(([n, v]) => `${n}=${v}`).join('; ');
}

/**
 * A pasted Google login: the whole Cookie header of a gemini.google.com request. Needs the
 * session cookie Gemini checks (__Secure-1PSID) and the one AI Studio signs with (SAPISID).
 */
export function googleCookies(pasted: string): [string, string][] | null {
	const pairs = cookiePairs(pasted);
	if (!pairs) return null;
	const has = (n: string) => pairs.some(([name, v]) => name === n && v !== '');
	return has('__Secure-1PSID') && has('SAPISID') ? pairs : null;
}
