// Which accounts use the Browser link, and what the link looks like from the settings.
// Pure: no Node, no Obsidian (safe on phones).

import type { Provider } from '../login';
import type { LinkServer, TokenStore } from './server';

/** Providers that can use the Browser link so far. Claude and ChatGPT follow in a later step. */
export const LINK_PROVIDERS: readonly Provider[] = ['gemini'];

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
