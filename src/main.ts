import { Notice, Plugin, setIcon } from 'obsidian';
import { MIN_INTERVAL_MINUTES, type ChatgptAccount, type ClaudeAccount, type GeminiAccount, type LumoAccount, type Settings } from './settings';
import { accountsOf, hasPastedSession, loginRef, SITE_LABEL, withAccount, type AnyAccount } from './accounts';
import { normalizeSettings } from './migrate';
import { AIChatBridgeSettingTab } from './ui/settings-tab';
import { anyDesktopEnabled, runDesktopSync, type DesktopOnly } from './desktop/sync';
import { folderExists, layoutMoves, moveToAppLayout, pruneEmpty } from './desktop/layout';
import { masterRaw, mirrorRaw } from './raw-folders';
import { allRawMoves, moveRawFiles } from './raw-move';
import { refreshIndex, type ReindexResult } from './reindex';
import { runSync } from './sync';
import { diagnoseActiveChat } from './diagnose';
import { followRename } from './follow';
import { closeLoginWindows, isLoggedIn, type Provider } from './login';
import { StopError } from './api';
import { runGptSync } from './chatgpt/sync';
import { registerLayoutIcons } from './chatgpt/layout-view';
import { runLumoSync } from './lumo/sync';
import { runGeminiSync } from './gemini/sync';
import { runStudioSync } from './studio/sync';
import { anyHermesEnabled, runHermesSync } from './hermes/sync';
import { chatCountStatus, SyncProgress } from './progress';

type SyncTrigger = 'manual' | 'auto' | 'resume';

/** One run of one thing: an account's website, or the desktop apps. */
type Target =
	| { kind: 'claude'; account: ClaudeAccount }
	| { kind: 'chatgpt'; account: ChatgptAccount; forceFull?: boolean }
	| { kind: 'lumo'; account: LumoAccount }
	| { kind: 'gemini'; account: GeminiAccount }
	| { kind: 'studio'; account: GeminiAccount }
	| { kind: 'desktop'; only?: DesktopOnly; label?: string }
	| { kind: 'hermes'; profileId?: string; label?: string };

/** web = the provider's chat website; studio = Google AI Studio, which shares the Google login. */
export type Surface = 'web' | 'desktop' | 'studio';

export default class AIChatBridge extends Plugin {
	settings!: Settings;
	private running = false;
	/** The running work is a project-list fetch, not a sync. */
	private fetchingList = false;
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
	private ribbonEl: HTMLElement | null = null;
	/** Stop was asked for: the running sync ends after its current chat. */
	private stopRequested = false;
	/** Which account (or desktop app) is syncing right now. */
	private current: { provider?: Provider; id?: string; hermes?: boolean } | null = null;
	private progress: SyncProgress | null = null;
	private readonly busyListeners = new Set<() => void>();
	/** The last "Refresh index" result, shown in the settings. */
	lastReindex: (ReindexResult & { at: number }) | null = null;

