// A provider's tab: pick an account, then its Web or Desktop side.

import { Notice, setIcon } from 'obsidian';
import { accountsOf, addAccount, loginRef, nameProblem, PROVIDER_LABEL, removeAccount, SITE_LABEL, type AnyAccount, type DesktopAccount } from '../accounts';
import { isLoggedIn, logout, type Provider } from '../login';
import type { Surface } from '../main';
import type { ChatgptAccount, ClaudeAccount, GeminiAccount, LumoAccount } from '../settings';
import { desktopPanel } from './desktop-panel';
import type { PanelContext } from './fields';
import { providerIcon } from './icons';
import { ConfirmModal, NameModal } from './modals';
import { chatgptWebPanel, claudeWebPanel, geminiWebPanel, lumoWebPanel, studioPanel } from './web-panel';

export interface ProviderState {
	accountId: string;
	surface: Surface;
}

function addAccountDialog(ctx: PanelContext, provider: Provider): void {
	const list = accountsOf(ctx.plugin.settings, provider);
	new NameModal(ctx.app, {
		title: `Add a ${PROVIDER_LABEL[provider]} account`,
		hint: `A name for telling your accounts apart, such as "Work". The account gets its own login and saves into the same folders as your other accounts; each note says which account it came from (account: in its properties).`,
		action: 'Add account',
		problem: (name) => nameProblem(list, name),
		submit: async (name) => {
			const account = addAccount(ctx.plugin.settings, provider, name);
			await ctx.plugin.saveSettings();
			ctx.openAccount(provider, account);
		},
	}).open();
}

export function addAccountButton(ctx: PanelContext, parent: HTMLElement, provider: Provider): void {
	const add = parent.createEl('button', { cls: 'ccs-add-account', attr: { 'aria-label': `Add a ${PROVIDER_LABEL[provider]} account` } });
	setIcon(add.createSpan({ cls: 'ccs-glyph' }), 'plus');
	add.createSpan({ text: 'Add account' });
	add.addEventListener('click', () => addAccountDialog(ctx, provider));
}

function accountHeader(ctx: PanelContext, el: HTMLElement, provider: Provider, account: AnyAccount, list: AnyAccount[]): void {
	const head = el.createDiv({ cls: 'ccs-account-head' });
	providerIcon(head, provider);
	head.createDiv({ cls: 'ccs-account-name', text: account.label });
	const actions = head.createDiv({ cls: 'ccs-account-actions' });
	actions.createEl('button', { text: 'Rename' }).addEventListener('click', () => {
		new NameModal(ctx.app, {
			title: 'Rename account',
			hint: 'Only changes the name shown here. Folders stay as they are.',
			action: 'Rename',
			initial: account.label,
			problem: (name) => nameProblem(list, name, account),
			submit: async (name) => {
				account.label = name;
				await ctx.plugin.saveSettings();
				ctx.refresh();
			},
		}).open();
	});
	if (list.length < 2) return;
	actions.createEl('button', { text: 'Remove' }).addEventListener('click', () => {
		new ConfirmModal(
			ctx.app,
			`Remove "${account.label}"?`,
			`This logs the account out and forgets its sync history. Chats already saved stay in your vault, but adding the account again would save them a second time.`,
			'Remove account',
			async () => {
				try {
					await logout(loginRef(provider, account));
				} catch (e) {
					new Notice(`${SITE_LABEL[provider]}: ${e instanceof Error ? e.message : String(e)}`);
				}
				removeAccount(ctx.plugin.settings, provider, account);
				await ctx.plugin.saveSettings();
				ctx.refresh();
			},
		).open();
	});
}

export function providerTab(ctx: PanelContext, el: HTMLElement, provider: Provider, state: ProviderState): void {
	const list = accountsOf(ctx.plugin.settings, provider);
	const account = list.find((a) => a.id === state.accountId) ?? list[0]!;

	const pills = el.createDiv({ cls: 'ccs-account-pills', attr: { role: 'tablist', 'aria-label': `${PROVIDER_LABEL[provider]} accounts` } });
	for (const a of list) {
		const pill = pills.createEl('button', { cls: 'ccs-account-pill', attr: { role: 'tab', 'aria-selected': String(a === account) } });
		pill.toggleClass('is-active', a === account);
		const dot = pill.createSpan({ cls: 'ccs-dot' });
		pill.createSpan({ text: a.label });
		void isLoggedIn(loginRef(provider, a)).then((ok) => dot.toggleClass('is-on', ok));
		pill.addEventListener('click', () => {
			state.accountId = a.id;
			ctx.refresh();
		});
	}
	addAccountButton(ctx, pills, provider);

	accountHeader(ctx, el, provider, account, list);

	// Lumo is a website only, so there is no Web / Desktop choice.
	if (provider === 'lumo') {
		lumoWebPanel(ctx, el, account as LumoAccount);
		return;
	}

	// One Google login has two places with chats: Gemini and AI Studio.
	const surfaces: [Surface, string, string][] = provider === 'gemini'
		? [['web', 'message-circle', 'Chat'], ['studio', 'flask-conical', 'AI Studio']]
		: [['web', 'globe', 'Web'], ['desktop', 'monitor', 'Desktop app']];
	if (provider === 'gemini' && state.surface === 'desktop') state.surface = 'web';
	if (provider !== 'gemini' && state.surface === 'studio') state.surface = 'web';
	const seg = el.createDiv({ cls: 'ccs-segmented', attr: { role: 'tablist', 'aria-label': 'Surface' } });
	for (const [id, icon, text] of surfaces) {
		const b = seg.createEl('button', { cls: 'ccs-segment', attr: { role: 'tab', 'aria-selected': String(id === state.surface) } });
		b.toggleClass('is-active', id === state.surface);
		setIcon(b.createSpan({ cls: 'ccs-glyph' }), icon);
		b.createSpan({ text });
		b.addEventListener('click', () => {
			state.surface = id;
			ctx.refresh();
		});
	}

	if (provider === 'gemini') {
		if (state.surface === 'studio') studioPanel(ctx, el, account as GeminiAccount);
		else geminiWebPanel(ctx, el, account as GeminiAccount);
	} else if (state.surface === 'desktop') desktopPanel(ctx, el, provider, account as DesktopAccount, list as DesktopAccount[]);
	else if (provider === 'claude') claudeWebPanel(ctx, el, account as ClaudeAccount);
	else chatgptWebPanel(ctx, el, account as ChatgptAccount);
}
