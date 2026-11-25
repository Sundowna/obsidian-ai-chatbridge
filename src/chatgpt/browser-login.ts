// "Use browser login": for ChatGPT accounts made with Google. Google refuses its sign-in in
// windows inside apps (issue #52), so you sign in in your own browser and paste the session
// cookie here. It is checked with one GET before it is kept, then saved in Obsidian's secret
// storage like the other pasted logins. Pure code, testable offline. Never log the input.

import { fallbackCookie } from './token';
import { readGpt, type Answer } from '../mobile/probe';

export type BrowserLoginOutcome =
	| { kind: 'empty'; message: string }
	| { kind: 'malformed'; message: string }
	| { kind: 'works'; message: string }
	| { kind: 'refused'; message: string }
	| { kind: 'unclear'; message: string };

export const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';

/**
 * Checks the pasted text, then asks chatgpt.com once (`probe`, given the Cookie header).
 * Only "works" may be saved: the caller keeps the pasted text, not the probe's answer.
 */
export async function checkBrowserLogin(pasted: string, probe: (cookie: string) => Promise<Answer>): Promise<BrowserLoginOutcome> {
	if (!pasted.trim()) return { kind: 'empty', message: 'Paste the cookie value first.' };
	const cookie = fallbackCookie(pasted);
	if (!cookie) {
		return {
			kind: 'malformed',
			message: `That is not a ChatGPT session cookie. Copy the Value column of the row ${SESSION_COOKIE_NAME} (or of its .0 row, which starts with "eyJ"), and of the .1 row if there is one.`,
		};
	}
	let answer: Answer;
	try {
		answer = await probe(cookie);
	} catch (e) {
		return { kind: 'unclear', message: `chatgpt.com could not be reached (${e instanceof Error ? e.message : 'network error'}). Check the connection and try again. Nothing was saved.` };
	}
	const r = readGpt('', answer);
	if (r.challenge) return { kind: 'unclear', message: 'chatgpt.com showed a Cloudflare check instead of answering. Wait a minute and try again. Nothing was saved.' };
	if (r.login === 'accepted') return { kind: 'works', message: 'It works. Saved for this account.' };
	if (r.login === 'refused') {
		const half = !cookie.includes(`${SESSION_COOKIE_NAME}.1=`);
		return {
			kind: 'refused',
			message: half
				? 'ChatGPT did not accept this. If your browser shows two rows ending in .0 and .1, paste the .1 value in the second box too. Otherwise the login has expired: sign in at chatgpt.com again and copy it again. Nothing was saved.'
				: 'ChatGPT did not accept this cookie: it has expired, or the two values come from different moments. Reload chatgpt.com in your browser, then copy both values again. Nothing was saved.',
		};
	}
	return { kind: 'unclear', message: `chatgpt.com answered unexpectedly (status ${answer.status}). Try again in a minute. Nothing was saved.` };
}

/**
 * What to check and keep, from the two boxes: the value of the only row (or of ".0"), and the
 * value of ".1" when ChatGPT splits the cookie in two (it does for most logins, seen 2026-11-25).
 */
export function browserLoginText(first: string, second: string): string {
	const a = first.trim();
	const b = second.trim();
	if (!b) return a;
	if (!a) return '';
	return `${SESSION_COOKIE_NAME}.0=${a}; ${SESSION_COOKIE_NAME}.1=${b}`;
}

/** The secret's ID for an account: the one it already names, or a new one (lower case, digits and dashes only). */
export function browserLoginSecretId(existing: string, accountId: string): string {
	if (existing) return existing;
	const id = accountId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	return `ai-chatbridge-chatgpt-${id || 'default'}`;
}
