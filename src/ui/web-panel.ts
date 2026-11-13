// The Web surface of an account: its login, where its chats go, and what gets synced.

import { Notice, SecretComponent, Setting } from 'obsidian';
import { hasPastedSession, loginRef, SITE_LABEL, withAccount, accountsOf, type AnyAccount } from '../accounts';
import { DEFAULT_OVERLAP_MINUTES } from '../chatgpt/inventory';
import { isLoggedIn, logout, openLogin, type Provider } from '../login';
import { isUuid } from '../schema';
import type { ChatgptAccount, ClaudeAccount, GeminiAccount, LumoAccount } from '../settings';
import { advanced, bindSyncButton, contentOptions, count, filingOptions, folderSetting, projectFilterOptions, rawFolderSetting, rawMoveRow, type PanelContext } from './fields';
import { googleRawMoves, webRawMoves } from '../raw-move';
import { masterRaw } from '../raw-folders';

/** Login state with only the buttons that make sense for it. */
function loginRow(ctx: PanelContext, el: HTMLElement, provider: Provider, account: AnyAccount, note: () => string, surface: 'web' | 'studio' = 'web'): void {
	const { plugin } = ctx;
	const list = accountsOf(plugin.settings, provider);
	const label = withAccount(SITE_LABEL[provider], list, account);
	const ref = loginRef(provider, account);
	const row = new Setting(el).setName('Login').setDesc('Checking…');
	row.settingEl.addClass('ccs-primary-row');
	const sync = (cta: boolean) =>
		row.addButton((b) => {
			b.setButtonText('Sync now');
			if (cta) b.setCta();
			bindSyncButton(ctx, b.buttonEl, () => plugin.isSyncing(provider, account.id), () => void plugin.syncAccount(provider, account, surface).then(ctx.refresh));
		});
	void isLoggedIn(ref).then((ok) => {
		if (!row.settingEl.isConnected) return;
		const extra = note();
		row.setDesc(`${ok ? 'Logged in.' : `Not logged in. Select "Log in" and sign in to the ${SITE_LABEL[provider]} account you want here.`}${extra ? ` ${extra}` : ''}`);
		if (ok) {
			row.addButton((b) =>
				b.setButtonText('Log out').onClick(async () => {
					await logout(ref);
					new Notice(`${label}: logged out (login removed from this computer).`);
					ctx.refresh();
				}),
			);
			sync(true);
			return;
		}
		if (hasPastedSession(provider, account)) sync(false);
		row.addButton((b) =>
			b.setButtonText('Log in').setCta().onClick(async () => {
				try {
					const r = await openLogin(ref, list.length > 1 ? account.label : undefined);
					new Notice(r === 'logged-in' || (await isLoggedIn(ref)) ? `${label}: logged in.` : `${label}: window closed, no login found.`);
				} catch (e) {
					new Notice(`${label}: ${e instanceof Error ? e.message : String(e)}`, 10_000);
				}
				ctx.refresh();
			}),
		);
	});
}

export function claudeWebPanel(ctx: PanelContext, el: HTMLElement, account: ClaudeAccount): void {
	const s = account.web;
	const save = () => ctx.plugin.saveSettings();
	const twin = ctx.plugin.settings.claude.find((a) => a !== account && s.orgId && a.web.orgId === s.orgId);
	loginRow(ctx, el, 'claude', account, () => `${count(Object.keys(s.index).length, 'chat')} saved.${twin ? ` Same organization as "${twin.label}", so check this is a different person's login.` : ''}`);

	new Setting(el).setName('Folders').setHeading();
	folderSetting(ctx, el, 'Chat folder', 'Where claude.ai chats are saved.', () => s.chatFolder, (p) => (s.chatFolder = p));
	rawFolderSetting(ctx, el, { name: 'Chat JSON folder', what: 'the raw .json of each chat', partner: 'chat folder', mirrors: true, get: () => s.chatRawFolder, set: (p) => (s.chatRawFolder = p) });
	folderSetting(ctx, el, 'Code Cloud folder', 'Where Claude Code sessions from claude.ai are saved: those run in the cloud (claude.ai/code), and Claude Code chats in the claude.ai chat list.', () => s.codeFolder, (p) => (s.codeFolder = p));
	rawFolderSetting(ctx, el, { name: 'Code Cloud JSON folder', what: 'the raw .json of each session', partner: 'Code Cloud folder', mirrors: true, get: () => s.codeRawFolder, set: (p) => (s.codeRawFolder = p) });
	rawMoveRow(ctx, el, () => webRawMoves(ctx.app, 'claude', account, masterRaw(ctx.plugin.settings)));
	filingOptions(ctx, el, 'claude.ai', s);

	new Setting(el).setName('Content').setHeading();
	contentOptions(ctx, el, 'claude', account, s);
	new Setting(el)
		.setName('Claude Code cloud sessions')
		.setDesc('Also save the Claude Code sessions that ran in the cloud (claude.ai/code), in the Code Cloud folder, one subfolder per repository. A session still running is saved once it is done. Sessions you steered from claude.ai but that ran on a computer are saved by Code Local instead.')
		.addToggle((t) =>
			t.setValue(s.cloudSessions).onChange(async (v) => {
				s.cloudSessions = v;
				await save();
			}),
		);

	const more = advanced(ctx, el, `claude-web-${account.id}`);
	new Setting(more)
		.setName('Session key (fallback)')
		.setDesc('Only if the login window does not work: your claude.ai "sessionKey" cookie, kept in Obsidian\'s secret storage on this computer. The login window wins if both are set.')
		.addComponent((c) =>
			new SecretComponent(ctx.app, c).setValue(s.secretId).onChange(async (v) => {
				s.secretId = v;
				await save();
			}),
		);
	new Setting(more)
		.setName('Organization ID')
		.setDesc('Filled in from the login. Also decides which Claude Desktop sessions belong to this account.')
		.addText((t) =>
			t.setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx').setValue(s.orgId).onChange(async (v) => {
				const id = v.trim();
				if (id && !isUuid(id)) return; // ignore until it looks like an ID
				s.orgId = id;
				await save();
			}),
		);
}

