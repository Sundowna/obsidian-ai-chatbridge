// The settings page: Overview, one tab per provider, General.

import { PluginSettingTab, setIcon, type App } from 'obsidian';
import type { AnyAccount } from '../accounts';
import type { Provider } from '../login';
import type AIChatBridge from '../main';
import type { PanelContext } from './fields';
import { generalTab } from './general-tab';
import { errorLogsTab, type ErrorLogsState } from './error-logs-tab';
import { onErrorLogChange } from '../error-log';
import { hermesTab } from './hermes-tab';
import { memoryTab } from './memory-tab';
import { hermesIcon, providerIcon } from './icons';
import { overviewTab } from './overview-tab';
import { forgetProjectLists } from './project-picker';
import { providerTab, type ProviderState } from './provider-tab';

type Tab = 'overview' | Provider | 'hermes' | 'memory' | 'general' | 'errors';

export class AIChatBridgeSettingTab extends PluginSettingTab {
	/** Where you are; kept while the settings window is open. */
	private tab: Tab = 'overview';
	private readonly providers: Record<Provider, ProviderState> = {
		claude: { accountId: '', surface: 'web' },
		chatgpt: { accountId: '', surface: 'web' },
		lumo: { accountId: '', surface: 'web' },
		gemini: { accountId: '', surface: 'web' },
	};
	private readonly openSections = new Set<string>();
	private readonly errorLogs: ErrorLogsState = { key: '' };
	/** Redraws the Error logs tab when an error arrives while it is open. */
	private stopWatching: (() => void) | null = null;

	constructor(app: App, private readonly plugin: AIChatBridge) {
		super(app, plugin);
	}

	hide(): void {
		forgetProjectLists();
		this.stopWatching?.();
		this.stopWatching = null;
		super.hide();
	}

	private go(tab: Tab): void {
		this.tab = tab;
		this.display();
		this.containerEl.scrollTop = 0;
	}

	private tabButton(bar: HTMLElement, id: Tab, label: string): void {
		const active = id === this.tab;
		const b = bar.createEl('button', { cls: 'ccs-tab', attr: { role: 'tab', 'aria-selected': String(active) } });
		b.toggleClass('is-active', active);
		if (id === 'claude' || id === 'chatgpt' || id === 'lumo' || id === 'gemini') providerIcon(b, id);
		else if (id === 'hermes') hermesIcon(b);
		else setIcon(b.createSpan({ cls: 'ccs-glyph' }), id === 'overview' ? 'layout-dashboard' : id === 'memory' ? 'brain' : id === 'errors' ? 'bug' : 'sliders-horizontal');
		b.createSpan({ text: label });
		b.addEventListener('click', () => this.go(id));
	}

	display(): void {
		const { containerEl } = this;
		const scroll = containerEl.scrollTop;
		containerEl.empty();
		containerEl.addClass('ccs-settings');

		const bar = containerEl.createDiv({ cls: 'ccs-tabs', attr: { role: 'tablist' } });
		this.tabButton(bar, 'overview', 'Overview');
		this.tabButton(bar, 'claude', 'Claude');
		this.tabButton(bar, 'chatgpt', 'ChatGPT');
		this.tabButton(bar, 'lumo', 'Lumo');
		this.tabButton(bar, 'gemini', 'Gemini');
		this.tabButton(bar, 'hermes', 'Hermes');
		this.tabButton(bar, 'memory', 'Memory');
		this.tabButton(bar, 'general', 'General');
		this.tabButton(bar, 'errors', 'Error logs');

		const ctx: PanelContext = {
			app: this.app,
			plugin: this.plugin,
			refresh: () => this.display(),
			openAccount: (provider: Provider, account: AnyAccount) => {
				this.providers[provider].accountId = account.id;
				this.go(provider);
			},
			openHermes: () => this.go('hermes'),
			openSections: this.openSections,
		};
		const body = containerEl.createDiv({ cls: 'ccs-body' });
		if (this.tab === 'overview') overviewTab(ctx, body);
		else if (this.tab === 'general') generalTab(ctx, body);
		else if (this.tab === 'hermes') hermesTab(ctx, body);
		else if (this.tab === 'memory') memoryTab(ctx, body);
		else if (this.tab === 'errors') errorLogsTab(ctx, body, this.errorLogs);
		else providerTab(ctx, body, this.tab, this.providers[this.tab]);
		containerEl.scrollTop = scroll;
		this.stopWatching?.();
		let pending = false;
		this.stopWatching = this.tab === 'errors'
			? onErrorLogChange(() => {
				if (pending) return;
				pending = true;
				window.setTimeout(() => {
					pending = false;
					if (this.tab === 'errors') this.display();
				}, 1000);
			})
			: null;
	}
}
