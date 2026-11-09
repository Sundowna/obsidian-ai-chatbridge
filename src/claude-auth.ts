// Where a claude.ai login comes from: the account's login window first (its "sessionKey"
// cookie), the session key in Obsidian's secret storage as a fallback.
// The organization ID is read from the login's "lastActiveOrg" cookie if not set, and
// again whenever a different login appears in this account's window.

import type AIChatBridge from './main';
import { loginRef } from './accounts';
import { cookieValue } from './login';
import { isUuid } from './schema';
import type { ClaudeAccount } from './settings';

export interface ClaudeAuth {
	getKey: () => string | null;
	orgId: string;
	source: 'login window' | 'secret storage' | 'none';
}

export async function claudeAuth(plugin: AIChatBridge, account: ClaudeAccount): Promise<ClaudeAuth> {
	const s = account.web;
	const login = loginRef('claude', account);
	const fromLogin = await cookieValue(login, 'sessionKey');
	const fromSecret = s.secretId ? plugin.app.secretStorage.getSecret(s.secretId) : null;
	const key = fromLogin ?? fromSecret;

	let orgId = s.orgId;
	if (fromLogin) {
		const org = await cookieValue(login, 'lastActiveOrg');
		if (isUuid(org)) {
			// The window's organization only changes when someone else logs in, so an ID
			// typed in by hand stays until then.
			const switched = s.loginOrg !== undefined && s.loginOrg !== org;
			const next = switched || !isUuid(orgId) ? org : orgId;
			if (next !== s.orgId || s.loginOrg !== org) {
				s.orgId = next; // not secret; saved so you can see it in settings
				s.loginOrg = org;
				await plugin.saveSettings();
			}
			orgId = next;
		}
	}
	return {
		getKey: () => key,
		orgId,
		source: fromLogin ? 'login window' : fromSecret ? 'secret storage' : 'none',
	};
}
