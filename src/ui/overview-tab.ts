// The first thing you see: every account at a glance, and one button to sync it all.

import { Notice, setIcon } from 'obsidian';
import { accountsOf, loginRef, PROVIDER_LABEL, type AnyAccount } from '../accounts';
import { isLoggedIn, type Provider } from '../login';
import { count, type PanelContext } from './fields';
import { providerIcon } from './icons';
import { addAccountButton } from './provider-tab';

function surfaceLine(parent: HTMLElement, icon: string, name: string): { dot: HTMLElement; text: HTMLElement } {
	const line = parent.createDiv({ cls: 'ccs-surface-line' });
	setIcon(line.createSpan({ cls: 'ccs-glyph' }), icon);
	line.createSpan({ cls: 'ccs-surface-name', text: name });
	const dot = line.createSpan({ cls: 'ccs-dot' });
	const text = line.createSpan({ cls: 'ccs-surface-status', text: 'Checking…' });
	return { dot, text };
}

function accountCard(ctx: PanelContext, parent: HTMLElement, provider: Provider, account: AnyAccount): void {
	const card = parent.createDiv({ cls: 'ccs-card' });
	const head = card.createDiv({ cls: 'ccs-card-head' });
	const open = head.createEl('button', { cls: 'ccs-card-title', text: account.label, attr: { 'aria-label': `Open ${PROVIDER_LABEL[provider]} account ${account.label}` } });
	open.addEventListener('click', () => ctx.openAccount(provider, account));

	const web = surfaceLine(card, 'globe', provider === 'gemini' ? 'Gemini' : 'Web');
	const chats = Object.keys(account.web.index).length;
	const app = 'desktop' in account ? account.desktop : null;
	const studio = 'studio' in account ? account.studio : null;
	if (studio) {
		const line = surfaceLine(card, 'flask-conical', 'AI Studio');
		line.dot.toggleClass('is-on', studio.enabled);
		line.text.setText(studio.enabled ? count(Object.keys(studio.index).length, 'prompt') : 'Off');
	}
	if (app) {
		const desktop = surfaceLine(card, 'monitor', 'Desktop');
		desktop.dot.toggleClass('is-on', app.enabled);
		desktop.text.setText(app.enabled ? count(Object.keys(app.index).length, 'session') : 'Off');
	}

	const sync = head.createEl('button', { text: 'Sync', cls: 'ccs-card-sync' });
	void isLoggedIn(loginRef(provider, account)).then((ok) => {
		web.dot.toggleClass('is-on', ok);
		web.text.setText(ok ? count(chats, 'chat') : 'Not logged in');
	});
	sync.addEventListener('click', () => {
		void (async () => {
			new Notice(`${account.label}: sync starting…`);
			if (await ctx.plugin.canSyncWeb(provider, account)) await ctx.plugin.syncAccount(provider, account, 'web');
			if (app?.enabled) await ctx.plugin.syncAccount(provider, account, 'desktop');
			if (studio?.enabled && (await ctx.plugin.canSyncWeb(provider, account))) await ctx.plugin.syncAccount(provider, account, 'studio');
			ctx.refresh();
		})();
	});
}

export function overviewTab(ctx: PanelContext, el: HTMLElement): void {
	const s = ctx.plugin.settings;
	const hero = el.createDiv({ cls: 'ccs-hero' });
	const words = hero.createDiv();
	const chats = [...s.claude, ...s.chatgpt, ...s.lumo, ...s.gemini].reduce((n, a) => n + Object.keys(a.web.index).length, 0)
		+ s.gemini.reduce((n, a) => n + Object.keys(a.studio.index).length, 0);
	const sessions = [...s.claude, ...s.chatgpt].reduce((n, a) => n + Object.keys(a.desktop.index).length, 0);
	words.createDiv({ cls: 'ccs-hero-title', text: 'Sync all accounts' });
	words.createDiv({ cls: 'ccs-hero-desc', text: `${count(chats, 'chat')} and ${count(sessions, 'desktop session')} saved so far.` });
	const button = hero.createEl('button', { text: 'Sync all', cls: 'mod-cta' });
	button.addEventListener('click', () => {
		new Notice('Sync all: starting…');
		void ctx.plugin.syncAll('manual').then(ctx.refresh);
	});

	for (const provider of ['claude', 'chatgpt', 'lumo', 'gemini'] as const) {
		const head = el.createDiv({ cls: 'ccs-provider-head' });
		providerIcon(head, provider);
		head.createDiv({ cls: 'ccs-provider-name', text: PROVIDER_LABEL[provider] });
		addAccountButton(ctx, head, provider);
		const cards = el.createDiv({ cls: 'ccs-cards' });
		for (const account of accountsOf(s, provider)) accountCard(ctx, cards, provider, account);
	}
}
