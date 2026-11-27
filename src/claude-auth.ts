// Where a claude.ai login comes from: the account's login window first (its "sessionKey"
// cookie), the session key in Obsidian's secret storage as a fallback.
// The organization ID is read from the login's "lastActiveOrg" cookie if not set, and
// again whenever a different login appears in this account's window.

import type AIChatBridge from './main';
import { loginRef } from './accounts';
import { cookieValue } from './login';
import { isUuid } from './schema';
import type { ClaudeAccount } from './settings';
import { transportFor, type Transport } from './transport';
import { BrowserLinkUnavailable } from './link/errors';

export interface ClaudeAuth {
	getKey: () => string | null;
	orgId: string;
	source: 'login window' | 'secret storage' | 'browser link' | 'none';
	/** How this account's requests reach claude.ai. */
	transport: Transport;
	/** Browser link only: why the browser cannot be used right now (the sync skips the account). */
	linkProblem?: BrowserLinkUnavailable;
}

/**
 * Stands in for the session key on the Browser link, where the browser sends its own login:
 * the plugin never sees the real key, and the Cookie header that would carry it is not sent.
 */
export const BROWSER_LINK_KEY = 'browser-link';

/** Keeps the organization of the login, as the login window does: a hand-typed ID stays until another login appears. */
async function followLoginOrg(plugin: AIChatBridge, s: ClaudeAccount['web'], org: string): Promise<string> {
	const switched = s.loginOrg !== undefined && s.loginOrg !== org;
	const next = switched || !isUuid(s.orgId) ? org : s.orgId;
	if (next !== s.orgId || s.loginOrg !== org) {
		s.orgId = next; // not secret; saved so you can see it in settings
		s.loginOrg = org;
		await plugin.saveSettings();
	}
	return next;
}

export async function claudeAuth(plugin: AIChatBridge, account: ClaudeAccount): Promise<ClaudeAuth> {
	const s = account.web;
	const login = loginRef('claude', account);
	const transport = transportFor(login);
	if (transport.kind === 'browser-link') {
		// Your own browser: its login is used there, the organization is read from claude.ai.
		let orgId = s.orgId;
		let linkProblem: BrowserLinkUnavailable | undefined;
		try {
			const org = await transport.siteValue('claude-org');
			if (isUuid(org)) orgId = await followLoginOrg(plugin, s, org);
			else linkProblem = new BrowserLinkUnavailable('not-logged-in', 'claude.ai');
		} catch (e) {
			if (!(e instanceof BrowserLinkUnavailable)) throw e;
			linkProblem = e;
		}
		return { getKey: () => BROWSER_LINK_KEY, orgId, source: 'browser link', transport, linkProblem };
	}
	const fromLogin = await cookieValue(login, 'sessionKey');
	const fromSecret = s.secretId ? plugin.app.secretStorage.getSecret(s.secretId) : null;
	const key = fromLogin ?? fromSecret;

	let orgId = s.orgId;
	if (fromLogin) {
		const org = await cookieValue(login, 'lastActiveOrg');
		// The window's organization only changes when someone else logs in, so an ID
		// typed in by hand stays until then.
		if (isUuid(org)) orgId = await followLoginOrg(plugin, s, org);
	}
	return {
		getKey: () => key,
		orgId,
		source: fromLogin ? 'login window' : fromSecret ? 'secret storage' : 'none',
		transport,
	};
}
