// Which accounts use the Browser link, and what the link looks like from the settings.
// Pure: no Node, no Obsidian (safe on phones).

import type { Provider } from '../login';
import type { LinkServer, TokenStore } from './server';

/** Providers that can use the Browser link. Lumo cannot: unlocking its chats needs keys only its login window holds. */
export const LINK_PROVIDERS: readonly Provider[] = ['gemini', 'claude', 'chatgpt'];

/** Where the extension's token is kept (Obsidian's secret storage on this computer). */
export const LINK_SECRET_ID = 'ai-chatbridge-browser-link';

export type LoginMethod = 'window' | 'browser';

/** An account's login method; missing = the login window, so existing accounts keep theirs. */
export function loginMethodOf(provider: Provider, account: { web: { loginMethod?: LoginMethod } }): LoginMethod {
	return LINK_PROVIDERS.includes(provider) && account.web.loginMethod === 'browser' ? 'browser' : 'window';
}

export const usesBrowserLink = (provider: Provider, account: { web: { loginMethod?: LoginMethod } }): boolean => loginMethodOf(provider, account) === 'browser';

export type LinkState = 'not-paired' | 'browser-closed' | 'linked';

/** The link as the settings show it. `paired` is read from the token, also while the server is off. */
export function linkState(server: LinkServer | null, paired: boolean): LinkState {
	if (!paired) return 'not-paired';
	return server?.linked ? 'linked' : 'browser-closed';
}

export const LINK_STATE_TEXT: Record<LinkState, string> = {
	'not-paired': 'Browser link: not paired yet. Select "Pair browser…" and follow the steps.',
	'browser-closed': 'Browser link: your browser is closed, or the ChatBridge extension is off. Open it before you sync.',
	linked: 'Browser link: linked to your browser. The sync uses the login you have there.',
};

/** The token store on Obsidian's secret storage (an empty secret = none). */
export function secretTokenStore(secrets: { getSecret(id: string): string | null; setSecret(id: string, v: string): void }): TokenStore {
	return {
		get: () => secrets.getSecret(LINK_SECRET_ID) || null,
		set: (t) => secrets.setSecret(LINK_SECRET_ID, t ?? ''),
	};
}

/** The browser of an extension that sends no ID of its own (before 0.2.6), and of a token saved before then. */
export const LEGACY_BROWSER = 'default';

/** A browser ID as the extension sends it: random, short, plain. */
export const isBrowserId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v);

/** The saved tokens, by browser. An older plain token belongs to LEGACY_BROWSER. */
export function readTokens(raw: string | null): Record<string, string> {
	if (!raw) return {};
	if (!raw.startsWith('{')) return { [LEGACY_BROWSER]: raw };
	try {
		const o = JSON.parse(raw) as unknown;
		if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(o as Record<string, unknown>)) if ((k === LEGACY_BROWSER || isBrowserId(k)) && typeof v === 'string' && v) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** The tokens as they are saved; null when none is left. */
export function writeTokens(tokens: Record<string, string>): string | null {
	return Object.keys(tokens).length ? JSON.stringify(tokens) : null;
}

/**
 * The browser an account's requests go to. Its own pick wins. Without one ("Any connected
 * browser"), a connected browser that no other account has picked comes first, so a browser
 * paired for one account (a work profile, say) does not catch the others' requests; when every
 * connected browser is picked by someone, any of them will do.
 */
export function pickBrowser(own: string | undefined, claimedByOthers: readonly string[], linked: readonly string[]): string | undefined {
	if (own) return own;
	return linked.find((b) => !claimedByOthers.includes(b));
}

/** The pair button of an account's login row: always there, so a second browser never needs an unpair first. */
export function pairButtonText(state: LinkState): string {
	return state === 'not-paired' ? 'Pair browser…' : state === 'linked' ? 'Pair another browser…' : 'Pair again…';
}

/** Unpair from an account without a browser of its own forgets every paired browser: with several, it asks first. */
export const unpairForgetsAll = (own: string | undefined, paired: number): boolean => !own && paired > 1;

/** Which browser a connection comes from, by its User-Agent; undefined when it does not say. */
export function browserKind(userAgent: string | undefined): string | undefined {
	const ua = userAgent ?? '';
	if (/\bEdg\//.test(ua)) return 'Edge';
	if (/\bOPR\//.test(ua)) return 'Opera';
	if (/\bVivaldi\//.test(ua)) return 'Vivaldi';
	if (/\bFirefox\//.test(ua)) return 'Firefox';
	if (/\bChrome\//.test(ua)) return 'Chrome';
	return undefined;
}

/** A name the plugin made up ("Browser 2"), which a browser's own kind may replace. */
export const isMadeUpBrowserName = (name: string | undefined): boolean => !name || /^Browser( \d+| \(paired before names\))?$/.test(name);

/** "Chrome", or "Chrome 2" when another browser already has that name. */
export function kindName(kind: string, taken: readonly string[]): string {
	if (!taken.includes(kind)) return kind;
	for (let n = 2; ; n++) if (!taken.includes(`${kind} ${n}`)) return `${kind} ${n}`;
}

/**
 * Why a browser name you type is refused, or null when it is fine: empty, a made-up "Browser 2"
 * (the next connect would replace it with the browser's own name), or another browser's name.
 */
export function browserNameProblem(name: string, otherNames: readonly string[]): string | null {
	const n = name.trim();
	if (!n) return 'Enter a name.';
	if (isMadeUpBrowserName(n)) return `"${n}" would be replaced by the browser's own name when it connects. Choose another, for example "Chrome (work)".`;
	if (otherNames.some((o) => o.trim().toLowerCase() === n.toLowerCase())) return `Another browser is already called "${n}".`;
	return null;
}
