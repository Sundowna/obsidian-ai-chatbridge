// The Web surface of an account: its login, where its chats go, and what gets synced.

import { Notice, SecretComponent, Setting } from 'obsidian';
import { loginRef, SITE_LABEL, withAccount, accountsOf, type AnyAccount } from '../accounts';
import { DEFAULT_OVERLAP_MINUTES } from '../chatgpt/inventory';
import { isLoggedIn, logout, openLogin, type Provider } from '../login';
import { isUuid } from '../schema';
import type { ChatgptAccount, ClaudeAccount, LumoAccount } from '../settings';
import { advanced, contentOptions, count, filingOptions, folderSetting, projectFilterOptions, type PanelContext } from './fields';

/** Login state with only the buttons that make sense for it. */
function loginRow(ctx: PanelContext, el: HTMLElement, provider: Provider, account: AnyAccount, note: () => string): void {
	const { plugin } = ctx;
	const list = accountsOf(plugin.settings, provider);
	const label = withAccount(SITE_LABEL[provider], list, account);
	const ref = loginRef(provider, account);
	const row = new Setting(el).setName('Login').setDesc('Checking…');
	row.settingEl.addClass('ccs-primary-row');
	const sync = (cta: boolean) =>
		row.addButton((b) => {
			b.setButtonText('Sync now').onClick(() => {
				void plugin.syncAccount(provider, account, 'web').then(ctx.refresh);
			});
			if (cta) b.setCta();
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
		if (provider === 'claude' && (account as ClaudeAccount).web.secretId) sync(false);
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
	folderSetting(ctx, el, 'Code folder', 'Where Claude Code sessions listed on claude.ai are saved.', () => s.codeFolder, (p) => (s.codeFolder = p));
	filingOptions(ctx, el, 'claude.ai', s);

	new Setting(el).setName('Content').setHeading();
	contentOptions(ctx, el, 'claude', account, s);

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
		.setDesc('Filled in from the login. Also decides which Claude desktop sessions belong to this account.')
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
	filingOptions(ctx, el, 'Lumo', g);

	new Setting(el).setName('Content').setHeading();
	projectFilterOptions(ctx, el, 'lumo', account, g);
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
