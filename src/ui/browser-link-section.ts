// Browser link in the settings: the login method choice, the login row of an account that uses
// the link, and the pairing window. The link itself (one browser for all accounts) lives in
// link/; this file only shows it.

import { Modal, Notice, Platform, Setting, type App } from 'obsidian';
import { loginRef, type AnyAccount } from '../accounts';
import { LINK_STATE_TEXT, linkState, usesBrowserLink, type LinkState, type LoginMethod } from '../link/account';
import { isLoggedIn, type Provider } from '../login';
import type AIChatBridge from '../main';
import type { GeminiAccount } from '../settings';
import { lastRunLine, runKey } from '../last-run';
import { bindSyncButton, type PanelContext } from './fields';

/** The link as it stands now. */
export function browserLinkState(plugin: AIChatBridge): LinkState {
	return linkState(plugin.browserLink.server, !!plugin.linkTokens().get());
}

const SHORT: Record<LinkState, string> = { 'not-paired': 'Browser not paired', 'browser-closed': 'Browser closed', linked: '' };

/**
 * Whether an account can sync now, for the Overview card and the account pills: its login
 * window, or (Browser link) whether the browser is linked. `text` replaces "Not logged in".
 */
export async function accountReady(plugin: AIChatBridge, provider: Provider, account: AnyAccount): Promise<{ ok: boolean; text: string }> {
	if (provider === 'gemini' && usesBrowserLink(provider, account as GeminiAccount)) {
		const s = browserLinkState(plugin);
		return { ok: s === 'linked', text: SHORT[s] };
	}
	return { ok: await isLoggedIn(loginRef(provider, account)), text: 'Not logged in' };
}

/** Login method of a Google account: the login window or the Browser link. Computers only. */
export function loginMethodSetting(ctx: PanelContext, el: HTMLElement, account: GeminiAccount): void {
	if (!Platform.isDesktopApp) return;
	new Setting(el)
		.setName('Login method')
		.setDesc('Google blocks sign-in inside apps, so for Google accounts the Browser link is the reliable way: the sync uses your own browser, where you are already logged in. It needs the ChatBridge extension in Chrome, Edge or Brave, and the browser open while syncing. Used for Gemini and AI Studio.')
		.addDropdown((d) =>
			d.addOption('window', 'Login window (inside Obsidian)')
				.addOption('browser', 'Browser link (your own browser)')
				.setValue(account.web.loginMethod === 'browser' ? 'browser' : 'window')
				.onChange(async (v) => {
					account.web.loginMethod = v as LoginMethod;
					await ctx.plugin.saveSettings();
					await ctx.plugin.updateBrowserLink();
					ctx.refresh();
				}),
		);
}

/** The login row of an account that uses the Browser link: the link's state and what to do next. */
export function linkLoginRow(ctx: PanelContext, el: HTMLElement, provider: Provider, account: AnyAccount, note: () => string, surface: 'web' | 'studio' = 'web'): void {
	const { plugin } = ctx;
	const state = browserLinkState(plugin);
	const extra = note();
	const row = new Setting(el).setName('Login').setDesc(`${LINK_STATE_TEXT[state]}${extra ? ` ${extra}` : ''}`);
	row.settingEl.addClass('ccs-primary-row');
	row.settingEl.dataset.linkState = state;
	lastRunLine(row.infoEl, plugin.settings.lastRuns[runKey(surface, provider, account.id)]);
	if (state !== 'not-paired') {
		row.addButton((b) =>
			b.setButtonText('Unpair').onClick(() => {
				const server = plugin.browserLink.server;
				if (server) server.unpair();
				else plugin.linkTokens().set(null);
				new Notice('Browser link: unpaired. Syncs through your browser stop until you pair again.');
				ctx.refresh();
			}),
		);
	}
	if (state !== 'linked') {
		row.addButton((b) => {
			b.setButtonText(state === 'not-paired' ? 'Pair browser…' : 'Pair again…').onClick(() => new PairBrowserModal(ctx.app, plugin, ctx.refresh).open());
			if (state === 'not-paired') b.setCta();
		});
	}
	if (state !== 'not-paired') {
		row.addButton((b) => {
			b.setButtonText('Sync now');
			if (state === 'linked') b.setCta();
			bindSyncButton(ctx, b.buttonEl, () => plugin.isSyncing(provider, account.id), () => void plugin.syncAccount(provider, account, surface).then(ctx.refresh));
		});
	}
}

/** Shows a one-time pairing code and waits until the browser has used it. */
export class PairBrowserModal extends Modal {
	private timer: number | null = null;

	constructor(app: App, private readonly plugin: AIChatBridge, private readonly done: () => void) {
		super(app);
	}

	onOpen(): void {
		void this.show();
	}

	private async show(): Promise<void> {
		const { contentEl } = this;
		this.setTitle('Pair your browser');
		contentEl.addClass('ccs-pair-browser');
		await this.plugin.updateBrowserLink();
		const server = this.plugin.browserLink.server;
		if (!server) {
			contentEl.createEl('p', { text: 'The Browser link could not start on this computer. Choose "Browser link" as the login method of a Google account first, then try again.' });
			return;
		}
		const code = server.newPairingCode();
		const steps = contentEl.createEl('ol');
		steps.createEl('li', { text: 'Install the ChatBridge extension in Chrome, Edge or Brave (see "Browser link" in the plugin\'s README).' });
		steps.createEl('li', { text: 'Select its button in the browser toolbar to open its page.' });
		steps.createEl('li', { text: 'Paste this code there and select "Pair". It works once, for 5 minutes.' });
		new Setting(contentEl)
			.setName('Pairing code')
			.setDesc(code)
			.addButton((b) =>
				b.setButtonText('Copy').onClick(async () => {
					await navigator.clipboard.writeText(code);
					b.setButtonText('Copied');
				}),
			)
			.descEl.addClass('ccs-pair-code');
		const status = contentEl.createEl('p', { cls: 'ccs-pair-status', text: 'Waiting for your browser…' });
		const started = Date.now();
		this.timer = window.setInterval(() => {
			if (server.linked) {
				status.setText('Linked. You can close this window.');
				status.addClass('is-ok');
				this.stopTimer();
				window.setTimeout(() => this.close(), 1500);
			} else if (Date.now() - started > 5 * 60_000) {
				status.setText('The code has run out. Close this window and select "Pair browser…" again.');
				this.stopTimer();
			}
		}, 500);
	}

	private stopTimer(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
	}

	onClose(): void {
		this.stopTimer();
		this.contentEl.empty();
		this.done();
	}
}

/** Login row of a Google account: the Browser link's when the account uses it. */
export function usesLinkRow(provider: Provider, account: AnyAccount): boolean {
	return provider === 'gemini' && usesBrowserLink(provider, account as GeminiAccount);
}