export function lumoWebPanel(ctx: PanelContext, el: HTMLElement, account: LumoAccount): void {
	const g = account.web;
	loginRow(ctx, el, 'lumo', account, () => `${count(Object.keys(g.index).length, 'chat')} saved.`);

	new Setting(el)
		.setName('Encryption')
		.setDesc('Lumo stores chats end-to-end encrypted. To sync, the plugin unlocks your keys from the login window for that one sync, in memory only, and saves readable copies in this vault. Anything that can read your vault can read them. Files attached to chats are not saved.');

	new Setting(el).setName('Folders').setHeading();
	folderSetting(ctx, el, 'Chat folder', 'Where Lumo chats are saved.', () => g.folder, (p) => (g.folder = p));
	rawFolderSetting(ctx, el, { name: 'JSON folder', what: 'the decrypted .json of each chat', partner: 'chat folder', mirrors: true, get: () => g.rawFolder, set: (p) => (g.rawFolder = p) });
	rawMoveRow(ctx, el, () => webRawMoves(ctx.app, 'lumo', account, masterRaw(ctx.plugin.settings)));
	filingOptions(ctx, el, 'Lumo', g);

	new Setting(el).setName('Content').setHeading();
	projectFilterOptions(ctx, el, 'lumo', account, g);
}

export function geminiWebPanel(ctx: PanelContext, el: HTMLElement, account: GeminiAccount): void {
	const g = account.web;
	loginRow(ctx, el, 'gemini', account, () => `${count(Object.keys(g.index).length, 'chat')} saved. The same Google login is used for AI Studio.`);

	new Setting(el).setName('Folders').setHeading();
	folderSetting(ctx, el, 'Chat folder', 'Where Gemini chats are saved.', () => g.folder, (p) => (g.folder = p));
	rawFolderSetting(ctx, el, { name: 'JSON folder', what: 'the .json of each chat', partner: 'chat folder', get: () => g.rawFolder, set: (p) => (g.rawFolder = p) });
	rawMoveRow(ctx, el, () => googleRawMoves(ctx.app, account, 'web', masterRaw(ctx.plugin.settings)));
	new Setting(el)
		.setName('What is saved')
		.setDesc("Each chat's prompts and answers, including the reasoning Gemini shows. Images and files in chats are listed but not downloaded. Gemini has no public API, so the plugin reads what the website itself loads; if Google changes that, the sync stops instead of saving something wrong.");

	const more = advanced(ctx, el, `gemini-web-${account.id}`);
	new Setting(more)
		.setName('Google cookies (fallback)')
		.setDesc('Only if the login window does not work: the whole Cookie header of a gemini.google.com request, copied from DevTools. Used for Gemini and AI Studio, kept in Obsidian\'s secret storage on this computer, and loaded only into a hidden window that is emptied after each sync. The login window wins if both are set. Google renews these cookies often, so a pasted copy stops working sooner than a login.')
		.addComponent((c) =>
			new SecretComponent(ctx.app, c).setValue(g.secretId).onChange(async (v) => {
				g.secretId = v;
				await ctx.plugin.saveSettings();
			}),
		);
}

