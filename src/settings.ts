import { App, normalizePath, Notice, PluginSettingTab, SecretComponent, Setting, TextComponent } from 'obsidian';
import { BROWSE_MESSAGES, browseForVaultFolder } from './folder-dialog';
import type AIChatBridge from './main';
import type { IndexEntry } from './types';
import { isUuid } from './schema';
import { FolderSuggest } from './folder-suggest';
import { Account, isLoggedIn, logout, openLogin } from './login';
import type { AssetRetry, Capture } from './chatgpt/recovery';
import { DEFAULT_OVERLAP_MINUTES, type Inventories } from './chatgpt/inventory';
import type { ChatCounts } from './progress';
import type { DesktopAppSettings, DesktopSettings } from './desktop/types';
import { claudeHome, codexHome, defaultRoots, nodeDesktopFs } from './desktop/scan';
import { folderExists, layoutMoves } from './desktop/layout';

/** A usable vault folder path, or null (empty, root, or inside a hidden folder like .obsidian). */
export function cleanFolder(v: string): string | null {
	const p = normalizePath(v.trim());
	if (!p || p === '/' || p.split('/').some((part) => part.startsWith('.'))) return null;
	return p;
}

/** ChatGPT settings and index – their own namespace, so they never mix with claude.ai's. */
export interface GptSettings {
	folder: string;
	projectSubfolders: boolean;
	recentFolderName: string;
	downloadFiles: boolean;
	onlyProjects: boolean;
	projects: string[];
	index: Record<string, IndexEntry>;
	fileIndex: Record<string, string>;
	includeArchived?: boolean;
	cooldownUntil?: number;
	resumeAfter429?: { consecutive: number; forceFull: boolean } | null;
	assetRetries?: Record<string, AssetRetry>;
	pendingCaptures?: Record<string, Capture>;
	inventories?: Inventories;
	overlapMinutes?: number;
	chatProgress?: ChatCounts & { inventoryKey: string; scope: string };
}

// Everything here is saved in data.json, which syncs with the vault.
// So: NO secrets. Logins live in the login windows' own storage; the fallback session
// key lives in Obsidian's secret storage – we only store the *name* of that secret (secretId).
export interface Settings {
	orgId: string;
	secretId: string;
	onlyProjects: boolean;
	projects: string[];
	maxChatsPerRun: number;
	delaySeconds: number;
	intervalMinutes: number;
	/** Folder for normal claude.ai chats (platform CLAUDE_AI). */
	chatFolder: string;
	/** Folder for Claude Code sessions (any other platform). */
	codeFolder: string;
	/** Put each chat in a subfolder named after its claude.ai project. */
	projectSubfolders: boolean;
	/** Subfolder for chats without a project (claude.ai's "Recents"). */
	recentFolderName: string;
	/** Also download the files listed in a chat (Artifacts/ and Attachments/ next to the chat). */
	downloadFiles: boolean;
	logPath: string;
	index: Record<string, IndexEntry>;
	/** file_uuid -> vault path, so each file is downloaded once. */
	fileIndex: Record<string, string>;
	gpt: GptSettings;
	/** Sessions saved on this computer by the Claude and ChatGPT/Codex desktop apps. */
	desktop: DesktopSettings;
}

export const DEFAULT_GPT: GptSettings = {
	folder: 'AI Chats/ChatGPT Desktop/Chat',
	projectSubfolders: true,
	recentFolderName: 'Recent',
	downloadFiles: true,
	onlyProjects: false,
	projects: [],
	index: {},
	fileIndex: {},
};

const desktopApp = (folder: string): DesktopAppSettings => ({ enabled: true, folder, extraFolders: [], index: {} });

export const DEFAULT_DESKTOP: DesktopSettings = {
	claude: desktopApp('AI Chats/Claude Desktop/Code'),
	codex: desktopApp('AI Chats/ChatGPT Desktop/Codex'),
	projectSubfolders: true,
	keepRaw: false,
	quietMinutes: 15,
	includeSubagents: false,
};