	async onload() {
		this.unloaded = false;
		await this.loadSettings();
		// Pick up an active cooldown saved by a version that had no automatic retry.
		let adopted = false;
		for (const { web } of this.settings.chatgpt) {
			if (web.resumeAfter429 === undefined && (web.cooldownUntil ?? 0) > Date.now()) {
				web.resumeAfter429 = { consecutive: 1, forceFull: false };
				adopted = true;
			}
		}
		if (adopted) await this.saveSettings();
		registerLayoutIcons(this);
		this.statusEl = this.addStatusBarItem();
		// While a sync runs, selecting the status bar text stops it.
		this.registerDomEvent(this.statusEl, 'click', () => {
			if (this.syncing) this.requestStop();
		});
		this.ribbonEl = this.addRibbonIcon('refresh-cw', 'Sync all chats', () => {
			if (this.syncing) this.requestStop();
			else void this.syncAll('manual');
		});
		this.ribbonEl.addClass('ccs-ribbon');

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
			id: 'sync-lumo-chats',
			name: 'Sync Lumo chats',
			callback: () => void this.syncLumo('manual'),
		});

		this.addCommand({
			id: 'sync-gemini-chats',
			name: 'Sync Gemini and AI Studio chats',
			callback: () => void this.syncGemini('manual'),
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
				if (this.running || !this.nextGptResume()) return false;
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
			id: 'sync-hermes-chats',
			name: 'Sync Hermes Agent chats',
			callback: () => void this.syncHermes('manual'),
		});

		this.addCommand({
			id: 'move-to-app-layout',
			name: 'Move synced chats into the new folder layout',
			callback: () => void this.moveToAppLayout(),
		});

		this.addCommand({
			id: 'sync-all-chats',
			name: 'Sync all chats',
			callback: () => void this.syncAll('manual'),
		});

		this.addCommand({
			id: 'stop-sync',
			name: 'Stop the running sync',
			checkCallback: (checking) => {
				if (!this.syncing || this.stopRequested) return false;
				if (!checking) this.requestStop();
				return true;
			},
		});

		this.addCommand({
			id: 'refresh-index',
			name: 'Refresh index: find synced notes moved outside the app',
			callback: () => void this.refreshIndexNow(),
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
			if (this.settings.syncOnStartup) this.scheduleStartupSync();
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
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.saveSettings(); // don't lose a pending index update (queued before the flag below)
		}
		// From here on this copy never saves: after a reload the new copy owns the settings, and a
		// sync still finishing here would write its older index and folders over them.
		this.unloaded = true;
		// A running sync stops before its next chat (it may still be fetching one).
		this.stopRequested = true;
		this.clearGptResumeTimer();
		this.statusEl?.setText('');
		closeLoginWindows();
		if (this.timer !== null) window.clearInterval(this.timer);
	}

	private clearGptResumeTimer(): void {
		if (this.gptResumeTimer !== null) window.clearTimeout(this.gptResumeTimer);
		this.gptResumeTimer = null;
		if (this.showingGptCooldown) this.statusEl?.setText('');
		this.showingGptCooldown = false;
	}

	/** The ChatGPT account whose automatic retry comes first. Each account cools down on its own. */
	private nextGptResume(): ChatgptAccount | undefined {
		const waiting = this.settings.chatgpt.filter((a) => a.web.resumeAfter429);
		return waiting.sort((a, b) => (a.web.cooldownUntil ?? 0) - (b.web.cooldownUntil ?? 0))[0];
	}

	private gptLabel(account: ChatgptAccount): string {
		return withAccount('ChatGPT', this.settings.chatgpt, account);
	}

	private scheduleGptResume(): void {
		this.clearGptResumeTimer();
		if (this.unloaded || this.running) return;
		const account = this.nextGptResume();
		// Idle: nothing running or waiting.
		if (!account) {
			this.statusEl?.setText(this.idleStatus());
			return;
		}
		const gpt = account.web;
		const label = this.gptLabel(account);
		const count = chatCountStatus(gpt.chatProgress, label);
		const delay = Math.max(0, (gpt.cooldownUntil ?? 0) - Date.now());
		if (delay > 0) {
			const seconds = Math.ceil(delay / 1000);
			const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
			const remainder = String(seconds % 60).padStart(2, '0');
			this.statusEl?.setText(`${count ? count + ' ·' : label} retry in ${minutes}:${remainder}`);
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
			void this.guarded('resume', () => this.runOne({ kind: 'chatgpt', account }, 'resume')).catch(() => {
				this.clearGptResumeTimer();
				new Notice('The sync retry could not finish. Check the settings and try again.');
			});
		}, Math.min(delay, 1000));
	}

	private async cancelGptResume(): Promise<void> {
		this.clearGptResumeTimer();
		for (const { web } of this.settings.chatgpt) if (web.resumeAfter429) web.resumeAfter429 = null;
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
		if (this.unloaded || this.running || this.showingGptCooldown || this.nextGptResume()) return;
		this.statusEl?.setText(this.idleStatus());
	}

	/** Seconds after start-up before "Sync all" runs, so Obsidian and other plugins can settle first. */
	private static readonly STARTUP_DELAY_SECONDS = 10;

	/** Runs "Sync all" once, shortly after Obsidian has started. Quiet, like the automatic sync. */
	private scheduleStartupSync(): void {
		this.statusEl?.setText(`AI ChatBridge: syncing in ${AIChatBridge.STARTUP_DELAY_SECONDS} s`);
		const t = window.setTimeout(() => {
			if (this.unloaded) return;
			this.refreshIdleStatus();
			void this.syncAll('auto');
		}, AIChatBridge.STARTUP_DELAY_SECONDS * 1000);
		this.register(() => window.clearTimeout(t));
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

	/** Can this account's website be synced right now? */
	async canSyncWeb(provider: Provider, account: AnyAccount): Promise<boolean> {
		if (await isLoggedIn(loginRef(provider, account))) return true;
		return hasPastedSession(provider, account);
	}

	/**
	 * The accounts a provider-wide sync should run. With several accounts, ones you are not
	 * logged in to are left out; a single account always runs, so its "not logged in" is shown.
	 */
	private async webAccounts<T extends AnyAccount>(provider: Provider, list: T[]): Promise<T[]> {
		if (list.length === 1) return list;
		const out: T[] = [];
		for (const account of list) if (await this.canSyncWeb(provider, account)) out.push(account);
		return out;
	}

	private notLoggedIn(provider: Provider, trigger: SyncTrigger): void {
		if (trigger === 'manual') new Notice(`${SITE_LABEL[provider]}: none of the accounts is logged in. Log in in the plugin settings.`);
	}

	/** Every claude.ai account. One account stopping does not hold back the others. */
	async sync(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const accounts = await this.webAccounts('claude', this.settings.claude);
			if (!accounts.length) this.notLoggedIn('claude', trigger);
			for (const account of accounts) await this.runOne({ kind: 'claude', account }, trigger);
		});
	}

	/** Every ChatGPT account. */
	async syncGpt(trigger: 'manual' | 'auto', forceFull = false) {
		await this.guarded(trigger, async () => {
			const accounts = await this.webAccounts('chatgpt', this.settings.chatgpt);
			if (!accounts.length) this.notLoggedIn('chatgpt', trigger);
			for (const account of accounts) await this.runOne({ kind: 'chatgpt', account, forceFull }, trigger);
		});
	}

	/** Every Lumo account. */
	async syncLumo(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const accounts = await this.webAccounts('lumo', this.settings.lumo);
			if (!accounts.length) this.notLoggedIn('lumo', trigger);
			for (const account of accounts) await this.runOne({ kind: 'lumo', account }, trigger);
		});
	}

	/** Every Google account: its Gemini chats, then its AI Studio prompts. */
	async syncGemini(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const accounts = await this.webAccounts('gemini', this.settings.gemini);
			if (!accounts.length) this.notLoggedIn('gemini', trigger);
			for (const account of accounts) await this.runGoogle(account, trigger);
		});
	}

	/** Gemini, then AI Studio if it is on. Returns false if either stopped. */
	private async runGoogle(account: GeminiAccount, trigger: SyncTrigger): Promise<boolean> {
		const chats = await this.runOne({ kind: 'gemini', account }, trigger);
		if (!account.studio.enabled) return chats;
		return (await this.runOne({ kind: 'studio', account }, trigger)) && chats;
	}

	/** Desktop apps only (Claude Code / Cowork, Codex). */
	async syncDesktop(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			if (!anyDesktopEnabled(this)) {
				if (trigger === 'manual') new Notice('Desktop apps: none is turned on. Turn them on under each account in the plugin settings.');
				return;
			}
			await this.runOne({ kind: 'desktop' }, trigger);
		});
	}

	/** Hermes Agent profiles only: every profile turned on, or just one (its Sync button). */
	async syncHermes(trigger: 'manual' | 'auto', profileId?: string) {
		await this.guarded(trigger, async () => {
			if (!anyHermesEnabled(this)) {
				if (trigger === 'manual') new Notice('Hermes: no profile is turned on. Turn one on in the plugin settings (Hermes tab).');
				return;
			}
			const profile = profileId ? this.settings.hermes.profiles.find((p) => p.id === profileId) : undefined;
			await this.runOne({ kind: 'hermes', profileId, label: profile ? `Hermes ${profile.label}` : undefined }, trigger);
		});
	}

	/** The Hermes profile (by ID) or all of Hermes is syncing right now. */
	isSyncingHermes(profileId?: string): boolean {
		return this.syncing && this.current?.hermes === true && (!profileId || this.current.id === profileId || this.current.id === undefined);
	}

	/** One surface of one account (the Sync buttons in the settings). */
	async syncAccount(provider: Provider, account: AnyAccount, surface: Surface) {
		await this.guarded('manual', () => this.runSurface(provider, account, surface));
	}

	/** Everything of one account in one run (the Overview's Sync): website, desktop app, AI Studio. Stop ends it all. */
	async syncWholeAccount(provider: Provider, account: AnyAccount) {
		await this.guarded('manual', async () => {
			const web = await this.canSyncWeb(provider, account);
			const desktop = 'desktop' in account && account.desktop.enabled;
			if (!web && !desktop) {
				new Notice(`${account.label}: not logged in, and its desktop app is off. Select the account to log in.`);
				return;
			}
			if (web) await this.runSurface(provider, account, 'web');
			if (desktop) await this.runSurface(provider, account, 'desktop');
			if (web && 'studio' in account && account.studio.enabled) await this.runSurface(provider, account, 'studio');
		});
	}

	private async runSurface(provider: Provider, account: AnyAccount, surface: Surface): Promise<void> {
		if (surface === 'desktop') {
			const label = withAccount(provider === 'claude' ? 'Claude desktop' : 'Codex', accountsOf(this.settings, provider), account);
			await this.runOne({ kind: 'desktop', only: { provider, id: account.id }, label }, 'manual');
		} else if (surface === 'studio') await this.runOne({ kind: 'studio', account: account as GeminiAccount }, 'manual');
		else if (provider === 'gemini') await this.runOne({ kind: 'gemini', account: account as GeminiAccount }, 'manual');
		else if (provider === 'claude') await this.runOne({ kind: 'claude', account: account as ClaudeAccount }, 'manual');
		else if (provider === 'lumo') await this.runOne({ kind: 'lumo', account: account as LumoAccount }, 'manual');
		else await this.runOne({ kind: 'chatgpt', account: account as ChatgptAccount }, 'manual');
	}

	/**
	 * Moves the synced folders into the layout (Claude/Chat, Claude/Code-Local/<computer> …),
	 * then the raw files after them, so the raw files folder keeps mirroring the transcripts.
	 */
	async moveToAppLayout(): Promise<void> {
		await this.guarded('manual', async () => {
			if (!layoutMoves(this.settings, folderExists(this.app)).length) {
				new Notice('AI ChatBridge: the folders already follow the layout.');
				return;
			}
			const notice = new Notice('AI ChatBridge: moving synced chats…', 0);
			try {
				const r = await moveToAppLayout(this.app, this.settings, () => this.saveSettings());
				notice.setMessage('AI ChatBridge: moving the raw files after them…');
				const raw = await moveRawFiles(this.app, this.settings, allRawMoves(this.app, this.settings), () => this.saveSettings());
				// Their old folders in the raw files folder, now empty.
				const root = masterRaw(this.settings);
				if (root !== undefined) {
					for (const from of r.from) {
						await pruneEmpty(this.app, mirrorRaw(from, root));
						await pruneEmpty(this.app, mirrorRaw(from.split('/').slice(0, -1).join('/'), root));
					}
				}
				const left = r.conflicts.length ? ` ${r.conflicts.length} files stayed where they were, because a file with the same name was already there: ${r.conflicts.slice(0, 5).join(', ')}` : '';
				const rawText = raw.moved ? `, and ${raw.moved} raw files after them` : '';
				new Notice(`AI ChatBridge: moved ${r.moved} folders and files into the new layout${rawText}.${left}`, 15_000);
			} finally {
				notice.hide();
			}
		});
	}

	/** Finds chats moved outside Obsidian and points the sync history at them. */
	async refreshIndexNow(): Promise<ReindexResult | null> {
		if (this.running) {
			new Notice(this.fetchingList ? 'The project list is still loading. Try again when it has finished.' : 'A sync is running. Refresh the index when it has finished.');
			return null;
		}
		const r = refreshIndex(this.app, this.settings);
		if (r.relinked) await this.saveSettings();
		this.lastReindex = { ...r, at: Date.now() };
		new Notice(reindexText(r), 10_000);
		return r;
	}

	/** Every account you are logged in to, one after the other, then the desktop apps. */
	async syncAll(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const claude: ClaudeAccount[] = [];
			for (const a of this.settings.claude) if (await this.canSyncWeb('claude', a)) claude.push(a);
			const gpt: ChatgptAccount[] = [];
			for (const a of this.settings.chatgpt) if (await this.canSyncWeb('chatgpt', a)) gpt.push(a);
			const lumo: LumoAccount[] = [];
			for (const a of this.settings.lumo) if (await this.canSyncWeb('lumo', a)) lumo.push(a);
			const gemini: GeminiAccount[] = [];
			for (const a of this.settings.gemini) if (await this.canSyncWeb('gemini', a)) gemini.push(a);
			const desktop = anyDesktopEnabled(this);
			const hermes = anyHermesEnabled(this);
			if (!claude.length && !gpt.length && !lumo.length && !gemini.length && !desktop && !hermes) {
				if (trigger === 'manual') new Notice('Sync all: not logged in to any provider. Log in in the plugin settings.');
				return;
			}
			let claudeOk = true;
			for (const account of claude) if (!(await this.runOne({ kind: 'claude', account }, trigger))) claudeOk = false;
			if (!claudeOk) return; // a stop pauses the rest too
			for (const account of gpt) {
				const waiting = account.web.resumeAfter429 || (account.web.cooldownUntil ?? 0) > Date.now();
				// A ChatGPT cooldown only waits; other accounts and the desktop apps still run.
				if (trigger !== 'manual' && waiting) continue;
				if (!(await this.runOne({ kind: 'chatgpt', account }, trigger)) && this.autoPaused) return;
			}
			for (const account of lumo) if (!(await this.runOne({ kind: 'lumo', account }, trigger)) && this.autoPaused) return;
			for (const account of gemini) if (!(await this.runGoogle(account, trigger)) && this.autoPaused) return;
			if (desktop && !(await this.runOne({ kind: 'desktop' }, trigger)) && this.autoPaused) return;
			if (hermes) await this.runOne({ kind: 'hermes' }, trigger);
		});
	}

	/** One sync at a time; after an error the automatic sync waits until you sync by hand. */
	private async guarded(trigger: SyncTrigger, fn: () => Promise<unknown>) {
		if (this.unloaded || (trigger === 'auto' && this.autoPaused)) return;
		if (this.running) {
			if (trigger === 'manual') new Notice(this.fetchingList ? 'The project list is still loading. Try again when it has finished.' : 'A sync is already running.');
			return;
		}
		this.clearGptResumeTimer();
		this.running = true;
		this.stopRequested = false;
		this.busyChanged();
		if (trigger === 'manual') this.autoPaused = false;
		try {
			await fn();
		} finally {
			this.running = false;
			this.stopRequested = false;
			this.current = null;
			this.busyChanged();
			this.scheduleGptResume();
		}
	}

	/** A sync (not a project-list fetch) is running, so it can be stopped. */
	get syncing(): boolean {
		return this.running && !this.fetchingList;
	}

	get stopping(): boolean {
		return this.stopRequested;
	}

	/** This account (or this account's desktop app) is the one syncing right now. */
	isSyncing(provider: Provider, id: string): boolean {
		return this.syncing && this.current?.provider === provider && this.current.id === id;
	}

	/** Ends the running sync after its current chat. Everything saved so far stays saved. */
	requestStop(): void {
		if (!this.syncing || this.stopRequested) return;
		this.stopRequested = true;
		this.progress?.stopping();
		this.statusEl?.setText('AI ChatBridge: stopping after this chat…');
		if (!this.progress) new Notice('Stopping the sync after this chat…');
		this.busyChanged();
	}

	/** Calls `fn` whenever a sync starts, stops or is asked to stop. Returns the way to stop listening. */
	onBusyChange(fn: () => void): () => void {
		this.busyListeners.add(fn);
		return () => this.busyListeners.delete(fn);
	}

	private busyChanged(): void {
		const running = this.syncing;
		if (this.ribbonEl) {
			setIcon(this.ribbonEl, running ? 'square' : 'refresh-cw');
			this.ribbonEl.setAttr('aria-label', running ? (this.stopRequested ? 'Stopping the sync…' : 'Stop sync') : 'Sync all chats');
			this.ribbonEl.toggleClass('is-syncing', running);
		}
		const stoppable = running && !this.stopRequested;
		this.statusEl?.toggleClass('ccs-status-stoppable', stoppable);
		if (stoppable) this.statusEl?.setAttr('aria-label', 'Select to stop the sync');
		else this.statusEl?.removeAttribute('aria-label');
		for (const fn of [...this.busyListeners]) {
			try {
				fn();
			} catch {
				this.busyListeners.delete(fn);
			}
		}
	}

	/** A sync or a project-list fetch is under way. */
	get busy(): boolean {
		return this.running;
	}

	/** Runs work that must not overlap a sync, such as fetching the project list. */
	async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		if (this.running) throw new StopError('A sync is running. Try again when it has finished.');
		this.clearGptResumeTimer();
		this.running = true;
		this.fetchingList = true;
		this.busyChanged();
		try {
			return await fn();
		} finally {
			this.running = false;
			this.fetchingList = false;
			this.busyChanged();
			this.scheduleGptResume();
		}
	}

	private targetLabel(target: Target): string {
		if (target.kind === 'claude') return withAccount('claude.ai', this.settings.claude, target.account);
		if (target.kind === 'chatgpt') return this.gptLabel(target.account);
		if (target.kind === 'lumo') return withAccount('Lumo', this.settings.lumo, target.account);
		if (target.kind === 'gemini') return withAccount('Gemini', this.settings.gemini, target.account);
		if (target.kind === 'studio') return withAccount('AI Studio', this.settings.gemini, target.account);
		if (target.kind === 'hermes') return target.label ?? 'Hermes';
		return target.label ?? 'Desktop apps';
	}

	/** Runs one account or the desktop apps and shows the result. Returns false if it stopped. */
	private async runOne(target: Target, trigger: SyncTrigger): Promise<boolean> {
		// After a stop, the accounts still queued in this run are skipped.
		if (this.stopRequested) return false;
		const label = this.targetLabel(target);
		// Progress bar in a notice (manual syncs) and a percentage in the status bar (all syncs).
		const progress = new SyncProgress(label, this.statusEl, trigger === 'manual',
			target.kind === 'chatgpt' ? () => chatCountStatus(target.account.web.chatProgress, label) : undefined,
			() => this.requestStop());
		this.progress = progress;
		this.current = target.kind === 'hermes'
			? { hermes: true, id: target.profileId }
			: target.kind === 'desktop'
			? { provider: target.only?.provider, id: target.only?.id }
			: { provider: target.kind === 'studio' ? 'gemini' : target.kind, id: target.account.id };
		this.busyChanged();
		// Every sync reports progress before each chat: a stop ends it there, between two chats.
		const update: typeof progress.update = (...args) => {
			if (this.stopRequested) throw new StopError(STOPPED_BY_YOU);
			progress.update(...args);
		};
		let r;
		try {
			r = target.kind === 'claude' ? await runSync(this, target.account, update)
				: target.kind === 'chatgpt' ? await runGptSync(this, target.account, update, target.forceFull)
				: target.kind === 'lumo' ? await runLumoSync(this, target.account, update)
				: target.kind === 'gemini' ? await runGeminiSync(this, target.account, update)
				: target.kind === 'studio' ? await runStudioSync(this, target.account, update)
				: target.kind === 'hermes' ? await runHermesSync(this, update, target.profileId)
				: await runDesktopSync(this, update, undefined, undefined, target.only);
		} finally {
			progress.finish();
			this.progress = null;
		}
		if (this.stopRequested) {
			const saved = r.newCount + r.changedCount;
			new Notice(`${label}: stopped. ${saved ? `${saved} saved before stopping` : 'Nothing new was saved'}; the next sync carries on from there.`, 8000);
			return false;
		}
		if ('nothingSelected' in r && r.nothingSelected) {
			if (trigger === 'manual') new Notice(`${label}: no projects selected, so nothing was synced. Select some in the plugin settings.`);
			return true;
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
			// Hermes profiles whose state.db is gone were skipped; say so, so a quiet result isn't a surprise.
			const gone = 'missing' in r && r.missing.length ? ` Skipped, not found: ${r.missing.join(', ')}.` : '';
			new Notice(`${label}: ${r.newCount} new, ${r.changedCount} changed, ${r.unchanged} unchanged${restored}${more}.${gone}`);
		}
		return true;
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as unknown;
		const { settings, migrated } = normalizeSettings(loaded);
		this.settings = settings;
		if (migrated) await this.keepOldSettings(loaded);
	}

	/** One copy of the settings from before multiple accounts, in case you ever go back a version. */
	private async keepOldSettings(loaded: unknown): Promise<void> {
		const dir = this.manifest?.dir;
		if (!dir) return;
		const path = `${dir}/data.before-accounts.json`;
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(path))) await adapter.write(path, JSON.stringify(loaded));
		} catch (e) {
			console.error('AI ChatBridge: could not keep a copy of the old settings', e instanceof Error ? e.message : e);
		}
	}

	private settingsWrite: Promise<void> = Promise.resolve();

	async saveSettings() {
		if (this.unloaded) return; // see onunload
		const write = this.settingsWrite.then(() => this.saveData(this.settings));
		this.settingsWrite = write.catch(() => undefined);
		await write;
	}
}

/** A Refresh index result in words. */
export function reindexText(r: ReindexResult): string {
	const n = (x: number, one: string, many: string) => `${x.toLocaleString()} ${x === 1 ? one : many}`;
	const found = r.relinked ? `${n(r.relinked, 'file', 'files')} found in a new place` : 'nothing had moved';
	const missing = r.missing ? ` ${n(r.missing, 'chat is', 'chats are')} nowhere in the vault and will be saved again on the next sync.` : '';
	return `Index refreshed: ${n(r.checked, 'chat', 'chats')} checked, ${found}.${missing}`;
}

/** The message a sync stops with when you select Stop. */
export const STOPPED_BY_YOU = 'Stopped by you.';

/** Local time as HH:MM (24-hour). */
export function formatClock(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
