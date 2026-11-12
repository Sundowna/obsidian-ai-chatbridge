// The first thing you see: every account at a glance, and one button to sync it all.

import { setIcon } from 'obsidian';
import { accountsOf, loginRef, PROVIDER_LABEL, type AnyAccount } from '../accounts';
import { isLoggedIn, type Provider } from '../login';
import { profileGone } from '../hermes/profiles';
import { bindSyncButton, count, type PanelContext } from './fields';
import { hermesIcon, providerIcon } from './icons';
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
	// One run for the whole account, so Stop ends all of it.
	bindSyncButton(ctx, sync, () => ctx.plugin.isSyncing(provider, account.id), () => void ctx.plugin.syncWholeAccount(provider, account).then(ctx.refresh));
}

/** Hermes Agent: how many agents (profiles) are on, and what they saved. Selecting the title opens its tab. */
function hermesCard(ctx: PanelContext, parent: HTMLElement): void {
	const h = ctx.plugin.settings.hermes;
	// Profiles whose state.db is gone are skipped by the sync, so they don't count as agents that are on.
	const gone = h.profiles.filter((p) => profileGone(p));
	const found = h.profiles.filter((p) => !gone.includes(p));
	const on = found.filter((p) => p.enabled);
	const saved = h.profiles.reduce((n, p) => n + Object.keys(p.index).length, 0);
	const card = parent.createDiv({ cls: 'ccs-card' });
	const head = card.createDiv({ cls: 'ccs-card-head' });
	head.createEl('button', { cls: 'ccs-card-title', text: 'This computer', attr: { 'aria-label': 'Open the Hermes settings' } })
		.addEventListener('click', () => ctx.openHermes());

	const agents = surfaceLine(card, 'bot', 'Agents');
	agents.dot.toggleClass('is-on', on.length > 0);
	const missing = gone.length ? `, ${gone.length} not found` : '';
	agents.text.setText(found.length ? `${on.length} of ${count(found.length, 'agent')} on${missing}` : gone.length ? `${count(gone.length, 'agent')} not found` : 'None found yet');
	const chats = surfaceLine(card, 'messages-square', 'Chats');
	chats.dot.toggleClass('is-on', saved > 0);
	chats.text.setText(count(saved, 'chat'));

	if (!on.length) {
		// Nothing to sync yet: the button leads to where agents are turned on.
		head.createEl('button', { text: 'Set up', cls: 'ccs-card-sync' }).addEventListener('click', () => ctx.openHermes());
		return;
	}
	const sync = head.createEl('button', { text: 'Sync', cls: 'ccs-card-sync' });
	bindSyncButton(ctx, sync, () => ctx.plugin.isSyncingHermes(), () => void ctx.plugin.syncHermes('manual').then(ctx.refresh));
}

/** "Sync all" and "Stop all" side by side: Stop is greyed out until something runs. */
function heroButtons(ctx: PanelContext, parent: HTMLElement): void {
	const { plugin } = ctx;
	const box = parent.createDiv({ cls: 'ccs-hero-actions' });
	const stop = box.createEl('button', { text: 'Stop all' });
	const sync = box.createEl('button', { text: 'Sync all', cls: 'mod-cta' });
	const draw = () => {
		const running = plugin.syncing;
		stop.disabled = !running || plugin.stopping;
		stop.setText(plugin.stopping ? 'Stopping…' : 'Stop all');
		stop.toggleClass('mod-warning', running && !plugin.stopping);
		stop.setAttr('title', running ? 'Stops after the current chat. Everything saved so far stays.' : 'Nothing is syncing');
		sync.disabled = plugin.busy;
		sync.setText(running ? 'Syncing…' : 'Sync all');
		if (plugin.busy) sync.setAttr('title', 'A sync is running');
		else sync.removeAttribute('title');
	};
	const off = plugin.onBusyChange(() => {
		if (!box.isConnected) {
			off();
			return;
		}
		draw();
	});
	stop.addEventListener('click', () => plugin.requestStop());
	sync.addEventListener('click', () => {
		if (!plugin.busy) void plugin.syncAll('manual').then(ctx.refresh);
	});
	draw();
}

export function overviewTab(ctx: PanelContext, el: HTMLElement): void {
	const s = ctx.plugin.settings;
	const hero = el.createDiv({ cls: 'ccs-hero' });
	const words = hero.createDiv();
	const chats = [...s.claude, ...s.chatgpt, ...s.lumo, ...s.gemini].reduce((n, a) => n + Object.keys(a.web.index).length, 0)
		+ s.gemini.reduce((n, a) => n + Object.keys(a.studio.index).length, 0);
	const sessions = [...s.claude, ...s.chatgpt].reduce((n, a) => n + Object.keys(a.desktop.index).length, 0);
	const hermes = s.hermes.profiles.reduce((n, p) => n + Object.keys(p.index).length, 0);
	const saved = [count(chats, 'chat'), count(sessions, 'desktop session')];
	if (hermes) saved.push(count(hermes, 'Hermes chat'));
	const list = saved.length > 2 ? `${saved.slice(0, -1).join(', ')} and ${saved[saved.length - 1]!}` : saved.join(' and ');
	words.createDiv({ cls: 'ccs-hero-title', text: 'Sync everything' });
	words.createDiv({ cls: 'ccs-hero-desc', text: `${list} saved so far.` });
	heroButtons(ctx, hero);

	for (const provider of ['claude', 'chatgpt', 'lumo', 'gemini'] as const) {
		const head = el.createDiv({ cls: 'ccs-provider-head' });
		providerIcon(head, provider);
		head.createDiv({ cls: 'ccs-provider-name', text: PROVIDER_LABEL[provider] });
		addAccountButton(ctx, head, provider);
		const cards = el.createDiv({ cls: 'ccs-cards' });
		for (const account of accountsOf(s, provider)) accountCard(ctx, cards, provider, account);
	}

	const head = el.createDiv({ cls: 'ccs-provider-head' });
	hermesIcon(head);
	head.createDiv({ cls: 'ccs-provider-name', text: 'Hermes Agent' });
	const manage = head.createEl('button', { cls: 'ccs-add-account', attr: { 'aria-label': 'Open the Hermes settings' } });
	setIcon(manage.createSpan({ cls: 'ccs-glyph' }), 'settings-2');
	manage.createSpan({ text: 'Manage agents' });
	manage.addEventListener('click', () => ctx.openHermes());
	hermesCard(ctx, el.createDiv({ cls: 'ccs-cards' }));
}