export const DEFAULT_SETTINGS: Settings = {
	orgId: '',
	secretId: '',
	onlyProjects: false,
	projects: [],
	maxChatsPerRun: 3,
	delaySeconds: 1.5,
	intervalMinutes: 0,
	chatFolder: 'AI Chats/Claude Desktop/Chat',
	codeFolder: 'AI Chats/Claude Desktop/Code',
	projectSubfolders: true,
	recentFolderName: 'Recent',
	downloadFiles: true,
	logPath: 'AI Chats/AI ChatBridge log.md',
	index: {},
	fileIndex: {},
	gpt: DEFAULT_GPT,
	desktop: DEFAULT_DESKTOP,
};

export const MIN_DELAY_SECONDS = 1;
export const MIN_INTERVAL_MINUTES = 30;

type Tab = 'claude' | 'openai' | 'desktop';

export class AIChatBridgeSettingTab extends PluginSettingTab {
	/** Which provider tab is open (kept while the settings window is open). */
	private tab: Tab = 'claude';

	constructor(
		app: App,
		private readonly plugin: AIChatBridge,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 1. Logins, each with its own sync button, then "Sync all".
		new Setting(containerEl).setName('Accounts').setHeading();
		this.accountSetting('claude', 'claude.ai', () => this.plugin.sync('manual'));
		this.accountSetting('chatgpt', 'ChatGPT', () => this.plugin.syncGpt('manual'));
		this.syncAllSetting();
		this.generalSettings();

		// 2. Tabs with each provider's own settings.
		const bar = containerEl.createDiv({ cls: 'ccs-tabs' });
		const tabs: [Tab, string][] = [
			['claude', 'Claude'],
			['openai', 'OpenAI'],
			['desktop', 'Desktop apps'],
		];
		for (const [id, label] of tabs) {
			const btn = bar.createEl('button', { text: label, cls: 'ccs-tab' });
			if (id === this.tab) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				this.tab = id;
				this.display();
			});
		}
		if (this.tab === 'claude') this.claudeSettings();
		else if (this.tab === 'openai') this.openaiSettings();
		else this.desktopSettings();
	}

	/** Log in / Log out / Sync for one provider. `sync` null = not available yet. */
	private accountSetting(account: Account, label: string, sync: (() => Promise<void>) | null): void {
		const row = new Setting(this.containerEl).setName(label).setDesc('Checking…');
		void isLoggedIn(account).then((ok) => {
			row.setDesc(ok ? 'Logged in. Stored by Obsidian outside the vault.' : 'Not logged in. Select "Log in" and sign in as usual in the window that opens.');
		});
		row.addButton((b) =>
			b.setButtonText('Log in').onClick(async () => {
				try {
					const r = await openLogin(account);
					new Notice(r === 'logged-in' || (await isLoggedIn(account)) ? `${label}: logged in.` : `${label}: window closed, no login found.`);
				} catch (e) {
					new Notice(`${label}: ${e instanceof Error ? e.message : String(e)}`, 10_000);
				}
				this.display();
			}),
		);
		row.addButton((b) =>
			b.setButtonText('Log out').onClick(async () => {
				await logout(account);
				new Notice(`${label}: logged out (login removed from this computer).`);
				this.display();
			}),
		);
		row.addButton((b) => {
			b.setButtonText('Sync');
			if (!sync) {
				b.setDisabled(true).setTooltip('ChatGPT sync is not built yet');
				return;
			}
			b.setCta().onClick(() => {
				new Notice(`${label}: sync starting…`);
				void sync().then(() => this.display());
			});
		});
	}

	private syncAllSetting(): void {
		const s = this.plugin.settings;
		new Setting(this.containerEl)
			.setName('Sync all')
			.setDesc(`Every provider you are logged in to, plus the desktop apps that are on. Synced so far: ${Object.keys(s.index).length} claude.ai chats, ${Object.keys(s.gpt.index).length} ChatGPT chats, ${Object.keys(s.desktop.claude.index).length + Object.keys(s.desktop.codex.index).length} desktop sessions.`)
			.addButton((b) =>
				b.setButtonText('Sync all').setCta().onClick(() => {
					new Notice('Sync all: starting…');
					void this.plugin.syncAll('manual').then(() => this.display());
				}),
			);
	}

	/** Settings that apply to every provider. */
	private generalSettings(): void {
		const s = this.plugin.settings;
		const el = this.containerEl;
		new Setting(el)
			.setName('Max chats per run')
			.setDesc('Per provider. 0 = no limit. Keep small while testing.')
			.addText((t) =>
				t.setValue(String(s.maxChatsPerRun)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isInteger(n) || n < 0) return;
					s.maxChatsPerRun = n;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(el)
			.setName('Delay between requests (seconds)')
			.setDesc(`Minimum ${MIN_DELAY_SECONDS}.`)
			.addText((t) =>
				t.setValue(String(s.delaySeconds)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isFinite(n) || n < MIN_DELAY_SECONDS) return;
					s.delaySeconds = n;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(el)
			.setName('Automatic sync every … minutes')
			.setDesc(`Runs "Sync all". 0 = off. Minimum ${MIN_INTERVAL_MINUTES}. Pauses itself after an error until you sync by hand.`)
			.addText((t) =>
				t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isInteger(n) || (n !== 0 && n < MIN_INTERVAL_MINUTES)) return;
					s.intervalMinutes = n;
					await this.plugin.saveSettings();
					this.plugin.restartTimer();
				}),
			);
	}

	private claudeSettings(): void {
		const s = this.plugin.settings;
		const el = this.containerEl;
		new Setting(el)
			.setName('Session key (fallback)')
			.setDesc('Only needed if the login window does not work: your claude.ai "sessionKey" cookie, kept in Obsidian\'s secret storage on this computer (not in the vault, not in data.json). The login window wins if both are set.')
			.addComponent((c) =>
				new SecretComponent(this.app, c).setValue(s.secretId).onChange(async (v) => {
					s.secretId = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(el)
			.setName('Organization ID')
			.setDesc('The ID after /api/organizations/ in claude.ai\'s requests. Not secret. Filled in automatically from the login if empty.')
			.addText((t) =>
				t.setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx').setValue(s.orgId).onChange(async (v) => {
					const id = v.trim();
					if (id && !isUuid(id)) return; // ignore until it looks like an ID
					s.orgId = id;
					await this.plugin.saveSettings();
				}),
			);
		this.folderSetting('Claude Chat folder', 'Where normal claude.ai chats are saved. Created if missing.', () => s.chatFolder, (p) => (s.chatFolder = p));
		this.folderSetting(
			'Claude Code folder',
			'Where Claude Code sessions are saved, if claude.ai lists any (chats whose platform is not "CLAUDE_AI").',
			() => s.codeFolder,
			(p) => (s.codeFolder = p),
		);
		this.folderOptions('claude.ai', s);
	}

	private openaiSettings(): void {
		const g = this.plugin.settings.gpt;
		this.folderSetting('ChatGPT folder', 'Where ChatGPT chats are saved. Created if missing.', () => g.folder, (p) => (g.folder = p));
		this.folderOptions('ChatGPT', g);
		new Setting(this.containerEl)
			.setName('Incremental sync overlap (minutes)')
			.setDesc('Check recent changes again on each run. A full inventory runs on the next sync after seven days.')
			.addText((input) => input.setValue(String(g.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES)).onChange(async (value) => {
				const minutes = Number(value);
				if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return;
				g.overlapMinutes = minutes;
				await this.plugin.saveSettings();
			}));
		new Setting(this.containerEl)
			.setName('Include archived chats')
			.setDesc('Also check archived conversations during sync.')
			.addToggle((toggle) => toggle.setValue(g.includeArchived ?? false).onChange(async (value) => {
				g.includeArchived = value;
				await this.plugin.saveSettings();
			}));
		new Setting(this.containerEl)
			.setName('Retry missing files')
			.setDesc('Make delayed downloads eligible on the next sync. The account cooldown still applies.')
			.addButton((button) => button.setButtonText('Reset file delays').onClick(async () => {
				const retries = g.assetRetries ?? {};
				for (const id of Object.keys(retries)) delete retries[id];
				await this.plugin.saveSettings();
				new Notice('File delays reset for the next sync.');
			}));
	}

	private desktopSettings(): void {
		const d = this.plugin.settings.desktop;
		const el = this.containerEl;
		const save = () => this.plugin.saveSettings();
		const fs = nodeDesktopFs();
		new Setting(el)
			.setName('Sync desktop apps')
			.setDesc('Chats that exist only on this computer. Only reads the apps’ files; nothing outside the vault is changed. Regular claude.ai and ChatGPT chats come from the accounts above.')
			.addButton((b) =>
				b.setButtonText('Sync').setCta().onClick(() => {
					new Notice('Desktop apps: sync starting…');
					void this.plugin.syncDesktop('manual').then(() => this.display());
				}),
			);
		const s = this.plugin.settings;
		const moves = layoutMoves(s, folderExists(this.app));
		const layout = new Setting(el)
			.setName('App layout')
			.setDesc(
				moves.length
					? `Move the synced chats so each app has one folder with Chat and Code inside, like the apps: ${moves.map((m) => `${m.label}: ${m.from} → ${m.to}`).join('; ')}. Uses Obsidian's own move, so links and the sync index follow.`
					: 'The folders follow the app layout: Claude Desktop/Chat and /Code, ChatGPT Desktop/Chat and /Codex.',
			);
		if (moves.length) {
			layout.addButton((b) =>
				b.setButtonText('Move now').setWarning().onClick(() => {
					void this.plugin.moveToAppLayout().then(() => this.display());
				}),
			);
		}
		const apps: { conf: DesktopAppSettings; heading: string; what: string; home: string; chat: [() => string, (p: string) => void] }[] = [
			{ conf: d.claude, heading: 'Claude', what: 'Claude Code sessions from the Claude desktop app (Code tab) and the Claude Code CLI, in subfolders named after your sidebar groups (or the working folder)', home: fs ? claudeHome(fs) : '~/.claude', chat: [() => s.chatFolder, (p) => (s.chatFolder = p)] },
			{ conf: d.codex, heading: 'ChatGPT', what: 'Codex threads from the ChatGPT/Codex desktop app and the Codex CLI, in subfolders named after their project (or Recent)', home: fs ? codexHome(fs) : '~/.codex', chat: [() => s.gpt.folder, (p) => (s.gpt.folder = p)] },
		];
		for (const { conf, heading, what, home, chat } of apps) {
			new Setting(el).setName(heading).setHeading();
			this.folderSetting(`${heading} chat folder`, `Where ${heading === 'Claude' ? 'claude.ai' : 'ChatGPT'} chats are saved (Recent/ and one folder per project). Same setting as on the ${heading === 'Claude' ? 'Claude' : 'OpenAI'} tab.`, chat[0], chat[1]);
			const roots = fs ? defaultRoots(fs, conf === d.claude ? 'claude' : 'codex') : [home];
			new Setting(el)
				.setName(`Sync ${heading} desktop sessions`)
				.setDesc(`${what}. Read from ${roots.join(' and ')}. ${Object.keys(conf.index).length} synced so far.`)
				.addToggle((t) =>
					t.setValue(conf.enabled).onChange(async (v) => {
						conf.enabled = v;
						await save();
					}),
				);
			this.folderSetting(`${heading} ${heading === 'Claude' ? 'Code' : 'Codex'} folder`, 'Where these sessions are saved. Created if missing.', () => conf.folder, (p) => (conf.folder = p));
			new Setting(el)
				.setName('Extra session folders')
				.setDesc('Optional. One folder on this computer per line with more session .jsonl files (e.g. a copied profile or another app’s session folder). Subfolders are included.')
				.addTextArea((t) =>
					t.setPlaceholder('C:/Users/me/OtherProfile/.claude/projects').setValue(conf.extraFolders.join('\n')).onChange(async (v) => {
						conf.extraFolders = v.split('\n').map((x) => x.trim()).filter(Boolean);
						await save();
					}),
				);
		}
		new Setting(el).setName('How sessions are saved').setHeading();
		new Setting(el)
			.setName('Mirror the apps’ sidebar as subfolders')
			.setDesc('Claude: one folder per sidebar group; sessions outside a group by working folder ("Scratch" for sessions without one); forks and side sessions inside a folder named after the session they came from. Codex: one folder per project, the rest in "Recent".')
			.addToggle((t) =>
				t.setValue(d.projectSubfolders).onChange(async (v) => {
					d.projectSubfolders = v;
					await save();
				}),
			);
		new Setting(el)
			.setName('Keep the raw session file')
			.setDesc('Also copy the app’s .jsonl next to each transcript. These files can be large (several MB) and contain tool output in full.')
			.addToggle((t) =>
				t.setValue(d.keepRaw).onChange(async (v) => {
					d.keepRaw = v;
					await save();
				}),
			);
		new Setting(el)
			.setName('Wait until a session is quiet (minutes)')
			.setDesc('Sessions changed more recently than this are still running and are saved on a later sync. A session that continues later is saved again as "(updated …)".')
			.addText((t) =>
				t.setValue(String(d.quietMinutes)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isInteger(n) || n < 0 || n > 1440) return;
					d.quietMinutes = n;
					await save();
				}),
			);
		new Setting(el)
			.setName('Include helper sessions')
			.setDesc('Also save background helper runs (e.g. Codex approval reviews). Off = only your own conversations.')
			.addToggle((t) =>
				t.setValue(d.includeSubagents).onChange(async (v) => {
					d.includeSubagents = v;
					// Look at skipped helper sessions again.
					d.claude.ignored = {};
					d.codex.ignored = {};
					await save();
				}),
			);
	}

	/** Subfolders, files and project filter – the same options for every provider. */
	private folderOptions(
		provider: string,
		o: { projectSubfolders: boolean; recentFolderName: string; downloadFiles: boolean; onlyProjects: boolean; projects: string[] },
	): void {
		const el = this.containerEl;
		const save = () => this.plugin.saveSettings();
		new Setting(el)
			.setName(`Mirror ${provider} projects as subfolders`)
			.setDesc('E.g. …/<folder>/<project>/. Chats without a project go to the folder below.')
			.addToggle((t) =>
				t.setValue(o.projectSubfolders).onChange(async (v) => {
					o.projectSubfolders = v;
					await save();
				}),
			);
		new Setting(el)
			.setName('Folder for chats without a project')
			.setDesc('To sync these while the project filter is on, add this name to the projects list.')
			.addText((t) =>
				t.setPlaceholder('Recent').setValue(o.recentFolderName).onChange(async (v) => {
					const name = v.trim();
					if (!name || /[\\/]/.test(name) || name.startsWith('.')) return; // a plain folder name only
					o.recentFolderName = name;
					await save();
				}),
			);
		new Setting(el)
			.setName('Download files and images')
			.setDesc('Files the AI created go to Artifacts/, files you uploaded to Attachments/, next to the chat. No size limit.')
			.addToggle((t) =>
				t.setValue(o.downloadFiles).onChange(async (v) => {
					o.downloadFiles = v;
					await save();
				}),
			);
		new Setting(el)
			.setName('Only chats from these projects')
			.setDesc('Off = all chats.')
			.addToggle((t) =>
				t.setValue(o.onlyProjects).onChange(async (v) => {
					o.onlyProjects = v;
					await save();
				}),
			);
		new Setting(el)
			.setName('Projects')
			.setDesc(`One ${provider} project name (or project ID) per line. Add the folder name above (e.g. "Recent") for chats without a project.`)
			.addTextArea((t) =>
				t.setValue(o.projects.join('\n')).onChange(async (v) => {
					o.projects = v.split('\n').map((x) => x.trim()).filter(Boolean);
					await save();
				}),
			);
		new Setting(el).setDesc('Folder changes only affect chats synced from now on. Files already written stay where they are.');
	}

	private folderSetting(name: string, desc: string, get: () => string, set: (p: string) => void): void {
		const save = async (v: string) => {
			const p = cleanFolder(v);
			if (!p) return; // ignore empty / hidden folders
			set(p);
			await this.plugin.saveSettings();
		};
		let text: TextComponent | null = null;
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) => {
				text = t;
				t.setPlaceholder('AI Chats/…').setValue(get()).onChange(save);
				new FolderSuggest(this.app, t.inputEl, (path) => void save(path));
			})
			.addButton((b) =>
				b
					.setButtonText('Browse…')
					.setTooltip('Pick a folder in the vault with the Windows folder dialog')
					.onClick(async () => {
						const r = browseForVaultFolder(this.app, get(), `Choose the ${name}`);
						if (!r.ok) {
							const msg = BROWSE_MESSAGES[r.reason];
							if (msg) new Notice(msg, 8000);
							return;
						}
						text?.setValue(r.path);
						await save(r.path);
					}),
			);
	}
}
