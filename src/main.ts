import { Notice, Plugin } from 'obsidian';
import { AIChatBridgeSettingTab, DEFAULT_DESKTOP, DEFAULT_GPT, DEFAULT_SETTINGS, MIN_INTERVAL_MINUTES, Settings } from './settings';
import { anyDesktopEnabled, runDesktopSync } from './desktop/sync';
import type { DesktopAppSettings } from './desktop/types';
import { CHATGPT_APP, CLAUDE_APP, layoutMoves, layoutRoot, moveToAppLayout } from './desktop/layout';
import { runSync } from './sync';
import { diagnoseActiveChat } from './diagnose';
import { followRename } from './follow';
import { closeLoginWindows, isLoggedIn } from './login';
import { runGptSync } from './chatgpt/sync';
import { chatCountStatus, SyncProgress } from './progress';

type SyncTrigger = 'manual' | 'auto' | 'resume';

export default class AIChatBridge extends Plugin {
	settings!: Settings;
	private running = false;
	private timer: number | null = null;
	/** When the automatic sync timer fires next (ms), or null when it is off. */
	private nextAutoAt: number | null = null;
	private gptResumeTimer: number | null = null;
	private showingGptCooldown = false;
	private unloaded = false;
	/** After an error, the automatic sync waits until you sync by hand. */
	private autoPaused = false;

	/** Status bar text while a sync runs (empty otherwise). */
	private statusEl: HTMLElement | null = null;

