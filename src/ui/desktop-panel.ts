// The Desktop surface of an account: sessions the desktop app and CLI saved on this computer.

import { Setting } from 'obsidian';
import type { DesktopAccount } from '../accounts';
import { defaultRoots, nodeDesktopFs } from '../desktop/scan';
import type { DesktopApp } from '../desktop/types';
import type { Provider } from '../login';
import type { ChatgptAccount, ClaudeAccount } from '../settings';
import { advanced, count, folderSetting, type PanelContext } from './fields';

/** How this account's sessions are told apart from another account's. */
function matchText(provider: Provider, account: DesktopAccount, isFirst: boolean, several: boolean): string {
	if (!several) return '';
	const [idName, id] = provider === 'claude'
		? ['organization ID', (account as ClaudeAccount).web.orgId]
		: ['workspace ID', (account as ChatgptAccount).web.workspaceId];
	if (isFirst) return ` Sessions are matched to accounts by ${idName}; this first account also gets any no other account claims.`;
	return id
		? ` Only sessions matching this account's ${idName} are saved here.`
		: ` Sessions are matched by ${idName}, which is filled in once this account has logged in and synced. Until then none come here.`;
}

export function desktopPanel(ctx: PanelContext, el: HTMLElement, provider: Provider, account: DesktopAccount, list: readonly DesktopAccount[]): void {
	const conf = account.desktop;
	const save = () => ctx.plugin.saveSettings();
	const app: DesktopApp = provider === 'claude' ? 'claude' : 'codex';
	const appName = provider === 'claude' ? 'Claude desktop app and Claude Code CLI' : 'ChatGPT/Codex desktop app and Codex CLI';
	const fs = nodeDesktopFs();
	const roots = fs ? defaultRoots(fs, app) : [provider === 'claude' ? '~/.claude/projects' : '~/.codex/sessions'];
	const isFirst = list[0] === account;

	const row = new Setting(el)
		.setName('Sync desktop sessions')
		.setDesc(`From the ${appName}. Read-only; ${count(Object.keys(conf.index).length, 'session')} saved.`)
		.addToggle((t) =>
			t.setValue(conf.enabled).onChange(async (v) => {
				conf.enabled = v;
				await save();
				ctx.refresh();
			}),
		);
	row.settingEl.addClass('ccs-primary-row');
	if (conf.enabled) {
		row.addButton((b) =>
			b.setButtonText('Sync now').setCta().onClick(() => {
				void ctx.plugin.syncAccount(provider, account, 'desktop').then(ctx.refresh);
			}),
		);
	}
	if (!conf.enabled) return;

	folderSetting(ctx, el, provider === 'claude' ? 'Code folder' : 'Codex folder', 'Where these sessions are saved.', () => conf.folder, (p) => (conf.folder = p));
	new Setting(el)
		.setName('Reads from')
		.setDesc(`${roots.join(' and ')}.${matchText(provider, account, isFirst, list.length > 1)}`);

	const more = advanced(ctx, el, `desktop-${provider}-${account.id}`);
	const example = provider === 'claude' ? 'C:/Users/me/.claude-work/projects' : 'C:/Users/me/.codex-work/sessions';
	new Setting(more)
		.setName('Extra session folders')
		.setDesc('One folder per line, for example the config folder of a second login. Everything in these folders belongs to this account. Subfolders are included.')
		.addTextArea((t) =>
			t.setPlaceholder(example).setValue(conf.extraFolders.join('\n')).onChange(async (v) => {
				conf.extraFolders = v.split('\n').map((x) => x.trim()).filter(Boolean);
				await save();
			}),
		);
}
