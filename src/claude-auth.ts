// Where the claude.ai login comes from: the login window first (its "sessionKey"
// cookie), the session key in Obsidian's secret storage as a fallback.
// The organization ID is read from the login's "lastActiveOrg" cookie if not set.

import type AIChatBridge from './main';
import { cookieValue } from './login';
import { isUuid } from './schema';

export interface ClaudeAuth {
	getKey: () => string | null;
	orgId: string;
	source: 'login window' | 'secret storage' | 'none';
}

export async function claudeAuth(plugin: AIChatBridge): Promise<ClaudeAuth> {
	const s = plugin.settings;
	const fromLogin = await cookieValue('claude', 'sessionKey');
	const fromSecret = s.secretId ? plugin.app.secretStorage.getSecret(s.secretId) : null;
	const key = fromLogin ?? fromSecret;

	let orgId = s.orgId;
	if (!isUuid(orgId) && fromLogin) {
		const org = await cookieValue('claude', 'lastActiveOrg');
		if (isUuid(org)) {
			s.orgId = org; // not secret; saved so you can see it in settings
			await plugin.saveSettings();
			orgId = org;
		}
	}
	return {
		getKey: () => key,
		orgId,
		source: fromLogin ? 'login window' : fromSecret ? 'secret storage' : 'none',
	};
}