export function studioPanel(ctx: PanelContext, el: HTMLElement, account: GeminiAccount): void {
	const st = account.studio;
	loginRow(ctx, el, 'gemini', account, () => `${count(Object.keys(st.index).length, 'prompt')} saved.`, 'studio');

	new Setting(el)
		.setName('Sync AI Studio')
		.setDesc('AI Studio keeps your chats and prompts as files in your Google Drive. When on, "Sync" on this account and "Sync all" also save those.')
		.addToggle((t) =>
			t.setValue(st.enabled).onChange(async (v) => {
				st.enabled = v;
				await ctx.plugin.saveSettings();
			}),
		);

	new Setting(el).setName('Folders').setHeading();
	folderSetting(ctx, el, 'AI Studio folder', 'Where AI Studio chats and prompts are saved.', () => st.folder, (p) => (st.folder = p));
	rawFolderSetting(ctx, el, { name: 'JSON folder', what: 'the .json of each prompt', partner: 'AI Studio folder', get: () => st.rawFolder, set: (p) => (st.rawFolder = p) });
	rawMoveRow(ctx, el, () => googleRawMoves(ctx.app, account, 'studio', masterRaw(ctx.plugin.settings)));
}

export function chatgptWebPanel(ctx: PanelContext, el: HTMLElement, account: ChatgptAccount): void {
	const g = account.web;
	const save = () => ctx.plugin.saveSettings();
	loginRow(ctx, el, 'chatgpt', account, () => {
		const until = g.cooldownUntil ?? 0;
		return `${count(Object.keys(g.index).length, 'chat')} saved.${until > Date.now() ? ` Rate limited, cooling down until ${new Date(until).toLocaleTimeString()}.` : ''}`;
	});

	new Setting(el).setName('Folders').setHeading();
	folderSetting(ctx, el, 'Chat folder', 'Where ChatGPT chats are saved.', () => g.folder, (p) => (g.folder = p));
	rawFolderSetting(ctx, el, { name: 'JSON folder', what: 'the raw .json of each chat (and the older parts of long chats)', partner: 'chat folder', mirrors: true, get: () => g.rawFolder, set: (p) => (g.rawFolder = p) });
	rawMoveRow(ctx, el, () => webRawMoves(ctx.app, 'chatgpt', account, masterRaw(ctx.plugin.settings)));
	filingOptions(ctx, el, 'ChatGPT', g);

	new Setting(el).setName('Content').setHeading();
	contentOptions(ctx, el, 'chatgpt', account, g);
	new Setting(el)
		.setName('Include archived chats')
		.setDesc('Also check archived conversations during sync.')
		.addToggle((t) =>
			t.setValue(g.includeArchived ?? false).onChange(async (v) => {
				g.includeArchived = v;
				await save();
			}),
		);

	const more = advanced(ctx, el, `chatgpt-web-${account.id}`);
	new Setting(more)
		.setName('Session cookie (fallback)')
		.setDesc('Only if the login window does not work: the value of your chatgpt.com "__Secure-next-auth.session-token" cookie, or the whole Cookie header from DevTools if ChatGPT splits it into .0 and .1. Kept in Obsidian\'s secret storage on this computer. The login window wins if both are set. Files ChatGPT generated in a chat may be skipped with this.')
		.addComponent((c) =>
			new SecretComponent(ctx.app, c).setValue(g.secretId).onChange(async (v) => {
				g.secretId = v;
				await save();
			}),
		);
	new Setting(more)
		.setName('Incremental sync overlap (minutes)')
		.setDesc('Check recent changes again on each run. A full inventory runs on the next sync after seven days.')
		.addText((t) =>
			t.setValue(String(g.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES)).onChange(async (v) => {
				const minutes = Number(v);
				if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return;
				g.overlapMinutes = minutes;
				await save();
			}),
		);
	new Setting(more)
		.setName('Workspace ID')
		.setDesc('Filled in by the first sync. Decides which Codex sessions belong to this account.')
		.addText((t) =>
			t.setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx').setValue(g.workspaceId ?? '').onChange(async (v) => {
				const id = v.trim();
				if (id && !isUuid(id)) return; // ignore until it looks like an ID
				g.workspaceId = id || undefined;
				await save();
			}),
		);
	new Setting(more)
		.setName('Retry missing files')
		.setDesc('Make delayed downloads eligible on the next sync. The account cooldown still applies.')
		.addButton((b) =>
			b.setButtonText('Reset file delays').onClick(async () => {
				const retries = g.assetRetries ?? {};
				for (const id of Object.keys(retries)) delete retries[id];
				await save();
				new Notice('File delays reset for the next sync.');
			}),
		);
}
