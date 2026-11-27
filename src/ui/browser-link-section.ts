// Browser link in the settings: the login method choice, the browser an account uses, the login
// row of an account that uses the link, and the pairing window. Several browsers (or browser
// profiles) can be paired, each with its own name; the link itself lives in link/.

import { Modal, Notice, Platform, Setting, type App } from 'obsidian';
import { loginRef, type AnyAccount } from '../accounts';
import { LINK_STATE_TEXT, linkState, readTokens, usesBrowserLink, type LinkState, type LoginMethod } from '../link/account';
import { isLoggedIn, type Provider } from '../login';
import type AIChatBridge from '../main';
import type { GeminiAccount } from '../settings';
import { lastRunLine, runKey } from '../last-run';
import { LINK_OPEN_PATH } from '../link/sites';
import { bindSyncButton, type PanelContext } from './fields';
import { forgetLogin } from '../login-check';

/** Opens the extension's page in your default browser (through a small page on 127.0.0.1). */
export async function openInBrowser(plugin: AIChatBridge): Promise<boolean> {
	await plugin.updateBrowserLink();
	const port = plugin.browserLink.server?.port;
	if (!port) {
		new Notice('Browser link: choose "Browser link" as the login method of an account first.');
		return false;
	}
	const url = `http://127.0.0.1:${port}${LINK_OPEN_PATH}`;
	// The system's default browser, not Obsidian's own web viewer (which would catch window.open
	// and show the page in an Obsidian tab, where no extension runs).
	const shell = (window as unknown as { electron?: { remote?: { shell?: { openExternal(u: string): Promise<void> } } } }).electron?.remote?.shell
		?? (window as unknown as { require?: (m: string) => { shell?: { openExternal(u: string): Promise<void> } } }).require?.('electron')?.shell;
	if (shell) await shell.openExternal(url);
	else window.open(url);
	return true;
}

/** The paired browsers on this computer, by ID, with their names. */
export function pairedBrowsers(plugin: AIChatBridge): { id: string; name: string }[] {
	const names = plugin.browserNames();
	return Object.keys(readTokens(plugin.linkTokens().get())).map((id, i) => ({ id, name: names[id] || (id === 'default' ? 'Browser (paired before names)' : `Browser ${i + 1}`) }));
}

/** The browser an account uses, if it names one that is still paired. */
function accountBrowser(plugin: AIChatBridge, account?: { web: { linkBrowser?: string } }): string | undefined {
	const b = account?.web.linkBrowser;
	return b && pairedBrowsers(plugin).some((p) => p.id === b) ? b : undefined;
}

/** The link as it stands now, for one account's browser or (without one) for any browser. */
export function browserLinkState(plugin: AIChatBridge, account?: { web: { linkBrowser?: string } }): LinkState {
	const b = accountBrowser(plugin, account);
	if (b) return plugin.browserLink.server?.isLinked(b) ? 'linked' : 'browser-closed';
	if (account?.web.linkBrowser) return 'not-paired'; // its browser was unpaired
	return linkState(plugin.browserLink.server, pairedBrowsers(plugin).length > 0);
}

const SHORT: Record<LinkState, string> = { 'not-paired': 'Browser not paired', 'browser-closed': 'Browser closed', linked: '' };

/**
 * Whether an account can sync now, for the Overview card and the account pills: its login
 * window, or (Browser link) whether the browser is linked. `text` replaces "Not logged in".
 */
export async function accountReady(plugin: AIChatBridge, provider: Provider, account: AnyAccount): Promise<{ ok: boolean; text: string }> {
	if (usesBrowserLink(provider, account as GeminiAccount)) {
		const s = browserLinkState(plugin, account as GeminiAccount);
		return { ok: s === 'linked', text: SHORT[s] };
	}
	return { ok: await isLoggedIn(loginRef(provider, account)), text: 'Not logged in' };
}

