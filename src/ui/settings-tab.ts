// The settings page: Overview, one tab per provider, General.

import { PluginSettingTab, setIcon, type App } from 'obsidian';
import type { AnyAccount } from '../accounts';
import type { Provider } from '../login';
import type AIChatBridge from '../main';
import type { PanelContext } from './fields';
import { generalTab } from './general-tab';
import { providerIcon } from './icons';
import { overviewTab } from './overview-tab';
import { forgetProjectLists } from './project-picker';
import { providerTab, type ProviderState } from './provider-tab';

type Tab = 'overview' | Provider | 'general';

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

	constructor(app: App, private readonly plugin: AIChatBridge) {
		super(app, plugin);
	}

	hide(): void {
		forgetProjectLists();
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
		else setIcon(b.createSpan({ cls: 'ccs-glyph' }), id === 'overview' ? 'layout-dashboard' : 'sliders-horizontal');
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
		this.tabButton(bar, 'general', 'General');

		const ctx: PanelContext = {
			app: this.app,
			plugin: this.plugin,
			refresh: () => this.display(),
			openAccount: (provider: Provider, account: AnyAccount) => {
				this.providers[provider].accountId = account.id;
				this.go(provider);
			},
			openSections: this.openSections,
		};
		const body = containerEl.createDiv({ cls: 'ccs-body' });
		if (this.tab === 'overview') overviewTab(ctx, body);
		else if (this.tab === 'general') generalTab(ctx, body);
		else providerTab(ctx, body, this.tab, this.providers[this.tab]);
		containerEl.scrollTop = scroll;
	}
}
