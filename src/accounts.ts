// Several accounts per provider: naming them, adding and removing them.
// Pure code, no Obsidian UI.

import type { LoginRef, Provider } from './login';
import { CHATGPT_APP, CLAUDE_APP, layoutRoot } from './desktop/layout';
import { safeTitle } from './naming';
import { DEFAULT_CLAUDE_WEB, DEFAULT_GEMINI, DEFAULT_GPT, DEFAULT_LUMO, DEFAULT_STUDIO, desktopApp, type ChatgptAccount, type ClaudeAccount, type GeminiAccount, type LumoAccount, type Settings } from './settings';

export type DesktopAccount = ClaudeAccount | ChatgptAccount;
export type AnyAccount = DesktopAccount | LumoAccount | GeminiAccount;

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', lumo: 'Lumo', gemini: 'Gemini' };
export const SITE_LABEL: Record<Provider, string> = { claude: 'claude.ai', chatgpt: 'ChatGPT', lumo: 'Lumo', gemini: 'Google' };

export function accountsOf(s: Settings, provider: Provider): AnyAccount[] {
	return s[provider];
}

export function loginRef(provider: Provider, account: { id: string }): LoginRef {
	return { provider, id: account.id };
}

/**
 * Whether the account names a pasted session in secret storage (claude.ai, ChatGPT). Lumo has
 * none: opening its encrypted chats needs keys only its login window holds.
 */
export function hasPastedSession(provider: Provider, account: AnyAccount): boolean {
	if (provider === 'claude') return !!(account as ClaudeAccount).web.secretId;
	if (provider === 'chatgpt') return !!(account as ChatgptAccount).web.secretId;
	return false;
}

/** "ChatGPT (Work)" once there are several accounts, plain "ChatGPT" while there is one. */
export function withAccount(base: string, list: readonly AnyAccount[], account: AnyAccount): string {
	return list.length > 1 ? `${base} (${account.label})` : base;
}

/** Why this account name cannot be used, or null. Names become folder names, so they must differ. */
export function nameProblem(list: readonly AnyAccount[], name: string, self?: AnyAccount): string | null {
	const n = name.trim();
	if (!n) return 'Enter a name.';
	if (n.length > 40) return 'Use 40 characters or fewer.';
	if (safeTitle(n) !== n) return 'Use a name without special characters such as / : ? or *.';
	if (list.some((a) => a !== self && a.label.toLowerCase() === n.toLowerCase())) return 'Another account already has this name.';
	return null;
}

const newId = (): string => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const under = (root: string, rest: string) => (root ? `${root}/${rest}` : rest);

/**
 * A new account, with folders of its own next to the first account's
 * (e.g. "AI Chats/Claude Desktop (Work)/Chat"), so two accounts' chats never mix.
 */
export function addAccount(s: Settings, provider: Provider, label: string): AnyAccount {
	const name = label.trim();
	const root = layoutRoot(s.claude[0]!.web.chatFolder);
	if (provider === 'claude') {
		const app = under(root, `${CLAUDE_APP} (${name})`);
		const account: ClaudeAccount = {
			id: newId(),
			label: name,
			web: { ...DEFAULT_CLAUDE_WEB, projects: [], index: {}, fileIndex: {}, chatFolder: `${app}/Chat`, codeFolder: `${app}/Code` },
			desktop: desktopApp(`${app}/Code`),
		};
		s.claude.push(account);
		return account;
	}
	if (provider === 'lumo') {
		const account: LumoAccount = { id: newId(), label: name, web: { ...DEFAULT_LUMO, projects: [], index: {}, folder: under(root, `Lumo (${name})/Chat`) } };
		s.lumo.push(account);
		return account;
	}
	if (provider === 'gemini') {
		const app = under(root, `Gemini (${name})`);
		const account: GeminiAccount = {
			id: newId(),
			label: name,
			web: { ...DEFAULT_GEMINI, index: {}, folder: `${app}/Chat` },
			studio: { ...DEFAULT_STUDIO, index: {}, folder: `${app}/AI Studio` },
		};
		s.gemini.push(account);
		return account;
	}
	const app = under(root, `${CHATGPT_APP} (${name})`);
	const account: ChatgptAccount = {
		id: newId(),
		label: name,
		web: { ...DEFAULT_GPT, projects: [], index: {}, fileIndex: {}, folder: `${app}/Chat` },
		desktop: desktopApp(`${app}/Codex`),
	};
	s.chatgpt.push(account);
	return account;
}

/** Forgets an account's settings and sync history. A provider always keeps at least one. */
export function removeAccount(s: Settings, provider: Provider, account: AnyAccount): boolean {
	if (s[provider].length <= 1) return false;
	if (provider === 'claude') s.claude = s.claude.filter((a) => a !== account);
	else if (provider === 'lumo') s.lumo = s.lumo.filter((a) => a !== account);
	else if (provider === 'gemini') s.gemini = s.gemini.filter((a) => a !== account);
	else s.chatgpt = s.chatgpt.filter((a) => a !== account);
	return true;
}
