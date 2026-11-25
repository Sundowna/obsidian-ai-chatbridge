import { apiVersion, Notice, Platform, Plugin, setIcon } from 'obsidian';
import { errorLogAccounts, flushErrorLog, initErrorLog, pruneErrors } from './error-log';
import { handoffNote, MIN_INTERVAL_MINUTES, type ChatgptAccount, type ClaudeAccount, type GeminiAccount, type LumoAccount, type Settings } from './settings';
import { accountsOf, hasPastedSession, loginRef, SITE_LABEL, withAccount, type AnyAccount } from './accounts';
import { normalizeSettings } from './migrate';
import { AIChatBridgeSettingTab } from './ui/settings-tab';
import { anyDesktopEnabled, elsewhereText, runDesktopSync, type DesktopOnly } from './desktop/sync';
import { folderExists, layoutMoves, moveToAppLayout, pruneEmpty } from './desktop/layout';
import { masterRaw, mirrorRaw } from './raw-folders';
import { allRawMoves, moveRawFiles } from './raw-move';
import { refreshIndex, type ReindexResult } from './reindex';
import { mergeLogLine, mergeReportText, runMerge, writeMergeReport, type MergePreview, type MergeResult, type PreviewGroup } from './merge-run';
import { mayStartWhileMergeWaits, MERGE_NOT_STARTED_TEXT, MERGE_NOT_STOPPED_TEXT, MERGE_WAITING_TEXT, startMergeWhenIdle } from './merge-wait';
import { MergeModal } from './ui/merge-modal';
import { runSync } from './sync';
import { diagnoseActiveChat } from './diagnose';
import { testMobileConnection } from './mobile/connection-test';
import { RemoteSync } from './remote/controller';
import { ComputerStore } from './computers/store';
import { ALIVE_EVERY_MS, busyText, type BusyMarker } from './computers/busy';
import { joinSaved, splitSettings } from './computers/split';
import { ConfirmModal } from './ui/modals';
import { findFile } from './vaultio';
import { followRename } from './follow';
import { closeLoginWindows, isLoggedIn, type Provider } from './login';
import { StopError } from './api';
import { runGptSync } from './chatgpt/sync';
import { registerLayoutIcons } from './chatgpt/layout-view';
import { runLumoSync } from './lumo/sync';
import { runGeminiSync } from './gemini/sync';
import { runStudioSync } from './studio/sync';
import { anyHermesEnabled, runHermesSync } from './hermes/sync';
import { anyMemoryEnabled, runMemorySync } from './memory/sync';
import { chatCountStatus, SyncProgress } from './progress';
import { dailyUpkeep, updateLive } from './handoff/run';
import { copyHandover, HandoverModal } from './ui/handover-modal';
import { chatOfNote } from './handoff/core';
import { renameOldSystemFiles } from './system-names';
import { localDate } from './naming';
import { DESKTOP_ALL, DESKTOP_EVERY_ACCOUNT, HERMES, MEMORY, runKey, type LastRun, type RunOutcome } from './last-run';
import { hasArchiveToRestore, restoreSavedChats, separateSavedChats, type ArchiveTarget } from './archive-local';
import { archiveSummary } from './archive-move';

type SyncTrigger = 'manual' | 'auto' | 'resume';

