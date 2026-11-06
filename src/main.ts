import { Notice, Plugin } from 'obsidian';
import { AIChatBridgeSettingTab, DEFAULT_GPT, DEFAULT_SETTINGS, MIN_INTERVAL_MINUTES, Settings } from './settings';
import { runSync } from './sync';
import { diagnoseActiveChat } from './diagnose';
import { followRename } from './follow';
import { closeLoginWindows, isLoggedIn } from './login';
import { runGptSync } from './chatgpt/sync';
import { SyncProgress } from './progress';

export default class AIChatBridge extends Plugin {
	settings!: Settings;
	private running = false;
	private timer: number | null = null;
	/** After an error, the automatic sync waits until you sync by hand. */
	private autoPaused = false;

	/** Status bar text while a sync runs (empty otherwise). */
	private statusEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();
		this.statusEl = this.addStatusBarItem();

		this.addCommand({
			id: 'sync-claude-chats',
			name: 'Sync Claude chats',
			callback: () => void this.sync('manual'),
		});

		this.addCommand({
			id: 'sync-chatgpt-chats',
			name: 'Sync ChatGPT chats',
			callback: () => void this.syncGpt('manual'),
		});

		this.addCommand({
			id: 'sync-all-chats',
			name: 'Sync all chats',
			callback: () => void this.syncAll('manual'),
		});

		this.addCommand({
			id: 'diagnose-chat-downloads',
			name: 'Diagnose: save claude.ai answers for the open chat',
			callback: () => void diagnoseActiveChat(this),
		});

		this.addSettingTab(new AIChatBridgeSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			this.restartTimer();
			// Moves/renames in Obsidian update the index (registered after load, so the
			// vault's start-up scan is not mistaken for renames).
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					if (followRename(this.settings, oldPath, file.path) > 0) this.saveSoon();
				}),
			);
		});
	}

	private saveTimer: number | null = null;
	/** Saves the index once after a burst of renames (e.g. moving a whole folder). */
	private saveSoon() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, 1000);
	}

	onunload() {
		closeLoginWindows();
		if (this.timer !== null) window.clearInterval(this.timer);
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			void this.saveSettings(); // don't lose a pending index update
		}
	}

	restartTimer() {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		const m = this.settings.intervalMinutes;
		if (m >= MIN_INTERVAL_MINUTES) {
			this.timer = window.setInterval(() => void this.syncAll('auto'), m * 60_000);
			this.registerInterval(this.timer);
		}
	}

	/** claude.ai only. */
	async sync(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, () => this.runOne('claude', trigger));
	}

	/** ChatGPT only. */
	async syncGpt(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, () => this.runOne('chatgpt', trigger));
	}

	/** Every provider you are logged in to, one after the other. */
	async syncAll(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const claude = (await isLoggedIn('claude')) || !!this.settings.secretId;
			const gpt = await isLoggedIn('chatgpt');
			if (!claude && !gpt) {
				if (trigger === 'manual') new Notice('Sync all: not logged in to any provider. Log in in the plugin settings.');
				return;
			}
			if (claude && !(await this.runOne('claude', trigger))) return; // a stop pauses the rest too
			if (gpt) await this.runOne('chatgpt', trigger);
		});
	}

	/** One sync at a time; after an error the automatic sync waits until you sync by hand. */
	private async guarded(trigger: 'manual' | 'auto', fn: () => Promise<unknown>) {
		if (trigger === 'auto' && this.autoPaused) return;
		if (this.running) {
			if (trigger === 'manual') new Notice('A sync is already running.');
			return;
		}
		this.running = true;
		if (trigger === 'manual') this.autoPaused = false;
		try {
			await fn();
		} finally {
			this.running = false;
		}
	}

	/** Runs one provider and shows the result. Returns false if it stopped. */
	private async runOne(which: 'claude' | 'chatgpt', trigger: 'manual' | 'auto'): Promise<boolean> {
		const label = which === 'claude' ? 'claude.ai' : 'ChatGPT';
		// Progress bar in a notice (manual syncs) and a percentage in the status bar (all syncs).
		const progress = new SyncProgress(label, this.statusEl, trigger === 'manual');
		let r;
		try {
			r = which === 'claude' ? await runSync(this, progress.update) : await runGptSync(this, progress.update);
		} finally {
			progress.finish();
		}
		if (r.stopped) {
			this.autoPaused = true;
			new Notice(`${label} sync stopped: ${r.stopped}`, 15_000);
			return false;
		}
		if (trigger === 'manual' || r.written.length || r.restored.length) {
			const more = r.leftForLater ? `, ${r.leftForLater} left for next run` : '';
			const restored = r.restored.length ? `, ${r.restored.length} restored` : '';
			new Notice(`${label}: ${r.newCount} new, ${r.changedCount} changed, ${r.unchanged} unchanged${restored}${more}.`);
		}
		return true;
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as (Partial<Settings> & { rawFolder?: string }) | null;
		// v0.1.0 had one "rawFolder"; it becomes the Claude Chat folder.
		if (loaded?.rawFolder && !loaded.chatFolder) loaded.chatFolder = loaded.rawFolder;
		if (loaded) delete loaded.rawFolder;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.index = { ...(loaded?.index ?? {}) };
		this.settings.fileIndex = { ...(loaded?.fileIndex ?? {}) };
		this.settings.projects = [...(loaded?.projects ?? DEFAULT_SETTINGS.projects)];
		const g = loaded?.gpt;
		this.settings.gpt = {
			...DEFAULT_GPT,
			...g,
			projects: [...(g?.projects ?? DEFAULT_GPT.projects)],
			index: { ...(g?.index ?? {}) },
			fileIndex: { ...(g?.fileIndex ?? {}) },
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
