import { Notice, Platform, Setting, type ToggleComponent } from 'obsidian';
import { accountsOf, SITE_LABEL, withAccount } from '../accounts';
import type { ChatgptAccount, ClaudeAccount } from '../settings';
import type { PanelContext } from './fields';
import { ConfirmModal } from './modals';

export function archiveSettings(ctx: PanelContext, el: HTMLElement, provider: 'claude' | 'chatgpt', account: ClaudeAccount | ChatgptAccount): void {
	const { web } = account;
	const { plugin } = ctx;
	let separate: ToggleComponent | undefined;
	let change = 0;
	const chooseWhen = () => {
		if (Platform.isMobile) return; // The next sync on the computer uses the new setting.
		const label = withAccount(SITE_LABEL[provider], accountsOf(plugin.settings, provider), account);
		const cooldown = 'cooldownUntil' in web ? web.cooldownUntil ?? 0 : 0;
		const waiting = cooldown > Date.now();
		const body = waiting
			? `${label} is cooling down until ${new Date(cooldown).toLocaleTimeString()}. You can schedule the archive check for the end of the cooldown or leave it for the next sync.`
			: `Start a web sync for ${label} to check archive status and move saved chats. The sync can also save new or changed chats.`;
		new ConfirmModal(ctx.app, 'Separate archived chats', body, waiting ? 'Separate when ready' : 'Separate now', () => {
			void plugin.syncArchivedNow(provider, account.id).catch(() => {
				new Notice('The archive check could not start. Separation will be checked on the next sync.');
			}).finally(ctx.refresh);
		}, 'cta', 'Next sync').open();
	};
	new Setting(el)
		.setName('Include archived chats')
		.setDesc(provider === 'claude' ? 'Also check archived conversations during sync. claude.ai lists them separately.' : 'Also check archived conversations during sync.')
		.addToggle((t) => t.setValue(web.includeArchived === true).onChange(async (value) => {
			const current = ++change;
			const reactivating = value && web.separateArchived === true;
			web.includeArchived = value;
			separateRow.settingEl.toggleClass('ccs-hidden', !value);
			separate?.setValue(web.separateArchived === true).setDisabled(!value);
			await plugin.saveSettings();
			if (reactivating && change === current) chooseWhen();
		}));
	const separateRow = new Setting(el)
		.setName('Separate archived chats')
		.setDesc('File archived chats in a separate folder. Turning this off leaves existing notes where they are.')
		.addToggle((t) => {
			separate = t.setValue(web.separateArchived === true).setDisabled(web.includeArchived !== true);
			t.onChange(async (value) => {
				if (!web.includeArchived) return;
				const current = ++change;
				web.separateArchived = value;
				await plugin.saveSettings();
				if (value && change === current) chooseWhen();
			});
		});
	separateRow.settingEl.addClass('ccs-sub-setting');
	separateRow.settingEl.toggleClass('ccs-hidden', web.includeArchived !== true);
}