	async onload() {
		this.unloaded = false;
		await this.loadSettings();
		const gpt = this.settings.gpt;
		// Pick up an active cooldown saved by a version that had no automatic retry.
		if (gpt.resumeAfter429 === undefined && (gpt.cooldownUntil ?? 0) > Date.now()) {
			gpt.resumeAfter429 = { consecutive: 1, forceFull: false };
			await this.saveSettings();
		}
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
			id: 'reconcile-chatgpt-chats',
			name: 'Reconcile all ChatGPT chats',
			callback: () => void this.syncGpt('manual', true),
		});

		this.addCommand({
			id: 'cancel-chatgpt-retry',
			name: 'Cancel pending chat sync retry',
			checkCallback: (checking) => {
				if (this.running || !this.settings.gpt.resumeAfter429) return false;
				if (!checking) void this.cancelGptResume();
				return true;
			},
		});

		this.addCommand({
			id: 'sync-desktop-app-chats',
			name: 'Sync desktop app chats (Claude, Codex)',
			callback: () => void this.syncDesktop('manual'),
		});

		this.addCommand({
			id: 'move-to-app-layout',
			name: 'Move synced chats into the app layout (Claude Desktop, ChatGPT Desktop)',
			callback: () => void this.moveToAppLayout(),
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
			this.scheduleGptResume();
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
		this.unloaded = true;
		this.clearGptResumeTimer();
		this.statusEl?.setText('');
		closeLoginWindows();
		if (this.timer !== null) window.clearInterval(this.timer);
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			void this.saveSettings(); // don't lose a pending index update
		}
	}

	private clearGptResumeTimer(): void {
		if (this.gptResumeTimer !== null) window.clearTimeout(this.gptResumeTimer);
		this.gptResumeTimer = null;
		if (this.showingGptCooldown) this.statusEl?.setText('');
		this.showingGptCooldown = false;
	}

	private scheduleGptResume(): void {
		this.clearGptResumeTimer();
		const gpt = this.settings.gpt;
		if (this.unloaded || this.running) return;
		// Idle: nothing running or waiting.
		if (!gpt.resumeAfter429) {
			this.statusEl?.setText(this.idleStatus());
			return;
		}
		const count = chatCountStatus(gpt.chatProgress);
		const delay = Math.max(0, (gpt.cooldownUntil ?? 0) - Date.now());
		if (delay > 0) {
			const seconds = Math.ceil(delay / 1000);
			const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
			const remainder = String(seconds % 60).padStart(2, '0');
			this.statusEl?.setText(`${count ? count + ' ·' : 'ChatGPT'} retry in ${minutes}:${remainder}`);
			this.showingGptCooldown = true;
		}
		this.gptResumeTimer = window.setTimeout(() => {
			this.gptResumeTimer = null;
			// A running sync will re-arm the timer when it releases the guard.
			if (this.unloaded || this.running || !gpt.resumeAfter429) return;
			if ((gpt.cooldownUntil ?? 0) > Date.now()) {
				this.scheduleGptResume();
				return;
			}
			void this.guarded('resume', () => this.runOne('chatgpt', 'resume')).catch(() => {
				this.clearGptResumeTimer();
				new Notice('The sync retry could not finish. Check the settings and try again.');
			});
		}, Math.min(delay, 1000));
	}

	private async cancelGptResume(): Promise<void> {
		this.clearGptResumeTimer();
		this.settings.gpt.resumeAfter429 = null;
		await this.saveSettings();
		this.scheduleGptResume();
		new Notice('Pending retry canceled. The cooldown still applies.');
	}

	/** Idle status bar text: the next automatic sync time while it is on (and not paused after an error). */
	private idleStatus(): string {
		if (this.timer === null || this.nextAutoAt === null || this.autoPaused) return '';
		return `AI ChatBridge: next sync ${formatClock(this.nextAutoAt)}`;
	}

	/** Refreshes the idle text when nothing is running or counting down. */
	private refreshIdleStatus(): void {
		if (this.unloaded || this.running || this.showingGptCooldown || this.settings.gpt.resumeAfter429) return;
		this.statusEl?.setText(this.idleStatus());
	}

	restartTimer() {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.nextAutoAt = null;
		const m = this.settings.intervalMinutes;
		if (m >= MIN_INTERVAL_MINUTES) {
			const every = m * 60_000;
			this.nextAutoAt = Date.now() + every;
			this.timer = window.setInterval(() => {
				this.nextAutoAt = Date.now() + every;
				this.refreshIdleStatus(); // shows the new time even if this run is skipped
				void this.syncAll('auto');
			}, every);
			this.registerInterval(this.timer);
		}
		this.refreshIdleStatus();
	}

	/** claude.ai only. */
	async sync(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, () => this.runOne('claude', trigger));
	}

	/** ChatGPT only. */
	async syncGpt(trigger: 'manual' | 'auto', forceFull = false) {
		await this.guarded(trigger, () => this.runOne('chatgpt', trigger, forceFull));
	}

	/** Desktop apps only (Claude Code / Cowork, Codex). */
	async syncDesktop(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			if (!anyDesktopEnabled(this)) {
				if (trigger === 'manual') new Notice('Desktop apps: none is turned on. Turn them on in the plugin settings, "Desktop apps" tab.');
				return;
			}
			await this.runOne('desktop', trigger);
		});
	}

	/** Moves the synced folders into Claude Desktop/{Chat,Code} and ChatGPT Desktop/{Chat,Codex}. */
	async moveToAppLayout(): Promise<void> {
		await this.guarded('manual', async () => {
			if (!layoutMoves(this.settings).length) {
				new Notice('AI ChatBridge: the folders already follow the app layout.');
				return;
			}
			const notice = new Notice('AI ChatBridge: moving synced chats…', 0);
			try {
				const r = await moveToAppLayout(this.app, this.settings, () => this.saveSettings());
				const left = r.conflicts.length ? ` ${r.conflicts.length} files left in place (same name already there): ${r.conflicts.slice(0, 5).join(', ')}` : '';
				new Notice(`AI ChatBridge: moved ${r.moved} folders and files into the app layout.${left}`, 15_000);
			} finally {
				notice.hide();
			}
		});
	}

	/** Every provider you are logged in to, one after the other, then the desktop apps. */
	async syncAll(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const claude = (await isLoggedIn('claude')) || !!this.settings.secretId;
			const gpt = await isLoggedIn('chatgpt');
			const desktop = anyDesktopEnabled(this);
			if (!claude && !gpt && !desktop) {
				if (trigger === 'manual') new Notice('Sync all: not logged in to any provider. Log in in the plugin settings.');
				return;
			}
			if (claude && !(await this.runOne('claude', trigger))) return; // a stop pauses the rest too
			const waiting = this.settings.gpt.resumeAfter429 || (this.settings.gpt.cooldownUntil ?? 0) > Date.now();
			// A ChatGPT cooldown only waits; the desktop apps still run.
			if (gpt && (trigger === 'manual' || !waiting) && !(await this.runOne('chatgpt', trigger)) && this.autoPaused) return;
			if (desktop) await this.runOne('desktop', trigger);
		});
	}

	/** One sync at a time; after an error the automatic sync waits until you sync by hand. */
	private async guarded(trigger: SyncTrigger, fn: () => Promise<unknown>) {
		if (trigger === 'auto' && this.autoPaused) return;
		if (this.running) {
			if (trigger === 'manual') new Notice('A sync is already running.');
			return;
		}
		this.clearGptResumeTimer();
		this.running = true;
		if (trigger === 'manual') this.autoPaused = false;
		try {
			await fn();
		} finally {
			this.running = false;
			this.scheduleGptResume();
		}
	}

	/** Runs one provider and shows the result. Returns false if it stopped. */
	private async runOne(which: 'claude' | 'chatgpt' | 'desktop', trigger: SyncTrigger, forceFull = false): Promise<boolean> {
		const label = which === 'claude' ? 'claude.ai' : which === 'chatgpt' ? 'ChatGPT' : 'Desktop apps';
		// Progress bar in a notice (manual syncs) and a percentage in the status bar (all syncs).
		const progress = new SyncProgress(label, this.statusEl, trigger === 'manual',
			which === 'chatgpt' ? () => chatCountStatus(this.settings.gpt.chatProgress) : undefined);
		let r;
		try {
			r = which === 'claude' ? await runSync(this, progress.update)
				: which === 'chatgpt' ? await runGptSync(this, progress.update, forceFull)
				: await runDesktopSync(this, progress.update);
		} finally {
			progress.finish();
		}
		if (r.stopped) {
			if ('resumeAt' in r && typeof r.resumeAt === 'number') {
				new Notice(`${label} sync waiting: ${r.stopped}`, 15_000);
				return false;
			}
			this.autoPaused = true;
			new Notice(`${label} sync stopped: ${r.stopped}`, 15_000);
			return false;
		}
		if (trigger === 'manual' || r.written.length || r.restored.length) {
			const active = 'active' in r && r.active ? `, ${r.active} still active` : '';
			const more = (r.leftForLater ? `, ${r.leftForLater} left for next run` : '') + active;
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
		this.settings.desktop = mergeDesktop(loaded?.desktop, this.settings.chatFolder);
		// Seed the status immediately when upgrading a vault with one unfiltered inventory.
		const gpt = this.settings.gpt;
		if (!gpt.chatProgress && (!gpt.onlyProjects || !gpt.projects.some((name) => name.trim()))) {
			const states = Object.entries(gpt.inventories?.accounts ?? {});
			const session = gpt.inventories?.session;
			if (session) states.push([session.key, session.inventory]);
			const state = states.length === 1 ? states[0] : undefined;
			if (state) {
				const [inventoryKey, inventory] = state;
				const scope = JSON.stringify([gpt.includeArchived === true, [], '', []]);
				if (inventory.scope === scope) {
					const rows = Object.values(inventory.known).filter((row) => row.generation === inventory.generation);
					gpt.chatProgress = { inventoryKey, scope, total: rows.length, saved: rows.filter((row) => gpt.index[row.item.id]).length };
				}
			}
		}
	}

	private settingsWrite: Promise<void> = Promise.resolve();

	async saveSettings() {
		const write = this.settingsWrite.then(() => this.saveData(this.settings));
		this.settingsWrite = write.catch(() => undefined);
		await write;
	}
}