/** One run of one thing: an account's website, or the desktop apps. */
type Target =
	| ArchiveTarget & { forceFull?: boolean }
	| { kind: 'lumo'; account: LumoAccount }
	| { kind: 'gemini'; account: GeminiAccount }
	| { kind: 'studio'; account: GeminiAccount }
	| { kind: 'desktop'; only?: DesktopOnly; label?: string }
	| { kind: 'hermes'; profileId?: string; label?: string }
	| { kind: 'memory' };

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
	/** The AI memory sync's own timer (Memory tab), apart from the chat sync's. */
	private memoryTimer: number | null = null;
	private gptResumeTimer: number | null = null;
	private showingGptCooldown = false;
	private unloaded = false;
	/**
	 * Sources that stopped with an error (run key -> label). The automatic sync skips only these
	 * until they sync without an error again, by hand or otherwise; everything else keeps syncing.
	 */
	private paused = new Map<string, string>();

	/** Status bar text while a sync runs (empty otherwise). */
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	/** Stop was asked for: the running sync ends after its current chat. */
	private stopRequested = false;
	/** "Merge N chats" was pressed during a sync: it starts when that sync ends (merge-wait.ts). */
	private mergeWaiting = false;
	/** The merge is running: the Sync button and the status bar do not stop it, only the Stop command does. */
	private merging = false;
	/** Waiting for the running sync to end (the waiting merge). */
	private idleWaiters: (() => void)[] = [];
	/** Which account (or desktop app) is syncing right now. */
	private current: { provider?: Provider; id?: string; hermes?: boolean; memory?: boolean } | null = null;
	private progress: SyncProgress | null = null;
	private readonly busyListeners = new Set<() => void>();
	/** The Sync button across devices: this one syncs, or asks the one that does. */
	readonly remote = new RemoteSync(this);
	/** Settings split between data.json (shared) and this computer's own file (see computers/). */
	readonly computers = new ComputerStore(() => this.app.vault.adapter, () => this.manifest?.dir);
	/** data.json changed on disk during a sync: read it once the sync is done. */
	private externalPending = false;
	/** The last "Refresh index" result, shown in the settings. */
	lastReindex: (ReindexResult & { at: number }) | null = null;

	async onload() {
		this.unloaded = false;
		await this.loadSettings();
		await initErrorLog(this.app.vault.adapter, this.manifest?.dir, errorLogEnvironment(this.manifest?.version ?? '?'));
		void pruneErrors(errorLogAccounts(this.settings).map((a) => a.source));
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
		// While a sync runs, selecting the status bar text stops it (a merge only says how to stop it).
		this.registerDomEvent(this.statusEl, 'click', () => {
			if (this.syncing) this.pressStop();
		});
		this.ribbonEl = this.addRibbonIcon('refresh-cw', this.idleSyncLabel(), () => this.pressSync());
		this.ribbonEl.addClass('ccs-ribbon');
		this.remote.onChange(() => this.busyChanged());

		this.addCommand({
			id: 'sync-or-ask',
			name: 'Sync: here, or ask the computer',
			icon: 'refresh-cw',
			callback: () => this.pressSync(),
		});

		this.addCommand({
			id: 'sync-claude-chats',
			name: 'Sync Claude (claude.ai and Claude Code)',
			callback: () => void this.sync('manual'),
		});

		this.addCommand({
			id: 'sync-chatgpt-chats',
			name: 'Sync ChatGPT (chats and Codex)',
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
			id: 'sync-ai-memory',
			name: 'Sync AI memory',
			callback: () => void this.syncMemory('manual'),
		});

		this.addCommand({
			id: 'update-active-context',
			name: 'Update Active Context now (live sessions, archive, stale lines)',
			callback: () => void this.upkeepHandoff(true),
		});

		this.addCommand({
			id: 'hand-over-chat',
			name: 'Hand over a chat to another AI (copies a ready message)',
			callback: () => new HandoverModal(this.app, this.settings).open(),
		});
		// Right-click on a synced chat note (file list, tab menu): hand it over directly.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const item = chatOfNote(this.settings, file.path);
				if (!item) return;
				menu.addItem((i) =>
					i
						.setTitle('Hand over this chat')
						.setIcon('forward')
						.onClick(() => void copyHandover(this.app, this.settings, item)),
				);
			}),
		);

		this.addCommand({
			id: 'move-to-app-layout',
			name: 'Move synced chats into the new folder layout',
			callback: () => void this.moveToAppLayout(),
		});

		this.addCommand({
			id: 'sync-all-chats',
			name: 'Sync all chats',
			// A phone or tablet cannot sync itself, so there this asks the computer.
			callback: () => (Platform.isMobile ? this.pressSync() : void this.syncAll('manual')),
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
			id: 'merge-chat-copies',
			name: 'Merge chat copies into one note (preview first)',
			callback: () => this.openMergePreview(),
		});

		this.addCommand({
			id: 'diagnose-chat-downloads',
			name: 'Diagnose: save claude.ai answers for the open chat',
			callback: () => void diagnoseActiveChat(this),
		});

		this.addCommand({
			id: 'test-mobile-connection',
			name: 'Test mobile connection',
			callback: () => void testMobileConnection(this),
		});

		this.addSettingTab(new AIChatBridgeSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			this.restartTimer();
			this.restartMemoryTimer();
			// Old system file names -> "_ai-chatbridge-…" once, then the Active Context upkeep:
			// at start-up, then every hour (the daily part runs once a day).
			void this.renameSystemFiles().then(() => this.upkeepHandoff(false));
			this.registerInterval(window.setInterval(() => void this.upkeepHandoff(false), 3_600_000));
			const watch = this.remote.start();
			for (const ref of watch.events) this.registerEvent(ref);
			this.registerInterval(watch.interval);
			this.scheduleGptResume();
			// The vault's files are known now, so what other computers synced can be checked against them.
			void this.mergeOtherComputers();
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
		void flushErrorLog();
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
		this.remote.stop();
		this.wakeIdleWaiters(); // a waiting merge gives up and says so
		this.clearGptResumeTimer();
		this.statusEl?.setText('');
		closeLoginWindows();
		if (this.timer !== null) window.clearInterval(this.timer);
		if (this.memoryTimer !== null) window.clearInterval(this.memoryTimer);
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

	/** Idle status bar text: the next automatic sync time while it is on, and which sources it leaves out after an error. */
	private idleStatus(): string {
		if (this.timer === null || this.nextAutoAt === null) return '';
		const paused = [...new Set(this.paused.values())];
		return `AI ChatBridge: next sync ${formatClock(this.nextAutoAt)}${paused.length ? ` · waiting for you: ${paused.join(', ')}` : ''}`;
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

	/** The AI memory sync on its own interval (0 = off). Quiet, and skipped while another sync runs. */
	restartMemoryTimer() {
		if (this.memoryTimer !== null) window.clearInterval(this.memoryTimer);
		this.memoryTimer = null;
		const m = this.settings.memory.intervalMinutes;
		if (m < MIN_INTERVAL_MINUTES) return;
		this.memoryTimer = window.setInterval(() => void this.syncMemory('auto'), m * 60_000);
		this.registerInterval(this.memoryTimer);
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

	/**
	 * Everything from Claude: every claude.ai account, then Claude Code on this computer for every
	 * account that has it turned on. One part stopping does not hold back the others.
	 */
	async sync(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const accounts = await this.webAccounts('claude', this.settings.claude);
			const desktop = this.settings.claude.some((a) => a.desktop.enabled);
			if (!accounts.length && !desktop) this.notLoggedIn('claude', trigger);
			for (const account of accounts) await this.runPart({ kind: 'claude', account }, trigger);
			if (desktop) await this.runPart({ kind: 'desktop', only: { provider: 'claude' }, label: 'Claude Code' }, trigger);
		});
	}

	/** Everything from ChatGPT: every ChatGPT account, then Codex on this computer for every account that has it turned on. */
	async syncGpt(trigger: 'manual' | 'auto', forceFull = false) {
		await this.guarded(trigger, async () => {
			const accounts = await this.webAccounts('chatgpt', this.settings.chatgpt);
			const desktop = this.settings.chatgpt.some((a) => a.desktop.enabled);
			if (!accounts.length && !desktop) this.notLoggedIn('chatgpt', trigger);
			for (const account of accounts) await this.runPart({ kind: 'chatgpt', account, forceFull }, trigger);
			if (desktop) await this.runPart({ kind: 'desktop', only: { provider: 'chatgpt' }, label: 'Codex' }, trigger);
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

	/** AI memory snapshots: every source turned on in the Memory tab. Not part of "Sync all". */
	async syncMemory(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			if (!anyMemoryEnabled(this)) {
				if (trigger === 'manual') new Notice('AI memory: no source is turned on. Turn one on in the plugin settings (memory tab).');
				return;
			}
			await this.runOne({ kind: 'memory' }, trigger);
		});
	}

	isSyncingMemory(): boolean {
		return this.syncing && this.current?.memory === true;
	}

	/** The Hermes profile (by ID) or all of Hermes is syncing right now. */
	isSyncingHermes(profileId?: string): boolean {
		return this.syncing && this.current?.hermes === true && (!profileId || this.current.id === profileId || this.current.id === undefined);
	}

	/** One surface of one account (the Sync buttons in the settings). */
	async syncAccount(provider: Provider, account: AnyAccount, surface: Surface) {
		await this.guarded('manual', () => this.runSurface(provider, account, surface));
	}

	private archiveTarget(provider: ArchiveTarget['kind'], id: string): ArchiveTarget | undefined {
		if (provider === 'chatgpt') {
			const account = this.settings.chatgpt.find((a) => a.id === id);
			return account && { kind: provider, account };
		}
		const account = this.settings.claude.find((a) => a.id === id);
		return account && { kind: provider, account };
	}

	async syncArchivedNow(provider: ArchiveTarget['kind'], id: string): Promise<void> {
		await this.changeArchiveNow(provider, id, false);
	}

	async restoreArchivedNow(provider: ArchiveTarget['kind'], id: string): Promise<void> {
		await this.changeArchiveNow(provider, id, true);
	}

	/** Both settings actions operate on vault files under the same guard as a web sync. */
	private async changeArchiveNow(provider: ArchiveTarget['kind'], id: string, restoring: boolean): Promise<void> {
		if (this.unloaded || Platform.isMobile) return;
		if (this.running) new Notice('The archive check will start after the current operation.');
		while (this.running && !this.unloaded) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
		await this.guarded('manual', async () => {
			const target = this.archiveTarget(provider, id);
			const web = target?.account.web;
			if (!target || !web || (restoring ? web.separateArchived !== false : !web.includeArchived || !web.separateArchived)) return;
			const label = this.targetLabel(target);
			const progress = new SyncProgress(label, this.statusEl, true, undefined, () => this.requestStop());
			this.current = { provider, id };
			this.progress = progress;
			this.busyChanged();
			let unresolved = 0;
			try {
				const update: typeof progress.update = (...args) => {
					if (this.stopRequested) throw new StopError(STOPPED_BY_YOU);
					progress.update(...args);
				};
				if (restoring) await this.restoreArchive(target, update);
				else {
					const result = await separateSavedChats(this, target, update);
					unresolved = result.unresolved;
					new Notice(`${label}: ${archiveSummary(result.report)}.${unresolved ? ` ${unresolved} saved chats need a provider check.` : ''}`, 8000);
				}
			} catch (error) {
				if (!(error instanceof StopError) || !this.stopRequested) throw error;
				new Notice(`${label}: archive migration stopped. The next sync carries on from there.`);
				return;
			} finally {
				progress.finish();
				this.progress = null;
			}
			if (!unresolved || this.stopRequested || !web.includeArchived || !web.separateArchived) return;
			if (target.kind === 'chatgpt') {
				const gpt = target.account.web;
				const deadline = gpt.cooldownUntil ?? 0;
				if (deadline > Date.now()) {
					gpt.resumeAfter429 = { consecutive: gpt.resumeAfter429?.consecutive ?? 1, forceFull: true };
					await this.saveSettings();
					new Notice(`The remaining archive check will run with the ChatGPT retry after ${formatClock(deadline)}.`);
					return;
				}
			}
			await this.runOne({ ...target, forceFull: true }, 'manual');
		});
	}

	private async restoreArchive(target: ArchiveTarget, progress: SyncProgress['update']): Promise<void> {
		const { report, retained } = await restoreSavedChats(this, target, progress);
		const remaining = retained.length ? ` ${retained.length} archive folders kept because they still contain files or could not be removed.` : '';
		new Notice(`${this.targetLabel(target)}: ${report.moved} returned, ${report.skipped.length} skipped, ${report.failed.length} failed.${remaining}`, 10_000);
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

	/** Shows what "Merge chat copies into one note" would do. Reads only. */
	openMergePreview(): void {
		if (this.mergeWaiting || this.merging) {
			new Notice(this.merging ? 'The merge is running. Open the preview again when it has finished.' : MERGE_WAITING_TEXT);
			return;
		}
		if (this.running) {
			new Notice(this.fetchingList ? 'The project list is still loading. Try again when it has finished.' : 'A sync is running. Merge the copies when it has finished.');
			return;
		}
		new MergeModal(this.app, this).open();
	}

	/**
	 * Merges each chat's "(updated …)" notes (and the other copies chosen in the preview) into one
	 * note, and writes a report note saying what was done and which links could not be fixed.
	 */
	async mergeCopies(groups: readonly PreviewGroup[], skipped: MergePreview['skipped']): Promise<MergeResult | null> {
		if (this.mergeWaiting || this.merging) {
			new Notice(this.merging ? 'The merge is already running.' : MERGE_WAITING_TEXT);
			return null;
		}
		let result: MergeResult | null = null;
		let wait: Notice | null = null;
		const hideWait = () => {
			wait?.hide();
			wait = null;
		};
		this.mergeWaiting = true;
		this.busyChanged();
		try {
			const ran = await startMergeWhenIdle({
				running: () => this.running,
				unloaded: () => this.unloaded,
				idle: () => new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
				waiting: () => {
					wait = new Notice(MERGE_WAITING_TEXT, 0);
				},
				start: async () => {
					let ran = false;
					await this.guarded('manual', async () => {
						ran = true;
						hideWait();
						this.mergeWaiting = false;
						this.merging = true;
						this.busyChanged();
						try {
							result = await this.runMergeNow(groups, skipped);
						} finally {
							this.merging = false;
						}
					}, { merge: true });
					return ran;
				},
			});
			if (!ran) new Notice(`AI ChatBridge: ${MERGE_NOT_STARTED_TEXT}`, 15_000);
		} finally {
			hideWait();
			const held = this.mergeWaiting;
			this.mergeWaiting = false;
			this.merging = false;
			this.busyChanged();
			// A retry held back while the merge waited may go now.
			if (held && !this.running) this.scheduleGptResume();
		}
		return result;
	}

	/** The merge itself, inside the sync guard: progress notice, report note and log line, also when stopped. */
	private async runMergeNow(groups: readonly PreviewGroup[], skipped: MergePreview['skipped']): Promise<MergeResult> {
		const notice = new Notice('AI ChatBridge: merging chat copies…', 0);
		let at = 0;
		try {
			let r: MergeResult;
			try {
				r = await runMerge(this.app, this.settings, groups, () => this.saveSettings(), (done, total, name) => {
					at = done;
					notice.setMessage(`AI ChatBridge: merging ${done + 1} of ${total}: ${name}`);
					this.statusEl?.setText(`AI ChatBridge: merging chat copies, ${done + 1} of ${total}`);
				}, () => this.stopRequested);
			} catch (e) {
				// Something outside a single chat went wrong: still say how far it got.
				const message = e instanceof Error ? e.message : String(e);
				console.error('AI ChatBridge: the merge ended with an error', message);
				r = { merged: 0, notesTrashed: 0, versionsKept: 0, linksFixed: 0, filesMoved: 0, linksLeft: [], left: [], failed: [`The merge ended with an error: ${message}`], stopped: `at chat ${at + 1} of ${groups.length} by an error` };
			}
			await this.saveSettings();
			const problems = r.linksLeft.length + r.failed.length;
			r.report = await writeMergeReport(this.app, this.settings, 'merge report', mergeReportText(groups, skipped, r), mergeLogLine(r));
			const head = r.stopped ? `the merge stopped ${r.stopped}; run it again for the rest. Merged ${r.merged} chats.` : `merged ${r.merged} chats.`;
			new Notice(`AI ChatBridge: ${head} ${r.notesTrashed} notes went to the trash, ${r.linksFixed} links were rewritten.${problems ? ` ${problems} things need a look:` : ''} See ${r.report}`, 20_000);
			return r;
		} finally {
			notice.hide();
		}
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

	/** What the Sync button says while nothing runs. */
	private idleSyncLabel(): string {
		return this.remote.role === 'requester' ? 'Ask the computer to sync' : 'Sync all chats';
	}

	/** The Sync button (ribbon, command): a Writer syncs or stops its sync, a Requester asks. */
	pressSync(): void {
		if (this.remote.role === 'requester') void this.remote.ask();
		else if (this.syncing) this.pressStop();
		else void this.syncAll('manual');
	}

	/**
	 * "Sync all" because another device asked. Exactly what the automatic sync does: quiet,
	 * ChatGPT cooldowns left alone, and a source that stopped with an error stays paused until
	 * someone syncs it by hand here (the asking device is told which ones wait).
	 */
	async syncAllRequested(): Promise<void> {
		await this.syncAll('auto');
	}

	/** The sources the automatic sync skips until they are synced by hand, by label. */
	pausedSources(): string[] {
		return [...new Set(this.paused.values())];
	}

	/** Every account you are logged in to, one after the other, then the desktop apps. */
	async syncAll(trigger: 'manual' | 'auto') {
		await this.guarded(trigger, async () => {
			const start = Date.now();
			try {
				await this.syncAllParts(trigger);
			} finally {
				// Only a run that got as far as syncing something is remembered as "Sync all".
				if (Object.values(this.settings.lastRuns).some((r) => r.at >= start)) {
					this.settings.lastAll = { start, at: Date.now(), trigger, stopped: this.stopRequested };
					await this.saveSettings();
				}
			}
		});
	}

	private async syncAllParts(trigger: 'manual' | 'auto') {
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
		// One source that fails (an expired login, say) must not keep the others from syncing:
		// each runs on its own. Only your Stop ends the run, and runOne skips the rest after it.
		for (const account of claude) await this.runPart({ kind: 'claude', account }, trigger);
		for (const account of gpt) {
			const waiting = account.web.resumeAfter429 || (account.web.cooldownUntil ?? 0) > Date.now();
			// A ChatGPT cooldown only waits; other accounts and the desktop apps still run.
			if (trigger !== 'manual' && waiting) continue;
			await this.runPart({ kind: 'chatgpt', account }, trigger);
		}
		for (const account of lumo) await this.runPart({ kind: 'lumo', account }, trigger);
		for (const account of gemini) {
			await this.runPart({ kind: 'gemini', account }, trigger);
			if (account.studio.enabled) await this.runPart({ kind: 'studio', account }, trigger);
		}
		if (desktop) await this.runPart({ kind: 'desktop' }, trigger);
		if (hermes) await this.runPart({ kind: 'hermes' }, trigger);
	}

	/** One part of Sync all: an error is shown and recorded, then the next part runs. */
	private async runPart(target: Target, trigger: SyncTrigger): Promise<void> {
		try {
			await this.runOne(target, trigger);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error(`AI ChatBridge: ${this.targetLabel(target)} failed`, message);
			new Notice(`${this.targetLabel(target)} sync failed: ${message} The other sources still sync.`, 15_000);
		}
	}

	/** One sync at a time. (A source that stopped with an error is skipped by runOne, not here.) */
	private async guarded(trigger: SyncTrigger, fn: () => Promise<unknown>, opts: { merge?: boolean } = {}) {
		if (this.unloaded) return;
		// A phone or tablet cannot sync by itself yet: it has no login windows and must not write
		// beside the computer that does. There the sync button asks the computer (remote/).
		if (Platform.isMobile) {
			if (trigger === 'manual') new Notice('A phone or tablet cannot sync by itself yet. Use the sync button to ask your computer.', 10_000);
			return;
		}
		// A merge waiting for the running sync goes next; only a sync started by hand may go first.
		if (!opts.merge && !mayStartWhileMergeWaits(trigger, this.mergeWaiting)) return;
		if (this.running) {
			if (trigger === 'manual' && !opts.merge) new Notice(this.fetchingList ? 'The project list is still loading. Try again when it has finished.' : 'A sync is already running.');
			return;
		}
		// Another computer syncing this vault right now would write the same notes. You may still
		// go ahead by hand; the automatic sync, a retry and another device's request just wait.
		const other = await this.computers.busyElsewhere();
		if (other) {
			if (trigger !== 'manual') return;
			if (!(await this.syncAnyway(other))) return;
		}
		if (this.running || this.unloaded) return; // something started while we looked
		if (!opts.merge && !mayStartWhileMergeWaits(trigger, this.mergeWaiting)) return;
		this.clearGptResumeTimer();
		this.running = true;
		this.stopRequested = false;
		this.busyChanged();
		const started = Date.now();
		let alive: number | null = null;
		try {
			// What the other computers synced since we last looked, so it is not fetched again.
			await this.mergeOtherComputers();
			await this.computers.markRunning(started);
			alive = window.setInterval(() => void this.computers.markRunning(started), ALIVE_EVERY_MS);
			await fn();
		} finally {
			if (alive !== null) window.clearInterval(alive);
			await this.computers.markIdle();
			this.running = false;
			this.stopRequested = false;
			this.current = null;
			this.busyChanged();
			this.scheduleGptResume();
			if (this.externalPending) void this.onExternalSettingsChange();
			this.wakeIdleWaiters();
			if (!this.fetchingList) void this.upkeepHandoff(false);
		}
	}

	/** Once per vault, on a device that syncs (two devices renaming at once would clash). */
	private async renameSystemFiles(): Promise<void> {
		if (this.unloaded || Platform.isMobile) return;
		try {
			if (await renameOldSystemFiles(this.app, this.settings)) await this.saveSettings();
		} catch (e) {
			console.error('AI ChatBridge: renaming system files failed', e);
		}
	}

	private handoffBusy = false;

	/**
	 * Active Context upkeep (General tab): Live sessions after every sync; the archive pass and
	 * stale "Now" lines once a day. `byHand` runs everything now and reports the result.
	 */
	async upkeepHandoff(byHand: boolean): Promise<void> {
		const h = this.settings.handoff;
		if (this.unloaded || Platform.isMobile || this.handoffBusy) return;
		if (!h.enabled) {
			if (byHand) new Notice('Active Context upkeep is off. Turn it on in the plugin settings, General tab.');
			return;
		}
		this.handoffBusy = true;
		try {
			const today = localDate(new Date().toISOString());
			let daily = null;
			if (byHand || h.lastDaily !== today) {
				daily = await dailyUpkeep(this.app, h, today, byHand);
				if (daily.found) await this.saveSettings();
			}
			const found = await updateLive(this.app, this.settings, Date.now());
			if (!found) {
				if (byHand) new Notice(`Active Context: "${handoffNote(h)}" is a folder, so no note can be made there. Choose another handoff folder.`);
				return;
			}
			if (byHand) {
				const parts = [daily?.created ? `Active Context made in ${h.folder}` : 'Active Context updated'];
				if (daily?.moved) parts.push(`${daily.moved} ${daily.moved === 1 ? 'entry' : 'entries'} moved to the archive`);
				if (daily?.flagged) parts.push(`${daily.flagged} stale ${daily.flagged === 1 ? 'line' : 'lines'} flagged`);
				new Notice(`${parts.join(', ')}.`);
			}
		} catch (e) {
			console.error('AI ChatBridge: Active Context upkeep failed', e);
			if (byHand) new Notice(`Active Context could not be updated: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.handoffBusy = false;
		}
	}

	/** The running sync has ended: a waiting merge may start. */
	private wakeIdleWaiters(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const fn of waiters) fn();
	}

	/** Asks whether to sync while another computer is syncing. */
	private syncAnyway(other: BusyMarker): Promise<boolean> {
		return new Promise((resolve) => {
			let yes = false;
			const modal = new ConfirmModal(this.app, 'Another computer is syncing',
				`${busyText(other, formatClock)} If both sync at once, they may both write the same notes. Wait until it has finished, or sync here anyway.`,
				'Sync here anyway', () => {
					yes = true;
				});
			const close = modal.onClose.bind(modal);
			modal.onClose = () => {
				close();
				resolve(yes);
			};
			modal.open();
		});
	}

	/** Brings in what the other computers synced (see computers/merge.ts). */
	async mergeOtherComputers(): Promise<number> {
		try {
			const n = await this.computers.mergeOthers(this.settings, (path) => findFile(this.app, path) !== null);
			if (n) await this.saveSettings();
			return n;
		} catch (e) {
			console.error('AI ChatBridge: could not read the other computers\' history', e instanceof Error ? e.message : e);
			return 0;
		}
	}

	/** data.json was changed by another computer (through the vault's sync): take its settings, keep our history. */
	async onExternalSettingsChange(): Promise<void> {
		if (this.unloaded) return;
		if (this.running) {
			this.externalPending = true;
			return;
		}
		this.externalPending = false;
		const loaded = (await this.loadData()) as unknown;
		if (!this.computers.isNewShared(loaded)) return;
		const { local } = splitSettings(this.settings, this.computers.here);
		this.settings = normalizeSettings(joinSaved(loaded, local)).settings;
		this.computers.noteShared(loaded);
		this.restartTimer();
		this.restartMemoryTimer();
		this.busyChanged();
	}

	/** A sync (not a project-list fetch) is running, so it can be stopped. */
	get syncing(): boolean {
		return this.running && !this.fetchingList;
	}

	get stopping(): boolean {
		return this.stopRequested;
	}

	/** This account (or this account's desktop app, also as part of its provider's button) is the one syncing right now. */
	isSyncing(provider: Provider, id: string): boolean {
		return this.syncing && this.current?.provider === provider && (this.current.id === id || this.current.id === undefined);
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

	/**
	 * The Sync button, the status bar and **Stop all**: stop a sync, but not a running merge, which
	 * a press meant as "sync" would cut off part-way. The Stop command still stops a merge.
	 */
	pressStop(): void {
		if (this.merging) {
			new Notice(MERGE_NOT_STOPPED_TEXT, 15_000);
			return;
		}
		this.requestStop();
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
			this.ribbonEl.setAttr('aria-label', running ? (this.stopRequested ? 'Stopping the sync…' : this.merging ? 'Merging chat copies…' : 'Stop sync') : this.idleSyncLabel());
			this.ribbonEl.toggleClass('is-syncing', running);
		}
		const stoppable = running && !this.stopRequested;
		this.statusEl?.toggleClass('ccs-status-stoppable', stoppable);
		if (stoppable) this.statusEl?.setAttr('aria-label', this.merging ? 'Merging chat copies' : 'Select to stop the sync');
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
		return this.running || this.mergeWaiting;
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
			this.wakeIdleWaiters();
		}
	}

	private targetLabel(target: Target): string {
		if (target.kind === 'claude') return withAccount('claude.ai', this.settings.claude, target.account);
		if (target.kind === 'chatgpt') return this.gptLabel(target.account);
		if (target.kind === 'lumo') return withAccount('Lumo', this.settings.lumo, target.account);
		if (target.kind === 'gemini') return withAccount('Gemini', this.settings.gemini, target.account);
		if (target.kind === 'studio') return withAccount('AI Studio', this.settings.gemini, target.account);
		if (target.kind === 'hermes') return target.label ?? 'Hermes';
		if (target.kind === 'memory') return 'AI memory';
		return target.label ?? 'Desktop apps';
	}

	/** Runs one account or the desktop apps and shows the result. Returns false if it stopped. */
	private async runOne(target: Target, trigger: SyncTrigger): Promise<boolean> {
		// After a stop, the accounts still queued in this run are skipped.
		if (this.stopRequested) return false;
		const key = this.runKeyOf(target);
		// A source that stopped with an error waits for you; the automatic sync leaves it out.
		if (trigger === 'auto' && this.paused.has(key)) return false;
		const label = this.targetLabel(target);
		// Progress bar in a notice (manual syncs) and a percentage in the status bar (all syncs).
		const progress = new SyncProgress(label, this.statusEl, trigger === 'manual',
			target.kind === 'chatgpt' ? () => chatCountStatus(target.account.web.chatProgress, label) : undefined,
			() => this.requestStop());
		this.progress = progress;
		this.current = target.kind === 'memory'
			? { memory: true }
			: target.kind === 'hermes'
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
			if ((target.kind === 'claude' || target.kind === 'chatgpt') && hasArchiveToRestore(target)) {
				try {
					await this.restoreArchive(target, update);
				} catch (error) {
					if (!(error instanceof StopError) || !this.stopRequested) throw error;
					new Notice(`${label}: archive migration stopped. The next sync carries on from there.`);
					return false;
				}
			}
			r = target.kind === 'claude' ? await runSync(this, target.account, update)
				: target.kind === 'chatgpt' ? await runGptSync(this, target.account, update, target.forceFull)
				: target.kind === 'lumo' ? await runLumoSync(this, target.account, update)
				: target.kind === 'gemini' ? await runGeminiSync(this, target.account, update)
				: target.kind === 'studio' ? await runStudioSync(this, target.account, update)
				: target.kind === 'hermes' ? await runHermesSync(this, update, target.profileId)
				: target.kind === 'memory' ? await runMemorySync(this, update)
				: await runDesktopSync(this, update, undefined, undefined, target.only);
		} catch (e) {
			this.paused.set(key, label);
			await this.recordRun(target, label, trigger, 'error', undefined, e instanceof Error ? e.message : String(e));
			throw e;
		} finally {
			progress.finish();
			this.progress = null;
		}
		await this.recordRun(target, label, trigger,
			this.stopRequested ? 'stopped'
				: 'nothingSelected' in r && r.nothingSelected ? 'nothing-selected'
				: r.stopped ? ('resumeAt' in r && typeof r.resumeAt === 'number' ? 'waiting' : 'error')
				: 'ok',
			r,
			this.stopRequested ? undefined : r.stopped ?? ('missing' in r && r.missing.length ? `Skipped, not found: ${r.missing.join(', ')}.` : 'nothing' in r && r.nothing.length ? `Nothing to read for: ${r.nothing.join(', ')}.` : undefined));
		if (this.stopRequested) {
			const saved = r.newCount + r.changedCount;
			const moved = 'archive' in r && r.archive?.moved ? `, ${r.archive.moved} moved` : '';
			new Notice(`${label}: stopped. ${saved ? `${saved} saved before stopping` : 'Nothing new was saved'}${moved}; the next sync carries on from there.`, 8000);
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
			this.paused.set(key, label);
			new Notice(`${label} sync stopped: ${r.stopped}`, 15_000);
			return false;
		}
		this.paused.delete(key);
		const archive = 'archive' in r ? r.archive : undefined;
		if (trigger === 'manual' || r.written.length || r.restored.length || archive?.moved || archive?.skipped.length || archive?.failed.length) {
			const active = 'active' in r && r.active ? `, ${r.active} still active` : '';
			const more = (r.leftForLater ? `, ${r.leftForLater} left for next run` : '') + active;
			const restored = r.restored.length ? `, ${r.restored.length} restored` : '';
			// Hermes profiles whose state.db is gone were skipped; say so, so a quiet result isn't a surprise.
			const gone = 'missing' in r && r.missing.length ? ` Skipped, not found: ${r.missing.join(', ')}.` : 'nothing' in r && r.nothing.length ? ` Nothing to read for: ${r.nothing.join(', ')}.` : '';
			// A one-account desktop run: say so when another account has sessions waiting.
			const others = 'elsewhere' in r ? elsewhereText(r.elsewhere) : '';
			const archiveStatus = archive ? ` Archived chats: ${archive.moved} moved, ${archive.skipped.length} skipped, ${archive.failed.length} failed.` : '';
			new Notice(`${label}: ${r.newCount} new, ${r.changedCount} changed, ${r.unchanged} unchanged${restored}${more}.${archiveStatus}${gone}${others ? ` ${others}` : ''}`, others ? 15_000 : undefined);
		}
		return true;
	}

	/** Where a run's result is filed, so the settings can show it (see last-run.ts). */
	private runKeyOf(target: Target): string {
		if (target.kind === 'hermes') return HERMES;
		if (target.kind === 'memory') return MEMORY;
		if (target.kind === 'desktop') return target.only ? runKey('desktop', target.only.provider, target.only.id ?? DESKTOP_EVERY_ACCOUNT) : DESKTOP_ALL;
		if (target.kind === 'studio') return runKey('studio', 'gemini', target.account.id);
		return runKey('web', target.kind, target.account.id);
	}

	private async recordRun(target: Target, label: string, trigger: SyncTrigger, outcome: RunOutcome, r?: { newCount: number; changedCount: number; unchanged: number; restored: unknown[]; leftForLater?: number }, note?: string): Promise<void> {
		const run: LastRun = {
			at: Date.now(),
			trigger,
			outcome,
			label,
			newCount: r?.newCount ?? 0,
			changedCount: r?.changedCount ?? 0,
			unchanged: r?.unchanged ?? 0,
			restored: r?.restored.length ?? 0,
			leftForLater: r?.leftForLater ?? 0,
		};
		if (note) run.note = note.length > 300 ? `${note.slice(0, 300)}…` : note;
		this.settings.lastRuns[this.runKeyOf(target)] = run;
		try {
			await this.saveSettings();
		} catch (e) {
			console.error('AI ChatBridge: could not save the last run', e instanceof Error ? e.message : e);
		}
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as unknown;
		// data.json holds what you set; this computer's file what it synced (see computers/).
		const { raw, firstSplit, putAside } = await this.computers.load(loaded);
		const { settings, migrated } = normalizeSettings(raw);
		this.settings = settings;
		if (migrated) await this.keepOldSettings(loaded);
		if (firstSplit) {
			await this.keepOldSettings(loaded, 'data.before-computers.json');
			await this.saveSettings();
			if (putAside) new Notice('AI ChatBridge: the Claude Code and Hermes history in the settings is from another computer, so it was put aside for that one.', 15_000);
		}
	}

	/** One copy of the settings from before a change of format, in case you ever go back a version. */
	private async keepOldSettings(loaded: unknown, name = 'data.before-accounts.json'): Promise<void> {
		const dir = this.manifest?.dir;
		if (!dir) return;
		const path = `${dir}/${name}`;
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
		const write = this.settingsWrite.then(() => this.computers.save(this.settings, (data) => this.saveData(data)));
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

/** Plugin, Obsidian and system, for the error log (no names, no paths). */
export function errorLogEnvironment(version: string): string {
	const system = Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'unknown system';
	return `AI ChatBridge ${version} · Obsidian ${apiVersion} · ${system}`;
}
