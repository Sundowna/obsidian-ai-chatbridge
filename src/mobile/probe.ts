// Reading the two answers of "Test mobile connection": was it the site, or a Cloudflare
// check page in front of it, and did the site accept the login?
// Pure code, testable offline. Nothing here keeps or prints an answer's text: only its
// status, its type, and facts about it (how many organizations, whether a key came back).

import { maskSecrets } from '../chatgpt/token';

export interface Answer {
	status: number;
	headers: Record<string, string>;
	text: string;
}

/** What one request showed. Safe to show and to log. */
export interface ProbeResult {
	site: 'claude.ai' | 'chatgpt.com';
	/** The address asked, without anything secret. */
	url: string;
	account: string;
	/** HTTP status, or null when the request never got an answer or was not sent. */
	status: number | null;
	contentType: string;
	/** A Cloudflare check page came back instead of the site's own answer. */
	challenge: boolean;
	login: 'accepted' | 'refused' | 'unclear' | 'not tested';
	detail: string;
}

export function headerOf(headers: Record<string, string>, name: string): string {
	const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
	return k ? (headers[k] ?? '') : '';
}

const CHALLENGE_MARKS = /Just a moment\.\.\.|challenge-platform|_cf_chl_opt|cf-chl-|cf-browser-verification|Attention Required! \| Cloudflare|Enable JavaScript and cookies to continue/i;

/**
 * Cloudflare says so itself in the "cf-mitigated: challenge" header. Older check pages do
 * not send it, so an HTML page carrying the check's own markers counts too.
 */
export function isChallenge(a: Answer): boolean {
	if (/challenge/i.test(headerOf(a.headers, 'cf-mitigated'))) return true;
	return /text\/html/i.test(headerOf(a.headers, 'content-type')) && CHALLENGE_MARKS.test(a.text);
}

/** The page title of an HTML answer, with anything key-shaped masked. */
export function pageTitle(text: string): string {
	const t = /<title[^>]*>([^<]{0,80})/i.exec(text)?.[1]?.trim() ?? '';
	return maskSecrets(t);
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function base(site: ProbeResult['site'], url: string, account: string, a: Answer): ProbeResult {
	const challenge = isChallenge(a);
	const title = /text\/html/i.test(headerOf(a.headers, 'content-type')) ? pageTitle(a.text) : '';
	return {
		site, url, account,
		status: a.status,
		contentType: headerOf(a.headers, 'content-type') || 'none',
		challenge,
		login: 'unclear',
		detail: challenge ? 'A Cloudflare check page came back, not the site.' : title ? `An HTML page came back, titled "${title}".` : '',
	};
}

/** claude.ai/api/organizations: a logged-in session gets a JSON list of its organizations. */
export function readClaude(account: string, a: Answer): ProbeResult {
	const r = base('claude.ai', 'https://claude.ai/api/organizations', account, a);
	if (r.challenge) return r;
	const json = parse(a.text);
	if (a.status === 200 && Array.isArray(json)) {
		return { ...r, login: 'accepted', detail: `${json.length} ${json.length === 1 ? 'organization' : 'organizations'} listed.` };
	}
	if (a.status === 401 || a.status === 403) {
		// claude.ai's own refusals are JSON with an error type; the type is not secret.
		const type = (json as { error?: { type?: unknown } } | undefined)?.error?.type;
		return { ...r, login: 'refused', detail: r.detail || `claude.ai refused the session key${typeof type === 'string' ? ` (${maskSecrets(type).slice(0, 60)})` : ''}. It may have expired.` };
	}
	return { ...r, detail: r.detail || 'Not the answer a logged-in session gets.' };
}

/**
 * chatgpt.com/api/auth/session: a logged-in session gets JSON holding an access key; without
 * a login the site still answers 200, with an empty object. Only whether a key is there is read.
 */
export function readGpt(account: string, a: Answer): ProbeResult {
	const r = base('chatgpt.com', 'https://chatgpt.com/api/auth/session', account, a);
	if (r.challenge) return r;
	const json = parse(a.text);
	if (a.status === 200 && json !== null && typeof json === 'object' && !Array.isArray(json)) {
		const key = (json as { accessToken?: unknown }).accessToken;
		return typeof key === 'string' && key !== ''
			? { ...r, login: 'accepted', detail: 'The site handed out a login key.' }
			: { ...r, login: 'refused', detail: 'The site answered, but without a login key: the session cookie was not accepted or has expired.' };
	}
	if (a.status === 401 || a.status === 403) return { ...r, login: 'refused', detail: r.detail || 'chatgpt.com refused the session cookie.' };
	return { ...r, detail: r.detail || 'Not the answer a logged-in session gets.' };
}

/** A request that was not sent, or got no answer. */
export function noAnswer(site: ProbeResult['site'], url: string, account: string, detail: string, sent: boolean): ProbeResult {
	return { site, url, account, status: null, contentType: 'none', challenge: false, login: sent ? 'unclear' : 'not tested', detail };
}

/** One request passes when the site itself answered and took the login. */
export const passed = (r: ProbeResult): boolean => r.status === 200 && !r.challenge && r.login === 'accepted';

export function resultText(r: ProbeResult): string {
	const head = `${r.site} (${r.account}): ${r.login === 'not tested' ? 'NOT TESTED' : passed(r) ? 'PASS' : 'FAIL'}`;
	if (r.status === null) return `${head}\n  ${r.detail}`;
	return [
		head,
		`  GET ${r.url}`,
		`  status: ${r.status}`,
		`  content type: ${r.contentType}`,
		`  Cloudflare check page: ${r.challenge ? 'yes' : 'no'}`,
		`  login: ${r.login}`,
		...(r.detail ? [`  ${r.detail}`] : []),
	].join('\n');
}
