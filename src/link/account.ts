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