const METHOD_TEXT: Partial<Record<Provider, string>> = {
	gemini: 'Google blocks sign-in inside apps, so for Google accounts the Browser link is the reliable way: the sync uses your own browser, where you are already logged in. It needs the ChatBridge extension in Chrome, Edge or Brave, and the browser open while syncing. Used for Gemini and AI Studio.',
	claude: 'Made your claude.ai account with "Continue with Google"? Google blocks that sign-in inside apps, so choose the Browser link: the sync uses your own browser, where you are already logged in. It needs the ChatBridge extension in Chrome, Edge or Brave, and the browser open while syncing.',
	chatgpt: 'Made your ChatGPT account with "Continue with Google"? Google blocks that sign-in inside apps, so choose the Browser link: the sync uses your own browser, where you are already logged in. It needs the ChatBridge extension in Chrome, Edge or Brave, and the browser open while syncing.',
};

/** Login method of an account: the login window or the Browser link. Computers only; not for Lumo. */
export function loginMethodSetting(ctx: PanelContext, el: HTMLElement, provider: Provider, account: { web: { loginMethod?: LoginMethod; linkBrowser?: string } }): void {
	const text = METHOD_TEXT[provider];
	if (!Platform.isDesktopApp || !text) return;
	new Setting(el)
		.setName('Login method')
		.setDesc(text)
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
	// The login this account was first synced with: a sync with another one is skipped.
	const web = account.web as { loginUser?: string; loginEmail?: string; userId?: string };
	const bound = provider === 'gemini' ? web.userId : web.loginUser;
	if (bound) {
		new Setting(el)
			.setName('Login check')
			.setDesc(`This account belongs to ${web.loginEmail ?? 'the login it was first synced with'}. A sync that finds another login (in the browser or the login window) is skipped and says who is logged in. Switched on purpose? Accept the current login; the next sync takes it.`)
			.addButton((b) => b.setButtonText('Accept this login').onClick(async () => {
				if (provider === 'gemini') delete web.userId;
				forgetLogin(web);
				await ctx.plugin.saveSettings();
				new Notice('The next sync takes the login it finds for this account.');
				ctx.refresh();
			}));
	}
	if (account.web.loginMethod !== 'browser') return;
	// Personal and work in one browser cannot both be logged in at once (claude.ai, ChatGPT): give
	// each its own browser or browser profile, pair each, and choose it here.
	const browsers = pairedBrowsers(ctx.plugin);
	const server = ctx.plugin.browserLink.server;
	new Setting(el)
		.setName('Browser')
		.setDesc('Which paired browser this account uses. For a personal and a work account on the same site, use two browsers or two browser profiles (each with the extension, each paired), and choose one here for each account. "Any" takes whichever is connected.')
		.addDropdown((d) => {
			d.addOption('', 'Any connected browser');
			for (const b of browsers) d.addOption(b.id, `${b.name}${server?.isLinked(b.id) ? ' (connected)' : ''}`);
			if (account.web.linkBrowser && !browsers.some((b) => b.id === account.web.linkBrowser)) d.addOption(account.web.linkBrowser, 'A browser that is no longer paired');
			d.setValue(account.web.linkBrowser ?? '').onChange(async (v) => {
				if (v) account.web.linkBrowser = v;
				else delete account.web.linkBrowser;
				await ctx.plugin.saveSettings();
				ctx.refresh();
			});
		});
}