/** Local time as HH:MM (24-hour). */
export function formatClock(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Desktop settings from data.json over the defaults. A vault that never had them gets the
 * app layout next to its Claude Chat folder (e.g. "30 Sources/AI Chats/Claude Desktop/Code").
 */
export function mergeDesktop(saved: Partial<Settings['desktop']> | undefined, chatFolder: string): Settings['desktop'] {
	const root = layoutRoot(chatFolder);
	const parent = chatFolder.split('/').slice(0, -1).join('/');
	const under = (r: string, rest: string) => (r ? `${r}/${rest}` : rest);
	const app = (s: Partial<DesktopAppSettings> | undefined, def: DesktopAppSettings, rest: string, before016: string): DesktopAppSettings => {
		const folder = under(root, rest);
		// 0.16.0 used ".../Claude Desktop" and ".../Codex"; nothing written there yet -> the new layout.
		const unused = !Object.keys(s?.index ?? {}).length && s?.folder === under(parent, before016);
		return {
			...def,
			folder,
			...s,
			...(unused ? { folder } : {}),
			extraFolders: [...(s?.extraFolders ?? [])],
			index: { ...(s?.index ?? {}) },
			ignored: { ...(s?.ignored ?? {}) },
			groupCache: { ...(s?.groupCache ?? {}) },
		};
	};
	return {
		...DEFAULT_DESKTOP,
		...saved,
		claude: app(saved?.claude, DEFAULT_DESKTOP.claude, `${CLAUDE_APP}/Code`, 'Claude Desktop'),
		codex: app(saved?.codex, DEFAULT_DESKTOP.codex, `${CHATGPT_APP}/Codex`, 'Codex'),
	};
}