/** The login row of an account that uses the Browser link: the link's state and what to do next. */
export function linkLoginRow(ctx: PanelContext, el: HTMLElement, provider: Provider, account: AnyAccount, note: () => string, surface: 'web' | 'studio' = 'web'): void {
	const { plugin } = ctx;
	const state = browserLinkState(plugin, account as GeminiAccount);
	const own = accountBrowser(plugin, account as GeminiAccount);
	const ownName = own ? pairedBrowsers(plugin).find((b) => b.id === own)?.name : undefined;
	const extra = `${ownName ? `Browser: ${ownName}.` : ''}${note() ? ` ${note()}` : ''}`.trim();
	const row = new Setting(el).setName('Login').setDesc(`${LINK_STATE_TEXT[state]}${extra ? ` ${extra}` : ''}`);
	row.settingEl.addClass('ccs-primary-row');
	row.settingEl.dataset.linkState = state;
	lastRunLine(row.infoEl, plugin.settings.lastRuns[runKey(surface, provider, account.id)]);
	if (state !== 'not-paired') {
		row.addButton((b) =>
			b.setButtonText('Unpair').onClick(() => {
				const server = plugin.browserLink.server;
				// Only this account's browser; without one chosen, every paired browser.
				if (server) server.unpair(own);
				else if (own) {
					const tokens = readTokens(plugin.linkTokens().get());
					delete tokens[own];
					plugin.linkTokens().set(Object.keys(tokens).length ? JSON.stringify(tokens) : null);
				} else plugin.linkTokens().set(null);
				new Notice(own ? `Browser link: ${ownName ?? 'this browser'} unpaired.` : 'Browser link: unpaired. Syncs through your browser stop until you pair again.');
				ctx.refresh();
			}),
		);
	}
	row.addButton((b) =>
		b.setButtonText('Open in browser')
			.setTooltip("Opens the extension's page in your default browser, which also starts the browser")
			.onClick(() => void openInBrowser(plugin)),
	);
	if (state !== 'linked') {
		row.addButton((b) => {
			b.setButtonText(state === 'not-paired' ? 'Pair browser…' : 'Pair again…').onClick(() => new PairBrowserModal(ctx.app, plugin, ctx.refresh, account as GeminiAccount).open());
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

	/** `account`: the account the window was opened from; the browser paired now becomes its browser. */
	constructor(app: App, private readonly plugin: AIChatBridge, private readonly done: () => void, private readonly account?: { web: { linkBrowser?: string } }) {
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
		const before = new Set(server.pairedBrowsers());
		const linkedBefore = new Set(server.linkedBrowsers());
		const suggested = this.account?.web.linkBrowser ? this.plugin.browserNames()[this.account.web.linkBrowser] : undefined;
		this.plugin.pendingBrowserName = suggested ?? `Browser ${before.size + 1}`;
		new Setting(contentEl)
			.setName('Name of this browser')
			.setDesc('So you can tell your browsers apart, e.g. "Chrome personal" or "Edge work".')
			.addText((t) => t.setValue(this.plugin.pendingBrowserName ?? '').onChange((v) => { this.plugin.pendingBrowserName = v.trim() || null; }));
		const code = server.newPairingCode();
		const steps = contentEl.createEl('ol');
		steps.createEl('li', { text: 'Install the ChatBridge extension in your browser (see "Browser link" in the plugin\'s README).' });
		steps.createEl('li', { text: 'Select "Open in browser" below: the extension\'s page opens there.' });
		steps.createEl('li', { text: 'Paste this code there and press Enter. It works once, for 5 minutes.' });
		new Setting(contentEl)
			.setName('Extension page')
			.setDesc('Opens in your default browser. Keep that browser open while Obsidian syncs.')
			.addButton((b) => b.setButtonText('Open in browser').setCta().onClick(() => void openInBrowser(this.plugin)));
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
			const added = server.pairedBrowsers().find((b) => !before.has(b) && server.isLinked(b));
			// Paired again from the same browser: its ID stays, it just comes back.
			const mine = this.account?.web.linkBrowser;
			const again = mine && !linkedBefore.has(mine) && server.isLinked(mine) ? mine : undefined;
			if (added || again || (!this.account?.web.linkBrowser && server.linkedBrowsers().some((b) => !linkedBefore.has(b)))) {
				if (added && this.account) {
					this.account.web.linkBrowser = added;
					void this.plugin.saveSettings();
				}
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
	return usesBrowserLink(provider, account as GeminiAccount);
}
