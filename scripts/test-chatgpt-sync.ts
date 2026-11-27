import assert from 'node:assert/strict';
import { Notice, Platform, TFile, TFolder, testHooks } from 'obsidian';
import { BlockedLinkError, GptApi, NETWORK_RETRY_WAITS_MS, sandboxLink } from '../src/chatgpt/api';
import { runGptSync } from '../src/chatgpt/sync';
import { GptRateLimitError, retryDeadline } from '../src/chatgpt/recovery';
import { sandboxKey } from '../src/chatgpt/files';
import { checkGptChat, checkGptOlderPage } from '../src/chatgpt/schema';
import { DEFAULT_SETTINGS, DEFAULT_GPT } from '../src/settings';
import AIChatBridge, { formatClock } from '../src/main';
import { StopError } from '../src/api';
import { DESKTOP_ALL } from '../src/last-run';
import { planArchiveLinks, rebaseArchiveLinks } from '../src/archive-links';
import { hasArchiveToRestore, restoreSavedChats, separateSavedChats } from '../src/archive-local';

const id = '12345678-1234-1234-1234-123456789abc';
const date = '2026-11-06T09:00:00Z';
const message = (messageId: string, text: string) => ({
	id: messageId, author: { role: 'assistant' },
	content: { content_type: 'text', parts: [text] },
});
const marker = '\uE200cite\uE202test\uE201';
const top = {
	conversation_id: id, title: 'Fixture', create_time: 1793955600, update_time: 1793955600, gizmo_id: null,
	messages: [{ ...message('message-new', '[PDF](sandbox:/mnt/data/demo%20(1).pdf) ' + marker), metadata: {
		content_references: [{ matched_text: marker, items: [{ url: 'https://example.org/reference' }] }],
	} }],
	page_info: { has_previous_page: true, start_cursor: 'message-new' },
};
const older = { messages: [message('message-old', 'Older text')], page_info: { has_previous_page: false } };
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).buffer;
const raw = (json: unknown) => ({ json, bytes: bytes(JSON.stringify(json)) });

async function testAutomaticResume() {
	const originalWindow = globalThis.window;
	const realNow = Date.now;
	const connect = GptApi.connect;
	let now = realNow();
	let calls = 0;
	let outcome: 'limit' | 'success' | 'login-error' = 'limit';
	let serial = 0;
	let status = '';
	const timers = new Map<number, { due: number; callback: () => void }>();
	const h = harness();
	let persisted = structuredClone(h.settings);
	persisted.chatgpt[0]!.web.chatProgress = { inventoryKey: 'account:retry-test', scope: '[true,[],"",[]]', saved: 285, total: 926 };
	const commands = new Map<string, { checkCallback?: (checking: boolean) => boolean }>();
	const flush = async (done: () => boolean) => {
		for (let n = 0; n < 100; n++) {
			if (done()) return;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		throw new Error('Timed out waiting for automatic retry');
	};
	const load = async () => {
		const p = Object.assign(new AIChatBridge(), {
			app: { ...h.plugin.app, workspace: { onLayoutReady: (fn: () => void) => fn(), on: () => ({}) },
				// Device storage (role, device name): nothing saved, so this is a computer that syncs itself.
				loadLocalStorage: () => null, saveLocalStorage: () => {},
				vault: { ...h.plugin.app.vault, on: () => ({}) } },
			loadData: async () => structuredClone(persisted),
			saveData: async (settings: typeof persisted) => { persisted = structuredClone(settings); },
			addStatusBarItem: () => ({ setText: (text: string) => { status = text; }, toggleClass: () => {}, setAttr: () => {}, removeAttribute: () => {} }),
			addRibbonIcon: () => ({ addClass: () => {}, toggleClass: () => {}, setAttr: () => {} }),
			registerDomEvent: () => {},
			addCommand: (command: { id: string; checkCallback?: (checking: boolean) => boolean }) => commands.set(command.id, command),
			addSettingTab: () => {},
			registerInterval: () => 0,
			registerEvent: () => {},
			registerMarkdownPostProcessor: () => {},
		});
		await p.onload();
		return p;
	};
	Date.now = () => now;
	Object.assign(globalThis, { window: {
		setTimeout: (callback: () => void, delay: number) => {
			if (delay === h.settings.delaySeconds * 1000) return setTimeout(callback, 0);
			timers.set(++serial, { due: now + delay, callback });
			return serial;
		},
		clearTimeout: (id: number) => { timers.delete(id); },
		setInterval: () => 999,
		clearInterval: () => {},
	}, document: { visibilityState: 'visible' } });
	GptApi.connect = async () => {
		calls++;
		if (outcome === 'limit') throw new GptRateLimitError(now + 1000);
		if (outcome === 'login-error') throw new StopError('Login required');
		return {
			inventoryKey: 'account:retry-test',
			listPath: () => 'list',
			projectPagePath: () => 'projects',
			get: async (path: string) => raw(path === 'list' ? { items: [], offset: 0, total: 0 } : { items: [] }),
		} as unknown as GptApi;
	};
	const fire = (due: number) => {
		const [entry] = timers.entries();
		assert(entry);
		assert(entry[1].due <= due);
		now = due;
		timers.delete(entry[0]);
		entry[1].callback();
	};
	try {
		let p = await load();
		await p.syncGpt('auto');
		assert.equal(calls, 1);
		assert.equal(persisted.chatgpt[0]!.web.cooldownUntil, now + 30_000);
		assert.equal(persisted.chatgpt[0]!.web.resumeAfter429?.consecutive, 1);
		assert.equal(status, 'ChatGPT: 285 of 926 chats saved · retry in 00:30');
		p.onunload();
		assert.equal(timers.size, 0);
		assert.equal(status, '');
		p = await load();
		assert.equal(calls, 1);
		const due = persisted.chatgpt[0]!.web.cooldownUntil!;
		fire(now + 1000);
		assert.equal(status, 'ChatGPT: 285 of 926 chats saved · retry in 00:29');
		assert.equal(calls, 1);
		fire(due);
		await flush(() => timers.size === 1 && persisted.chatgpt[0]!.web.resumeAfter429?.consecutive === 2);
		assert.equal(calls, 2);
		assert.equal(persisted.chatgpt[0]!.web.cooldownUntil, due + 60_000);
		assert.equal(status, 'ChatGPT: 285 of 926 chats saved · retry in 01:00');
		outcome = 'success';
		fire(persisted.chatgpt[0]!.web.cooldownUntil!);
		await flush(() => calls === 3 && !persisted.chatgpt[0]!.web.resumeAfter429 && status === '');
		assert.equal(timers.size, 0);
		// Idle after a finished sync: the status bar is cleared.
		assert.equal(status, '');

		outcome = 'limit';
		await p.syncGpt('auto');
		assert.equal(timers.size, 1);
		assert(commands.get('cancel-chatgpt-retry')?.checkCallback?.(false));
		await flush(() => persisted.chatgpt[0]!.web.resumeAfter429 === null);
		assert.equal(timers.size, 0);
		assert(persisted.chatgpt[0]!.web.cooldownUntil! > now);
		p.onunload();
		p = await load();
		assert.equal(timers.size, 0);

		// A pre-upgrade cooldown can be adopted, then a login error disarms it.
		delete persisted.chatgpt[0]!.web.resumeAfter429;
		p.onunload();
		p = await load();
		assert.equal(timers.size, 1);
		outcome = 'login-error';
		fire(persisted.chatgpt[0]!.web.cooldownUntil!);
		await flush(() => !persisted.chatgpt[0]!.web.resumeAfter429);
		assert.equal(timers.size, 0);

		// Automatic sync on and idle: the status bar says so, and names the source an error paused.
		p.settings.intervalMinutes = 30;
		p.restartTimer();
		assert.equal(status, `AI ChatBridge: next sync ${formatClock(now + 30 * 60_000)} · waiting for you: ChatGPT`, 'paused after the login error');

		// Sync all: ChatGPT's expired login must not keep the desktop apps (Claude Code) from syncing.
		// (No computer here, so the desktop run itself reports an error; what counts is that it ran.)
		p.canSyncWeb = async (provider) => provider === 'chatgpt';
		p.settings.claude[0]!.desktop.enabled = true;
		// A sync by hand shows a progress notice; give it stand-in elements.
		const el: Record<string, unknown> = { style: {}, parentElement: null, setText: () => {}, toggleClass: () => {}, addEventListener: () => {} };
		el.createDiv = el.createEl = () => el;
		const realHide = (Notice.prototype as { hide?: () => void }).hide;
		Object.assign(Notice.prototype, { hide: () => {} });
		Object.assign(globalThis, { createFragment: (fn: (f: unknown) => void) => (fn(el), el) });
		const before = calls;
		now += 1000;
		await p.syncAll('manual');
		assert.equal(calls, before + 1, 'Sync all tried ChatGPT');
		assert.equal(p.settings.lastRuns['web:chatgpt:default']?.outcome, 'error');
		assert.equal(p.settings.lastRuns[DESKTOP_ALL]?.at, now, 'the desktop apps still ran after ChatGPT failed');
		// The automatic Sync all leaves out only what stopped with an error, and still runs the rest.
		const desktopBefore = p.settings.lastRuns[DESKTOP_ALL]!.at;
		outcome = 'success';
		now += 1000;
		p.settings.lastRuns[DESKTOP_ALL]!.at = 0;
		await p.syncAll('auto');
		assert.equal(calls, before + 1, 'the paused ChatGPT is skipped by the automatic sync');
		assert.equal(p.settings.lastRuns[DESKTOP_ALL]?.at, 0, 'the desktop apps failed too, so they are paused as well');
		p.settings.lastRuns[DESKTOP_ALL]!.at = desktopBefore;
		// A sync by hand that works clears the pause for that source.
		// The ChatGPT button syncs everything from ChatGPT: its chats, then Codex on this computer.
		now += 1000;
		await p.syncGpt('manual');
		assert.equal(calls, before + 2);
		assert.equal(p.settings.lastRuns['desktop:chatgpt:*']?.at, now, 'the ChatGPT button ran Codex too');
		assert.equal(p.settings.lastRuns['desktop:claude:*'], undefined, 'and not Claude Code');
		p.restartTimer();
		assert.equal(status, `AI ChatBridge: next sync ${formatClock(now + 30 * 60_000)} · waiting for you: Desktop apps, Codex`, 'ChatGPT no longer waits');
		// The Claude button: claude.ai, then Claude Code, even though claude.ai fails here (no network in tests).
		now += 1000;
		await p.sync('manual');
		assert.equal(p.settings.lastRuns['desktop:claude:*']?.at, now, 'the Claude button ran Claude Code too');
		assert.equal(p.settings.lastRuns['desktop:claude:*']?.label, 'Claude Code');
		Object.assign(Notice.prototype, { hide: realHide });
		delete (globalThis as { createFragment?: unknown }).createFragment;
		p.onunload();
		p = await load();
		p.settings.intervalMinutes = 30;
		p.restartTimer();
		assert.equal(status, `AI ChatBridge: next sync ${formatClock(now + 30 * 60_000)}`);
		p.settings.intervalMinutes = 0;
		p.restartTimer();
		assert.equal(status, '');
		p.onunload();
		console.log('Automatic 429 retry passed: visible countdown, persisted timer, restart, backoff, success, cancellation, login-error stop and next-sync time.');
	} finally {
		Date.now = realNow;
		GptApi.connect = connect;
		Object.assign(globalThis, { window: originalWindow });
	}
}

/** A Map whose every write moves that path's modified time on, like a real disk. */
class StampedMap<V> extends Map<string, V> {
	clock = 0;
	times = new Map<string, number>();
	override set(key: string, value: V): this {
		this.times?.set(key, ++this.clock);
		return super.set(key, value);
	}
}

async function testArchiveSettingTiming() {
	const h = harness();
	const { settings } = h;
	const gpt = settings.chatgpt[0]!;
	const claude = settings.claude[0]!;
	const runs: { kind: string; forceFull?: boolean }[] = [];
	let saved = 0;
	const plugin = new AIChatBridge();
	const hooks = {
		settings,
		app: h.plugin.app,
		saveSettings: async () => { saved++; },
		guarded: async (_trigger: string, fn: () => Promise<unknown>) => { await fn(); },
		runOne: async ({ kind, forceFull }: typeof runs[number]) => { runs.push({ kind, forceFull }); },
	};
	Object.assign(plugin, hooks);
	Object.assign(globalThis, { createFragment: () => ({}) });
	gpt.web.separateArchived = true;
	await plugin.syncArchivedNow('chatgpt', gpt.id);
	assert.deepEqual(runs, [], 'inclusion is required even if the saved separation preference is on');
	gpt.web.includeArchived = true;
	gpt.web.cooldownUntil = Date.now() + 60_000;
	gpt.web.resumeAfter429 = { consecutive: 3, forceFull: false };
	const md = 'Chats/Unknown.md';
	const json = 'Chats/Unknown.json';
	gpt.web.index[id] = { md, json, synced: date, updated_at: date };
	await plugin.app.vault.create(json, JSON.stringify({ conversation_id: id, is_archived: false }));
	await plugin.syncArchivedNow('chatgpt', gpt.id);
	assert.deepEqual(runs, [], 'a known status needs no server check');
	assert.deepEqual(gpt.web.resumeAfter429, { consecutive: 3, forceFull: false });
	await plugin.app.vault.modify(plugin.app.vault.getAbstractFileByPath(json) as TFile, JSON.stringify({ conversation_id: id }));
	await plugin.syncArchivedNow('chatgpt', gpt.id);
	assert.deepEqual(runs, [], 'during cooldown no manual sync starts');
	assert.equal(saved, 1);
	assert.deepEqual(gpt.web.resumeAfter429, { consecutive: 3, forceFull: true });
	gpt.web.cooldownUntil = Date.now() - 1;
	await plugin.syncArchivedNow('chatgpt', gpt.id);
	assert.deepEqual(runs.pop(), { kind: 'chatgpt', forceFull: true });
	claude.web.includeArchived = claude.web.separateArchived = true;
	claude.web.index[id] = { md, json: 'Chats/Missing.json', synced: date, updated_at: date };
	await plugin.syncArchivedNow('claude', claude.id);
	assert.deepEqual(runs.pop(), { kind: 'claude', forceFull: true });
	assert.deepEqual(runs, []);
	console.log('Archive settings timing passed: inclusion guard, account sync, full check and cooldown retry.');
}

function harness() {
	const entries = new Map<string, TFile | TFolder>();
	const contents = new StampedMap<ArrayBuffer>();
	/** The plugin's own main.js: a new build moves its time on. */
	const manifest = { dir: '.obsidian/plugins/ai-chatbridge', version: 'test' };
	let buildTime = 1;
	/** Raw pages read by path: shows which chats the sync opened. */
	const reads: string[] = [];
	const settings = structuredClone({ ...DEFAULT_SETTINGS, logPath: 'Logs/sync.md' });
	// A deep copy: the defaults' index objects must not carry one test's chats into the next.
	settings.chatgpt[0]!.web = { ...structuredClone(DEFAULT_GPT), folder: 'Chats', includeArchived: true };
	let saved = structuredClone(settings);
	/** How often the index was written. */
	let saves = 0;
	let crashOnOlder = false;
	let crashAfterRename = false;
	const moved: [string, string][] = [];
	/** Paths whose content was replaced (the one-note rule), in order. */
	const rewritten: string[] = [];
	const read = (path: string) => new TextDecoder().decode(contents.get(path));
	const put = (path: string, content: ArrayBuffer) => {
		assert(!entries.has(path), 'original was overwritten');
		if (crashOnOlder && path.endsWith('(older 1).json')) {
			crashOnOlder = false;
			throw new Error('simulated interruption while saving an older page');
		}
		const f = Object.assign(new TFile(path, { size: content.byteLength, ctime: entries.size + 1, mtime: entries.size + 1 } as { size: number }), {
			name: path.split('/').at(-1),
		});
		entries.set(path, f);
		const parent = entries.get(path.slice(0, path.lastIndexOf('/')));
		if (parent instanceof TFolder) parent.children.push(f);
		contents.set(path, content);
		return f;
	};
	const vault = {
		getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
		createFolder: async (path: string) => { entries.set(path, new TFolder(path)); },
		createBinary: async (path: string, content: ArrayBuffer) => put(path, content),
		create: async (path: string, text: string) => put(path, bytes(text)),
		process: async (file: TFile, fn: (value: string) => string) => { contents.set(file.path, bytes(fn(read(file.path)))); },
		read: async (file: TFile) => read(file.path),
		readBinary: async (file: TFile) => contents.get(file.path)!,
		modify: async (file: TFile, text: string) => { rewritten.push(file.path); contents.set(file.path, bytes(text)); },
		modifyBinary: async (file: TFile, content: ArrayBuffer) => { rewritten.push(file.path); contents.set(file.path, content); },
		adapter: {
			readBinary: async (path: string) => { reads.push(path); return contents.get(path)!; },
			read: async (path: string) => { reads.push(path); return read(path); },
			stat: async (path: string) => {
				if (path === `${manifest.dir}/main.js`) return { type: 'file', size: 1000, mtime: buildTime };
				if (!(entries.get(path) instanceof TFile) || !contents.has(path)) return null;
				return { type: 'file', size: contents.get(path)!.byteLength, mtime: contents.times.get(path)! };
			},
			exists: async (path: string) => entries.has(path),
			list: async (path: string) => {
				const children = [...entries.values()].filter((entry) => entry.path.startsWith(path + '/') && !entry.path.slice(path.length + 1).includes('/'));
				return { folders: children.filter((entry) => entry instanceof TFolder).map((entry) => entry.path), files: children.filter((entry) => entry instanceof TFile).map((entry) => entry.path) };
			},
			rmdir: async (path: string, recursive: boolean) => {
				assert.equal(recursive, false);
				assert(![...entries.keys()].some((entry) => entry.startsWith(path + '/')));
				assert(entries.get(path) instanceof TFolder);
				entries.delete(path);
			},
		},
	};
	const plugin = {
		manifest, settings, app: { vault, fileManager: {
			processFrontMatter: async () => {},
			trashFile: async (file: TFile) => { entries.delete(file.path); contents.delete(file.path); },
			renameFile: async (file: TFile, path: string) => {
				assert(!entries.has(path), 'a move would overwrite a file');
				const from = file.path;
				moved.push([from, path]);
				entries.set(path, file);
				contents.set(path, contents.get(from)!);
				entries.delete(from);
				contents.delete(from);
				file.path = path;
				if (crashAfterRename) {
					crashAfterRename = false;
					throw new Error('simulated interruption after moving a file');
				}
			},
		} },
		saveSettings: async () => { saves++; saved = structuredClone(settings); },
	} as unknown as AIChatBridge;
	return { settings, entries, contents, plugin, read, rewritten, reads, moved,
		newBuild: () => { buildTime++; },
		interrupt: () => { crashOnOlder = true; },
		interruptMove: () => { crashAfterRename = true; },
		restart: () => { Object.assign(settings.chatgpt[0]!.web, structuredClone(saved.chatgpt[0]!.web)); },
		saves: () => saves,
	};
}

async function testLocalArchiveToggle() {
	const h = harness();
	const { settings, plugin } = h;
	const account = settings.chatgpt[0]!;
	const { web } = account;
	const target = { kind: 'chatgpt', account } as const;
	const { vault } = plugin.app;
	const stages: string[] = [];
	const progress = (msg: string) => stages.push(msg);
	web.projectSubfolders = true;
	web.separateArchived = true;
	const activeFolders = ['Chats/Project', 'Chats/Unclassified', 'My own/Other chats'];
	const saved = activeFolders.map((folder, i) => {
		const key = `chat-${i}`;
		const md = `${folder}/Renamed ${i}.md`;
		const json = `80 Archive/raw/${folder}/Renamed ${i}.json`;
		web.index[key] = { md, json, synced: date, updated_at: date };
		return { key, md, json };
	});
	for (const { key, md, json } of saved) {
		await vault.create(md, 'A hand edit');
		await vault.create(json, JSON.stringify({ conversation_id: key, gizmo_id: null, is_archived: true }));
	}
	const unknownId = 'unknown';
	const unknownMd = 'Chats/Unclassified/Unknown.md';
	const unknownJson = '80 Archive/raw/Chats/Unclassified/Unknown.json';
	await vault.create(unknownMd, 'Unclassified');
	await vault.create(unknownJson, JSON.stringify({ conversation_id: 'different', gizmo_id: null, is_archived: true }));
	web.index[unknownId] = { md: unknownMd, json: unknownJson, synced: date, updated_at: date };
	const parked = await separateSavedChats(plugin, target, progress);
	assert.equal(parked.unresolved, 1, 'a JSON with the wrong chat ID is never used');
	assert.equal(parked.report.moved, 3);
	assert(stages.includes('moving archived chats 3 of 3'));
	assert.equal(web.index[unknownId]!.md, unknownMd);
	assert.match(web.index[saved[2]!.key]!.md, /^Chats\/Archived\/_External\/My own\/Other chats\//);

	web.separateArchived = false;
	await vault.create(saved[0]!.md, 'A collision');
	await vault.create('Chats/Archived/Keep.md', 'A private note');
	const partial = await restoreSavedChats(plugin, target, progress);
	assert.equal(partial.report.moved, 2);
	assert.equal(partial.report.skipped.length, 1);
	assert.deepEqual(partial.retained.sort(), ['80 Archive/raw/Chats/Archived', 'Chats/Archived']);
	assert(hasArchiveToRestore(target));
	assert.equal(h.read(saved[0]!.md), 'A collision');
	h.entries.delete(saved[0]!.md);
	h.contents.delete(saved[0]!.md);
	const recovered = await restoreSavedChats(plugin, target, progress);
	assert.equal(recovered.report.moved, 1);
	assert(stages.includes('returning archived chats 3 of 3'));
	assert.deepEqual(recovered.retained, ['Chats/Archived']);
	assert(!h.entries.has('80 Archive/raw/Chats/Archived'));
	assert.equal(h.read('Chats/Archived/Keep.md'), 'A private note');
	assert(!hasArchiveToRestore(target));
	for (const { key, md, json } of saved) {
		assert.equal(web.index[key]!.md, md);
		assert.equal(web.index[key]!.json, json);
		assert.equal(h.read(md), 'A hand edit');
		assert.equal(JSON.parse(h.read(json)).is_archived, true);
	}
	h.entries.delete('Chats/Archived/Keep.md');
	h.contents.delete('Chats/Archived/Keep.md');
	assert.equal((await restoreSavedChats(plugin, target, progress)).retained.length, 0);
	assert(!h.entries.has('Chats/Archived'));
	web.separateArchived = true;
	assert.equal((await separateSavedChats(plugin, target, progress)).report.moved, 3);
	console.log('Local archive toggle passed: JSON identity, project and custom paths, safe cleanup and retry.');
}

async function testArchiveRelativeLink() {
	const h = harness();
	const vault = h.plugin.app.vault;
	const from = 'Chats/First/Chat.md';
	const to = 'Chats/Archived/First/Chat.md';
	const target = await vault.create('Index files/Guide (1).md', 'Heading');
	const original = '[keep the label](<../../Index files/Guide (1).md#Heading> "keep the title")';
	const note = await vault.create(from, original);
	const index = { md: from, json: 'Chats/First/Chat.json', synced: date, updated_at: date };
	Object.assign(h.plugin.app, { metadataCache: {
		getFileCache: () => ({ links: [{ original, link: '../../Index files/Guide (1).md#Heading', position: { start: { offset: 0 }, end: { offset: original.length } } }] }),
		getFirstLinkpathDest: () => target,
	} });
	const plan = planArchiveLinks(h.plugin.app, index, note, to, new Map());
	await h.plugin.app.fileManager.renameFile(note, to);
	await rebaseArchiveLinks(h.plugin.app, index, note, plan);
	assert.equal(h.read(to), '[keep the label](<../../../Index%20files/Guide%20%281%29.md#Heading> "keep the title")');
}

async function testArchivedPlacement() {
	const h = harness();
	const account = h.settings.chatgpt[0]!;
	const web = account.web;
	web.downloadFiles = true;
	const projectA = 'g-p-0000000000000001';
	const projectB = 'g-p-0000000000000002';
	const other = '12345678-1234-1234-1234-123456789abd';
	const loose = '12345678-1234-1234-1234-123456789abe';
	const firstProject = '12345678-1234-1234-1234-123456789abf';
	const archivedFirst = new Set([other, loose, firstProject]);
	const projects = (key: string, name: string) => ({ gizmo: { gizmo: { id: key, display: { name } } } });
	const rows = [id, other, loose, firstProject].map((chatId, i) => ({
		id: chatId, title: chatId === firstProject ? 'Separate fixture' : 'Fixturé',
		create_time: date, update_time: date, gizmo_id: [projectA, projectB, null, projectA][i],
	}));
	let both = false;
	let incomplete = false;
	let limited = false;
	let requests = 0;
	let repeatAssets = 0;
	let showNew = false;
	const connect = GptApi.connect;
	GptApi.connect = async () => ({
		inventoryKey: 'account:archive-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned: boolean) => `list:${offset}:${tpp}:${archived}:${pinned}`,
		projectPagePath: () => 'projects', chatPath: (chatId: string) => `chat:${chatId}`, olderPath: () => 'older', redact: (v: string) => v,
		get: async (path: string) => {
			if (path === 'projects') return raw({ items: [projects(projectA, 'First'), projects(projectB, 'Second')] });
			if (path.startsWith('list:')) {
				const [, offset, tpp, archived, pinned] = path.split(':');
				if (limited && archived === 'true') throw new GptRateLimitError(Date.now() + 60_000);
				const items = tpp === 'true' || pinned === 'true' ? [] : rows.filter((row) =>
					(showNew || row.id === id) && (archivedFirst.has(row.id) === (archived === 'true') || (both && row.id === id)));
				return raw({ items: incomplete && archived === 'true' ? [] : items, offset: Number(offset), total: items.length });
			}
			requests++;
			if (path === 'older') return raw(older);
			const chatId = path.slice(5);
			return raw({ ...top, conversation_id: chatId, messages: chatId === id ? top.messages : [message('message-two', 'Another fixture')] });
		},
		sandboxBytes: async () => { repeatAssets++; return bytes('synthetic PDF'); },
	} as unknown as GptApi);
	try {
		web.recentFolderName = 'Unclassified';
		h.settings.maxChatsPerRun = 1;
		assert.equal((await runGptSync(h.plugin, account)).newCount, 1);
		const active = web.index[id]!.md;
		const activeRaw = web.index[id]!.json;
		const activeOlder = web.index[id]!.older![0]!;
		assert.match(active, /^Chats\/First\//);
		assert.equal(web.index[other], undefined);
		const ownVersion = activeRaw.replace('.json', ' (version fixture).json');
		await h.plugin.app.vault.createBinary(ownVersion, bytes('historic bytes'));
		web.index[id]!.versions = [{ at: date, files: [ownVersion] }];
		// Render the existing history before simulating a manual edit.
		h.settings.maxChatsPerRun = 0;
		await runGptSync(h.plugin, account);
		h.settings.maxChatsPerRun = 1;
		h.contents.set(active, bytes(h.read(active).replace('unread:', 'fixture_property: true\nunread:') + '\nManual text\n'));
		await h.plugin.app.vault.create('Chats/First/PROJECT.md', 'Unrelated');
		const asset = web.fileIndex[sandboxKey(id, 'message-new', '/mnt/data/demo (1).pdf')]!;
		const beforeRequests = requests;
		web.separateArchived = true;
		showNew = true;
		archivedFirst.add(id);
		const archiveFolder = 'Chats/Archived/First';
		const collision = `${archiveFolder}/${active.split('/').at(-1)!.toLowerCase().normalize('NFD')}`;
		await h.plugin.app.vault.createFolder('Chats/Archived');
		await h.plugin.app.vault.createFolder(archiveFolder);
		await h.plugin.app.vault.create(collision, 'unrelated collision');
		const previousMac = Platform.isMacOS;
		Object.assign(Platform, { isMacOS: true });
		// The stub has no root entry, so let file lookups at the root return an empty folder.
		Object.assign(h.plugin.app.vault, { getRoot: () => new TFolder('') });
		const first = await runGptSync(h.plugin, account).finally(() => Object.assign(Platform, { isMacOS: previousMac }));
		assert.equal(first.fullLists, 6);
		assert.equal(first.archive?.skipped.length, 1);
		assert.equal(h.moved.length, 0);
		assert.match(web.index[other]!.md, /^Chats\/Archived\/Second\//);
		assert.equal(h.read(collision), 'unrelated collision');
		h.entries.delete(collision);
		h.contents.delete(collision);
		const parent = h.entries.get(archiveFolder) as TFolder;
		parent.children = parent.children.filter((file) => file.path !== collision);
		h.interruptMove();
		assert.equal((await runGptSync(h.plugin, account)).archive?.failed.length, 1);
		assert(web.index[id]!.archiveMove);
		h.restart();
		const stages: string[] = [];
		const resumed = await runGptSync(h.plugin, account, (phase) => stages.push(phase));
		assert.equal(resumed.archive?.moved, 1, JSON.stringify(resumed));
		assert(stages.includes('moving archived chats 1 of 1'));
		const parked = web.index[id]!;
		assert.match(web.index[loose]!.md, /^Chats\/Archived\/Unclassified\//);
		assert.match(web.index[firstProject]!.md, /^Chats\/Archived\/First\//);
		assert.equal(parked.md, active.replace('/First/', '/Archived/First/'));
		assert.equal(parked.json, activeRaw.replace('/First/', '/Archived/First/'));
		assert.equal(parked.older?.[0], activeOlder.replace('/First/', '/Archived/First/'));
		assert.equal(h.read(parked.versions![0]!.files[0]!), 'historic bytes');
		assert.match(h.read(parked.md), /fixture_property: true[\s\S]*Manual text/);
		assert.equal(h.read('Chats/First/PROJECT.md'), 'Unrelated');
		assert(!h.entries.has(asset));
		assert.equal(h.read(asset.replace('/First/', '/Archived/First/')), 'synthetic PDF');
		assert(h.read(parked.md).includes(asset.replace('/First/', '/Archived/First/')));
		assert.equal(requests - beforeRequests, 6, 'body and older page only for the three new chats');
		assert.equal(repeatAssets, 1, 'moving the asset does not redownload it');
		const moveCount = h.moved.length;
		assert.equal((await runGptSync(h.plugin, account)).archive?.moved, 0);
		h.restart();
		assert.equal((await runGptSync(h.plugin, account)).archive?.moved, 0);
		assert.equal(h.moved.length, moveCount);
		archivedFirst.delete(id);
		both = true;
		assert.equal((await runGptSync(h.plugin, account)).archive?.skipped.length, 1);
		assert.equal(h.moved.length, moveCount);
		both = false;
		incomplete = true;
		assert.match((await runGptSync(h.plugin, account)).stopped ?? '', /reported total/);
		assert.equal(h.moved.length, moveCount);
		incomplete = false;
		limited = true;
		assert.match((await runGptSync(h.plugin, account)).stopped ?? '', /429/);
		assert.equal(h.moved.length, moveCount);
		limited = false;
		web.cooldownUntil = Date.now() - 1;
		web.includeArchived = false;
		assert.equal((await runGptSync(h.plugin, account)).archive, undefined);
		assert.equal(h.moved.length, moveCount);
		web.includeArchived = true;
		assert.equal((await runGptSync(h.plugin, account)).archive?.moved, 1);
		assert.equal(web.index[id]!.md, active);
		assert.equal(web.index[id]!.json, activeRaw);
		assert.equal(web.index[id]!.older?.[0], activeOlder);
		assert.equal(web.index[id]!.versions?.[0]?.files[0], ownVersion);
		assert.equal(h.read(asset), 'synthetic PDF');
		assert.match(h.read(active), /Manual text/);
		assert.match(h.read('Logs/sync.md'), /Archived chats: 1 moved, 0 skipped, 0 failed/);
		assert.equal(requests - beforeRequests, 6);
		console.log('ChatGPT archive placement, unchanged revisions, contradiction, collision, partial rename and restart passed.');
	} finally {
		GptApi.connect = connect;
	}
}

/** A voice chat saved by an older version has its one note brought up to date once; syncing again changes nothing. */
async function testVoiceReimport() {
	const voiceId = '87654321-4321-4321-4321-cba987654321';
	const pointer = { content_type: 'real_time_user_audio_video_asset_pointer', frames_asset_pointers: [], video_container_asset_pointer: null,
		audio_asset_pointer: { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000cccc', metadata: { transcription: null } } };
	const voiceChat = {
		conversation_id: voiceId, title: 'Voice', create_time: 1793955600, update_time: 1793955600, gizmo_id: null,
		messages: [
			{ id: 'u1', author: { role: 'user' }, create_time: 1793955600, content: { content_type: 'multimodal_text', parts: [pointer, { content_type: 'audio_transcription', text: 'Spoken user words', direction: 'in' }] } },
			{ id: 'a1', author: { role: 'assistant' }, create_time: 1793955610, content: { content_type: 'multimodal_text', parts: [{ content_type: 'audio_transcription', text: 'Spoken answer', direction: 'out' }] }, recipient: 'all', channel: 'final' },
		],
		page_info: { has_previous_page: false },
	};
	const h = harness();
	const connect = GptApi.connect;
	GptApi.connect = async () => ({
		inventoryKey: 'account:voice-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
		projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
		chatPath: () => 'chat',
		olderPath: () => 'older',
		redact: (value: string) => value,
		get: async (path: string) => {
			if (path === 'list:0:false:true') return raw({ items: [{ id: voiceId, title: 'Voice', create_time: date, update_time: date, gizmo_id: null }], offset: 0, total: 1 });
			if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
			if (path.startsWith('projects:')) return raw({ items: [] });
			if (path === 'chat') return raw(voiceChat);
			throw new Error('Unexpected request ' + path);
		},
	} as unknown as GptApi);
	try {
		const first = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(first.newCount, 1, first.stopped);
		const entry = h.settings.chatgpt[0]!.web.index[voiceId]!;
		const note = h.read(entry.md);
		assert.equal(note.split('Spoken user words').length, 2, 'user words once');
		assert.equal(note.split('Spoken answer').length, 2, 'answer once');
		assert(!note.includes('see raw JSON'));

		// Simulate the note an older version wrote (placeholders) with its own hash.
		const oldNote = note.replace('Spoken user words', '*[real_time_user_audio_video_asset_pointer – see raw JSON]*');
		h.contents.set(entry.md, bytes(oldNote));
		entry.viewHash = 'old-renderer';
		delete entry.view;
		delete entry.noteHash; // older versions saved no fingerprint
		const files = h.entries.size;
		const second = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(second.refreshedViews, 1);
		assert.equal(h.entries.size, files, 'the note is rewritten in place: no "(transcript …)" copy');
		assert.equal(entry.view, entry.md);
		assert(!!entry.noteHash, 'fingerprint saved from now on');
		const view = h.read(entry.md);
		assert.equal(view.split('Spoken user words').length, 2);
		assert.equal(view.split('Spoken answer').length, 2);

		const settled = h.entries.size;
		const third = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(third.refreshedViews, 0);
		assert.equal(third.newCount + third.changedCount, 0);
		assert.equal(h.entries.size, settled, 'syncing again adds no files');
		assert.equal(h.read(entry.view!), view);
	} finally {
		GptApi.connect = connect;
	}
}

/** With a JSON folder, the raw files go there (mirrored), the transcript links them by path, and a deleted .json comes back there. */
async function testJsonFolder() {
	const chatId = '11111111-2222-3333-4444-555555555555';
	const chat = {
		conversation_id: chatId, title: 'Split', create_time: 1793955600, update_time: 1793955600, gizmo_id: null,
		messages: [
			{ id: 'u1', author: { role: 'user' }, create_time: 1793955600, content: { content_type: 'text', parts: ['Hello'] } },
			{ id: 'a1', author: { role: 'assistant' }, create_time: 1793955610, content: { content_type: 'text', parts: ['Hi'] }, recipient: 'all', channel: 'final' },
		],
		page_info: { has_previous_page: false },
	};
	const h = harness();
	h.settings.rawRootOn = false; // the account's own JSON folder is only used with the raw files folder off
	h.settings.chatgpt[0]!.web.rawFolder = 'Raw/ChatGPT';
	const connect = GptApi.connect;
	let chatFetches = 0;
	GptApi.connect = async () => ({
		inventoryKey: 'account:json-folder-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
		projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
		chatPath: () => 'chat',
		olderPath: () => 'older',
		redact: (value: string) => value,
		get: async (path: string) => {
			if (path === 'list:0:false:true') return raw({ items: [{ id: chatId, title: 'Split', create_time: date, update_time: date, gizmo_id: null }], offset: 0, total: 1 });
			if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
			if (path.startsWith('projects:')) return raw({ items: [] });
			if (path === 'chat') {
				chatFetches++;
				return raw(chat);
			}
			throw new Error('Unexpected request ' + path);
		},
	} as unknown as GptApi);
	try {
		const first = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(first.newCount, 1, first.stopped);
		const entry = h.settings.chatgpt[0]!.web.index[chatId]!;
		assert.match(entry.md, /^Chats\/Recent\/[^/]+\.md$/, 'transcript in the chat folder');
		assert.match(entry.json, /^Raw\/ChatGPT\/Recent\/[^/]+\.json$/, 'raw .json in the JSON folder, same subfolder');
		assert(![...h.entries.keys()].some((p) => p.startsWith('Chats/') && p.endsWith('.json')), 'no .json in the chat folder');
		assert(h.read(entry.md).includes(`raw: "[[${entry.json}]]"`), 'transcript links the raw file by its path');

		const settled = h.entries.size;
		const again = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(again.newCount + again.changedCount + again.refreshedViews, 0, 'second sync changes nothing');
		assert.equal(h.entries.size, settled);

		// Deleted raw file: fetched again into the JSON folder, never next to the transcript.
		h.entries.delete(entry.json);
		const fetches = chatFetches;
		await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		const back = h.settings.chatgpt[0]!.web.index[chatId]!;
		assert.equal(chatFetches, fetches + 1, 'fetched once more');
		assert.match(back.json, /^Raw\/ChatGPT\/Recent\//);
		assert(h.entries.has(back.json));
		assert(![...h.entries.keys()].some((p) => p.startsWith('Chats/') && p.endsWith('.json')), 'still no .json in the chat folder');
		console.log('JSON folder passed: raw files mirrored into their own folder, linked by path, restored there.');
	} finally {
		GptApi.connect = connect;
	}
}

/**
 * An unchanged saved chat is checked without reading its raw pages once a full check found
 * nothing to do; any change it depends on (file, raw page, note, build) brings the full check back.
 */
async function testQuickCheck() {
	const h = harness();
	h.settings.chatgpt[0]!.web.downloadFiles = true;
	const connect = GptApi.connect;
	let chatFetches = 0;
	let fileFetches = 0;
	GptApi.connect = async () => ({
		inventoryKey: 'account:quick-check-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
		projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
		chatPath: () => 'chat',
		olderPath: () => 'older',
		redact: (value: string) => value,
		get: async (path: string) => {
			if (path === 'list:0:false:true') return raw({ items: [{ id, title: 'Fixture', create_time: date, update_time: date, gizmo_id: null }], offset: 0, total: 1 });
			if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
			if (path.startsWith('projects:')) return raw({ items: [] });
			if (path === 'chat') { chatFetches++; return raw(top); }
			if (path === 'older') return raw(older);
			throw new Error('Unexpected request ' + path);
		},
		sandboxBytes: async () => { fileFetches++; return bytes('%PDF-1.7 fixture'); },
	} as unknown as GptApi);
	const sync = () => runGptSync(h.plugin, h.settings.chatgpt[0]!);
	const pagesRead = async () => {
		const entry = h.settings.chatgpt[0]!.web.index[id]!;
		const pages = [entry.json, ...(entry.older ?? [])];
		h.reads.length = 0;
		const r = await sync();
		assert.equal(r.stopped, undefined);
		return { r, read: h.reads.filter((p) => pages.includes(p)).length };
	};
	try {
		const first = await sync();
		assert.equal(first.newCount, 1, first.stopped);
		assert.equal(first.filesSaved, 1);
		const entry = () => h.settings.chatgpt[0]!.web.index[id]!;
		assert.equal(entry().older?.length, 1, 'a chat of two raw pages');

		// The first check of a saved chat is a full one; it remembers what it depended on.
		const full = await pagesRead();
		assert.equal(full.read, 2, 'both raw pages read once');
		assert(entry().quick, 'the check is remembered');
		const quiet = await pagesRead();
		assert.equal(quiet.read, 0, 'then the raw pages are not read');
		assert.equal(quiet.r.refreshedViews + quiet.r.filesSaved + quiet.r.restored.length, 0);
		assert.equal(chatFetches, 1, 'and nothing is fetched');

		// A saved file deleted: full check, fetched again, then quiet.
		const pdf = Object.values(h.settings.chatgpt[0]!.web.fileIndex)[0]!;
		const folder = h.entries.get(pdf.slice(0, pdf.lastIndexOf('/')));
		if (folder instanceof TFolder) folder.children = folder.children.filter((f) => f.path !== pdf);
		h.entries.delete(pdf);
		const refetch = await pagesRead();
		assert.equal(refetch.read, 2);
		assert.equal(fileFetches, 2, 'the deleted file is fetched again');
		assert.equal(refetch.r.filesSaved, 1);
		assert.equal((await pagesRead()).read, 0);

		// A note you edited: same as before the shortcut, it is left alone and nothing is read.
		const edited = h.read(entry().md) + '\nMy own line.\n';
		h.contents.set(entry().md, bytes(edited));
		const afterEdit = await pagesRead();
		assert.equal(afterEdit.read, 0);
		assert.equal(afterEdit.r.refreshedViews, 0);
		assert.equal(h.read(entry().md), edited, 'your edit stays');

		// A new plugin build: every chat is checked fully once.
		h.newBuild();
		const build = await pagesRead();
		assert.equal(build.read, 2, 'a new build reads the raw pages again');
		assert.equal(build.r.refreshedViews, 0, 'same layout: the note is not rewritten');
		assert.equal((await pagesRead()).read, 0);

		// The note drawn differently now (as after a layout change): redrawn.
		entry().viewHash = 'older-layout';
		const redraw = await pagesRead();
		assert.equal(redraw.read, 2);
		assert.equal(redraw.r.refreshedViews, 1, 'the note is brought up to date');
		assert.equal(redraw.r.edits.copies.length, 1, 'your edited version saved as a copy first, as before');
		assert.equal((await pagesRead()).read, 0);

		// An older raw page changed on disk: its fingerprint no longer matches, so the chat is fetched again.
		const olderPage = entry().older![0]!;
		h.contents.set(olderPage, bytes(h.read(olderPage).replace('Older text', 'Older text, changed')));
		const fetches = chatFetches;
		const changed = await pagesRead();
		assert(changed.read >= 2, 'the raw pages are read (and compared once more before they are replaced)');
		assert.equal(chatFetches, fetches + 1, 'fetched again');
		assert.equal(changed.r.restored.length, 1);
		assert.equal((await pagesRead()).read, 0);

		// The note deleted: written again from the raw pages.
		const md = entry().md;
		h.entries.delete(md);
		const restore = await pagesRead();
		assert.equal(restore.read, 2);
		assert(h.entries.has(md), 'the note is back');
		assert.equal((await pagesRead()).read, 0);

		// The note's fingerprint cleared, as the merge does: the note still reads as drawn, so it is
		// not rewritten; its fingerprint comes back and the next run skips the chat again.
		const asDrawn = h.read(entry().md);
		delete entry().viewHash;
		const cleared = await pagesRead();
		assert.equal(cleared.read, 2, 'a full check once');
		assert.equal(cleared.r.refreshedViews, 0, 'the note is not rewritten');
		assert.equal(h.read(entry().md), asDrawn);
		assert(entry().viewHash, 'its fingerprint is stored again');
		h.reads.length = 0;
		assert.equal((await pagesRead()).read, 0, 'then the chat is skipped again');
		assert(!h.reads.includes(entry().md), 'and its note is not read either');

		// A vault that cannot tell file times: always the full check.
		const adapter = h.plugin.app.vault.adapter as { stat?: unknown };
		delete adapter.stat;
		assert.equal((await pagesRead()).read, 2);
		assert.equal((await pagesRead()).read, 2);
		console.log('Quick check passed: unchanged chats are not read again; a deleted file or note, a changed raw page, a new build or a stale note brings the full check back; your edits are left alone.');
	} finally {
		GptApi.connect = connect;
	}
}

/**
 * Audit 2026-11-24: things the full check reacts to that the raw pages do not show. With the
 * quick check on, each must still give the full check's result: a file that failed to download
 * (on its retry delay, then fetched), a renamed project, a saved file deleted while file
 * downloads are off, and a changed list of earlier versions.
 */
async function testQuickCheckSameResult() {
	const h = harness();
	const g = h.settings.chatgpt[0]!.web;
	g.downloadFiles = true;
	const connect = GptApi.connect;
	const projectId = 'g-p-0123456789abcdef';
	let projectName = 'Alpha';
	let sandboxOk = false;
	let fileTries = 0;
	GptApi.connect = async () => ({
		inventoryKey: 'account:quick-same-result-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
		projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
		chatPath: () => 'chat',
		olderPath: () => 'older',
		redact: (value: string) => value,
		get: async (path: string) => {
			if (path === 'list:0:false:true') return raw({ items: [{ id, title: 'Fixture', create_time: date, update_time: date, gizmo_id: projectId }], offset: 0, total: 1 });
			if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
			if (path.startsWith('projects:')) return raw({ items: [{ gizmo: { gizmo: { id: projectId, display: { name: projectName } } } }] });
			if (path === 'chat') return raw(top);
			if (path === 'older') return raw(older);
			throw new Error('Unexpected request ' + path);
		},
		sandboxBytes: async () => { fileTries++; return sandboxOk ? bytes('%PDF-1.7 fixture') : null; },
	} as unknown as GptApi);
	const entry = () => g.index[id]!;
	const sync = async () => {
		const entryNow = g.index[id];
		const pages = entryNow ? [entryNow.json, ...(entryNow.older ?? [])] : [];
		h.reads.length = 0;
		const r = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(r.stopped, undefined);
		return { r, read: h.reads.filter((p) => pages.includes(p)).length };
	};
	try {
		// A file that fails to download waits for its retry; every run reports it as pending.
		const first = await sync();
		assert.equal(first.r.newCount, 1);
		assert.equal(first.r.filesSaved, 0, 'the file could not be downloaded');
		assert.equal(first.r.pendingAssets, 1);
		// The first check after saving is a full one; while the file waits, the chat is then skipped,
		// and the waiting file is still reported as pending, as the full check reports it.
		const firstCheck = await sync();
		assert.equal(firstCheck.read, 2, 'the first check of the saved chat is a full one');
		assert.equal(firstCheck.r.pendingAssets, 1);
		const tries = fileTries;
		for (const n of [1, 2]) {
			const waiting = await sync();
			assert.equal(waiting.r.pendingAssets, 1, `run ${n} after: the waiting file is still reported`);
			assert.equal(waiting.read, 0, `run ${n} after: a chat whose missing file is still waiting is not read`);
		}
		assert.equal(fileTries, tries, 'no download is tried while the file waits, as before');
		// Its retry time has come and the download works now: fetched, then quiet.
		for (const r of Object.values(g.assetRetries ?? {})) r.nextAttempt = 0;
		sandboxOk = true;
		const fetched = await sync();
		assert.equal(fetched.r.filesSaved, 1, 'the file is fetched once its retry time has come');
		assert.equal(fetched.r.pendingAssets, 0);
		await sync();
		assert.equal((await sync()).read, 0, 'then quiet');

		// The project renamed on chatgpt.com: the note shows the new name, as the full check draws it.
		assert(h.read(entry().md).includes('Alpha'));
		projectName = 'Beta';
		const renamed = await sync();
		assert.equal(renamed.r.refreshedViews, 1, 'the note is redrawn for the renamed project');
		assert(h.read(entry().md).includes('project: "Beta"'), 'the note names the new project');
		assert.equal((await sync()).read, 0, 'then quiet');

		// File downloads off, a saved file deleted: the note no longer links it, as the full check draws it.
		g.downloadFiles = false;
		await sync();
		assert.equal((await sync()).read, 0, 'quiet with file downloads off');
		const pdf = Object.values(g.fileIndex)[0]!;
		const pdfName = pdf.split('/').pop()!;
		assert(h.read(entry().md).includes(pdfName), 'the note links the saved file');
		const folder = h.entries.get(pdf.slice(0, pdf.lastIndexOf('/')));
		if (folder instanceof TFolder) folder.children = folder.children.filter((f) => f.path !== pdf);
		h.entries.delete(pdf);
		const unlinked = await sync();
		assert.equal(unlinked.r.refreshedViews, 1, 'the note is redrawn without the deleted file');
		assert(!h.read(entry().md).includes(pdfName), 'the deleted file is no longer linked');
		assert.equal((await sync()).read, 0, 'then quiet');

		// The list of earlier versions changed (as an index merged from another computer can): the note shows it.
		entry().versions = [{ at: '2026-01-01T00:00:00Z', files: ['Chats/raw/Fixture (version 2026-01-01).json'] }];
		const versioned = await sync();
		assert.equal(versioned.r.refreshedViews, 1, 'the note is redrawn with its earlier version');
		assert(h.read(entry().md).includes('earlier_versions: 1'));
		assert.equal((await sync()).read, 0, 'then quiet');
		console.log('Quick check, same result as the full check: a waiting file (skipped while it waits, still pending, fetched when due), a renamed project, a deleted file with downloads off and changed versions all bring the full check back.');
	} finally {
		GptApi.connect = connect;
	}
}

/** New quick-check keys are saved in batches, not once per chat; none is lost at the end of the run. */
async function testQuickCheckSavedInBatches() {
	const h = harness();
	h.settings.maxChatsPerRun = 0;
	const chats = Array.from({ length: 120 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
	const one = (cid: string) => ({
		conversation_id: cid, title: 'Chat ' + cid.slice(-3), create_time: 1793955600, update_time: 1793955600, gizmo_id: null,
		messages: [{ id: 'a1', author: { role: 'assistant' }, create_time: 1793955610, content: { content_type: 'text', parts: ['Hi'] }, recipient: 'all', channel: 'final' }],
		page_info: { has_previous_page: false },
	});
	const connect = GptApi.connect;
	GptApi.connect = async () => ({
		inventoryKey: 'account:batch-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
		projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
		chatPath: (cid: string) => 'chat:' + cid,
		olderPath: () => 'older',
		redact: (value: string) => value,
		get: async (path: string) => {
			if (path === 'list:0:false:true') return raw({ items: chats.map((cid) => ({ id: cid, title: 'Chat ' + cid.slice(-3), create_time: date, update_time: date, gizmo_id: null })), offset: 0, total: chats.length });
			if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
			if (path.startsWith('projects:')) return raw({ items: [] });
			if (path.startsWith('chat:')) return raw(one(path.slice(5)));
			throw new Error('Unexpected request ' + path);
		},
	} as unknown as GptApi);
	const web = () => h.settings.chatgpt[0]!.web;
	try {
		const first = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(first.newCount, chats.length, first.stopped);
		const check = async () => {
			const before = h.saves();
			const r = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
			assert.equal(r.stopped, undefined);
			return h.saves() - before;
		};
		// The first full check of 120 chats gives each one a new key.
		const firstCheck = await check();
		assert(firstCheck < 12, `new keys saved in batches, not once per chat (${firstCheck} writes)`);
		h.restart(); // as after a restart: only what was saved is there
		assert.equal(chats.filter((cid) => web().index[cid]?.quick).length, chats.length, 'every key was saved by the end of the run');
		// A new build changes every key: again a few writes, not 120.
		h.newBuild();
		const afterBuild = await check();
		assert(afterBuild < 12, `after a new build, keys saved in batches (${afterBuild} writes)`);
		h.restart();
		const keys = chats.map((cid) => web().index[cid]!.quick!.key);
		h.reads.length = 0;
		await check();
		assert.equal(h.reads.filter((p) => p.endsWith('.json')).length, 0, 'the saved keys are the new ones: nothing is read next run');
		assert.deepEqual(chats.map((cid) => web().index[cid]!.quick!.key), keys);
		console.log('Quick check keys saved in batches: 120 chats checked with a handful of index writes, every key there after a restart.');
	} finally {
		GptApi.connect = connect;
	}
}

/**
 * Generated files (code interpreter): seen 2026-11-26, the route answers 200 with the same JSON as a
 * file-ID download instead of a redirect. The bytes must come from its download_url; a JSON answer
 * without one is still refused as a preview; a redirect and a real attachment still work.
 */
async function testSandboxJsonAnswer() {
	const CHAT = '6b07f8d8-f574-83ea-881e-18216fb4a0c8';
	const MSG = '11111111-2222-4333-8444-555555555555';
	const LINK = 'https://chatgpt.com/backend-api/estuary/content?id=file_00000000aaaa&sig=abc';
	assert.equal(sandboxLink(JSON.stringify({ status: 'success', download_url: LINK, file_name: 'test-rows.csv', mime_type: 'text/csv', file_size_bytes: null })), LINK);
	assert.equal(sandboxLink('{"status":"error","error_code":"x"}'), null);
	assert.equal(sandboxLink('<html>'), null);

	const api = Object.create(GptApi.prototype) as GptApi & { sandboxFetch: (href: string) => Promise<Response> };
	let answer: Response = new Response('');
	const asked: string[] = [];
	const followed: string[] = [];
	api.sandboxFetch = async (href) => { asked.push(href); return answer; };
	api.fileBytes = async (link: string) => { followed.push(link); return new TextEncoder().encode('id,name\n1,a\n').buffer; };
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

	answer = json({ status: 'success', download_url: LINK, file_name: 'test-rows.csv' });
	const csv = await api.sandboxBytes(CHAT, MSG, '/mnt/data/test-rows.csv');
	assert.equal(new TextDecoder().decode(csv!), 'id,name\n1,a\n', 'JSON answer: bytes come from its download link');
	assert.deepEqual(followed, [LINK]);
	const askedUrl = new URL(asked[0]!);
	assert.equal(askedUrl.pathname, `/backend-api/conversation/${CHAT}/interpreter/download`);
	assert.equal(askedUrl.searchParams.get('sandbox_path'), '/mnt/data/test-rows.csv');

	answer = json({ status: 'error' });
	await assert.rejects(api.sandboxBytes(CHAT, MSG, '/mnt/data/test-rows.csv'), /without a download link/, 'JSON without a link is not saved as the file');

	answer = new Response(null, { status: 302, headers: { location: LINK } });
	followed.length = 0;
	await api.sandboxBytes(CHAT, MSG, '/mnt/data/test-rows.csv');
	assert.deepEqual(followed, [LINK], 'a redirect is still followed');

	answer = new Response('id,name\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="test-rows.csv"' } });
	assert.equal(new TextDecoder().decode((await api.sandboxBytes(CHAT, MSG, '/mnt/data/test-rows.csv'))!), 'id,name\n', 'a direct attachment is still saved');

	answer = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
	await assert.rejects(api.sandboxBytes(CHAT, MSG, '/mnt/data/test-rows.csv'), /preview/, 'an HTML page is still refused');
	console.log('Generated-file route passed: JSON answer followed to its download link, JSON without a link refused, redirect and attachment unchanged, HTML refused.');
}

/** Issue #48: one file refused with a JSON 403 skips that file; the sync goes on. Other 403s still stop. */
async function testFileForbiddenSkipsFile() {
	const CHAT = '6b07f8d8-f574-83ea-881e-18216fb4a0c8';
	const FILE = 'file_00000000abcdef0123456789';
	const api = Object.create(GptApi.prototype) as GptApi;
	Object.assign(api, { cookie: 'c', deviceId: null, ua: 'test', token: 'key', login: { id: "a" } });
	let answer: { status: number; headers: Record<string, string>; text: string } = { status: 403, headers: { 'content-type': 'application/json' }, text: '{"detail":"Forbidden"}' };
	const asked: string[] = [];
	testHooks.requestUrl = async (r) => { asked.push(r.url); return { ...answer, arrayBuffer: new ArrayBuffer(0), json: null }; };
	try {
		await assert.rejects(api.fileInfo(FILE, CHAT), (e: unknown) => e instanceof BlockedLinkError && /403/.test(e.where), 'a JSON 403 on one file skips only that file');
		assert.ok(asked[0]?.includes(`/backend-api/files/download/${FILE}`));
		answer = { status: 403, headers: { 'content-type': 'text/html' }, text: '<html>Just a moment...</html>' };
		await assert.rejects(api.fileInfo(FILE, CHAT), (e: unknown) => e instanceof StopError, 'a Cloudflare page (HTML 403) on a file still stops the sync');
		answer = { status: 403, headers: { 'content-type': 'application/json' }, text: '{"detail":"Forbidden"}' };
		await assert.rejects(api.get(`/backend-api/conversations/${CHAT}`), (e: unknown) => e instanceof StopError && !(e instanceof BlockedLinkError), 'a 403 on a chat still stops the sync');
	} finally {
		testHooks.requestUrl = null;
	}
	console.log('File 403 passed: a JSON 403 on one file skips that file (#48); an HTML 403 or a 403 on a chat still stops.');
}

/** Issue #48: a GET that fails below HTTP (broken TLS) is tried again; only repeated failures stop. The POST is never repeated. */
async function testNetworkErrorRetried() {
	const CHAT = '6b07f8d8-f574-83ea-881e-18216fb4a0c8';
	const api = Object.create(GptApi.prototype) as GptApi;
	const waits: number[] = [];
	Object.assign(api, { cookie: 'c', deviceId: null, ua: 'test', token: 'key', login: { id: 'a' }, pause: async (ms: number) => { waits.push(ms); } });
	let failures = 0;
	let calls = 0;
	testHooks.requestUrl = async () => {
		calls++;
		if (calls <= failures) throw new Error('net::ERR_SSL_BAD_RECORD_MAC_ALERT');
		return { status: 200, headers: { 'content-type': 'application/json' }, text: '{"ok":true}', arrayBuffer: new ArrayBuffer(0), json: null };
	};
	try {
		failures = 1;
		const got = await api.get(`/backend-api/conversations/${CHAT}`);
		assert.deepEqual(got.json, { ok: true }, 'one broken connection: the second try gets the answer');
		assert.equal(calls, 2);
		assert.deepEqual(waits, [NETWORK_RETRY_WAITS_MS[0]]);

		calls = 0; waits.length = 0; failures = 2;
		await api.get(`/backend-api/conversations/${CHAT}`);
		assert.equal(calls, 3, 'two broken connections: the third try gets the answer');
		assert.deepEqual(waits, NETWORK_RETRY_WAITS_MS);

		calls = 0; waits.length = 0; failures = 99;
		await assert.rejects(api.get(`/backend-api/conversations/${CHAT}`), (e: unknown) => e instanceof StopError && /ERR_SSL_BAD_RECORD_MAC_ALERT/.test(e.message) && /tried 3 times/.test(e.message), 'every try broken: the sync stops and names the error');
		assert.equal(calls, 3, 'no more than three tries');

		calls = 0; waits.length = 0; failures = 99;
		await assert.rejects(api.memorySummaryStream(), (e: unknown) => e instanceof StopError && !/tried/.test(e.message), 'the memory summary POST is not sent twice');
		assert.equal(calls, 1);
		assert.deepEqual(waits, []);
	} finally {
		testHooks.requestUrl = null;
	}
	console.log('Network retry passed: a broken connection on a ChatGPT GET is tried up to 3 times (#48); the POST is sent once.');
}

/** A Library file link exactly as chatgpt.com handed it out (seen 2026-11-26, IDs made up). */
const LIB_FILE = 'file_00000000aa1181f4b25c2516dad77baa';
const LIB_LINK = `https://chatgpt.com/api/library/files/libfile_a1ccd46a034c8191ad570fbdf773da5a/project-content?file_id=${LIB_FILE}`;
type Answer = { status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer };
const answerOf = (status: number, headers: Record<string, string>, body: string): Answer => ({ status, headers, text: body, arrayBuffer: bytes(body) });
const libraryFile = (body: string) => answerOf(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="Pasted markdown.md"', 'cache-control': 'private, no-store' }, body);
const signedInApi = () => {
	const api = Object.create(GptApi.prototype) as GptApi;
	Object.assign(api, { cookie: '__Secure-next-auth.session-token=cookie-value-123', deviceId: null, ua: 'test', token: 'login-key-456', login: { id: 'a' } });
	return api;
};

/**
 * Library files (`/api/library/files/libfile_…/project-content?file_id=…`): fetched with the same
 * login as estuary/content. 200 attachment = the file; 401 stops; 404 = gone; any other answer
 * (seen: 415 "Could not resolve file URL") or a non-attachment skips only that file; links of any
 * other shape are refused before a request is sent.
 */
async function testLibraryFileLink() {
	const api = signedInApi();
	let answer = libraryFile('# Notes\n');
	const asked: { url: string; headers: Record<string, string> }[] = [];
	testHooks.requestUrl = async (r) => { asked.push(r as { url: string; headers: Record<string, string> }); return answer; };
	try {
		assert.equal(new TextDecoder().decode((await api.fileBytes(LIB_LINK))!), '# Notes\n', 'a Library file is saved as it comes');
		assert.equal(asked[0]!.url, LIB_LINK);
		assert.equal(asked[0]!.headers.Cookie, '__Secure-next-auth.session-token=cookie-value-123', 'sent with the login cookies');
		assert.equal(asked[0]!.headers.Authorization, 'Bearer login-key-456', 'and the login key, as for estuary/content');
		assert.equal(new TextDecoder().decode((await api.fileBytes(LIB_LINK.replace('https://chatgpt.com', '')))!), '# Notes\n', 'a link without the origin works too');
		// Pasted text comes back "inline" with its name (seen in the owner's sync after 0.41.2): still the file.
		answer = answerOf(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'inline; filename="Pasted text(20260916-105510).txt"; filename*=UTF-8\'\'Pasted%20text%2820260916-105510%29.txt' }, '<!DOCTYPE html> pasted page source');
		assert.equal(new TextDecoder().decode((await api.fileBytes(LIB_LINK))!), '<!DOCTYPE html> pasted page source', 'pasted text named inline is saved as it comes');
		for (const disposition of ['inline', 'attachment', 'form-data; name="x"']) {
			answer = answerOf(200, { 'content-type': 'text/plain', 'content-disposition': disposition }, 'x');
			await assert.rejects(api.fileBytes(LIB_LINK), (e: unknown) => e instanceof BlockedLinkError && /not a file download/.test(e.where), `refused without a file name: ${disposition}`);
		}

		answer = answerOf(415, { 'content-type': 'text/plain; charset=utf-8' }, 'Could not resolve file URL');
		await assert.rejects(api.fileBytes(LIB_LINK), (e: unknown) => e instanceof BlockedLinkError && /library file answered 415/.test(e.where), 'a 415 skips only that file');
		answer = answerOf(500, { 'content-type': 'text/plain' }, 'oops');
		await assert.rejects(api.fileBytes(LIB_LINK), (e: unknown) => e instanceof BlockedLinkError && /500/.test(e.where), 'a 500 skips only that file');
		answer = answerOf(401, { 'content-type': 'text/plain; charset=utf-8' }, 'Missing or invalid access token');
		await assert.rejects(api.fileBytes(LIB_LINK), (e: unknown) => e instanceof StopError && !(e instanceof BlockedLinkError) && /401/.test(e.message), 'a 401 still stops the sync (login)');
		answer = answerOf(404, { 'content-type': 'text/plain' }, 'not found');
		assert.equal(await api.fileBytes(LIB_LINK), null, '404 = download unavailable');
		answer = answerOf(200, { 'content-type': 'text/html' }, '<html>sign in</html>');
		await assert.rejects(api.fileBytes(LIB_LINK), (e: unknown) => e instanceof BlockedLinkError && /not a file download/.test(e.where), 'a page instead of an attachment is never saved as the file');

		asked.length = 0;
		answer = libraryFile('# Notes\n');
		for (const odd of [
			`${LIB_LINK}&sig=abc`,
			LIB_LINK.replace(`file_id=${LIB_FILE}`, 'file_id=../x'),
			LIB_LINK.replace('?file_id=', '?id='),
			LIB_LINK.replace('/project-content', '/other'),
			LIB_LINK.replace('libfile_a1ccd46a034c8191ad570fbdf773da5a', '..'),
			'https://chatgpt.com/api/library/list',
		]) {
			await assert.rejects(api.fileBytes(odd), (e: unknown) => e instanceof BlockedLinkError && /api\/library/.test(e.where), `refused: ${odd}`);
		}
		assert.equal(asked.length, 0, 'odd Library links are refused before any request');
	} finally {
		testHooks.requestUrl = null;
	}
	console.log('Library file links passed: fetched with the login, saved only when named as a file (attachment, or inline for pasted text), 415/500 skip one file, 401 stops, 404 = unavailable, odd links refused unsent.');
}

/**
 * End to end through the sync: a chat whose file lookup hands out a Library link. Before this
 * change it waited with "chatgpt.com/api/library/…" for ever. Now: a 415 waits for its retry,
 * a short answer is a size mismatch, the full file is saved and its wait cleared.
 */
async function testLibraryFileSync() {
	const h = harness();
	const g = h.settings.chatgpt[0]!.web;
	g.downloadFiles = true;
	const content = '# Pasted\n\nLong pasted text.\n';
	const chat = {
		conversation_id: id, title: 'Library', create_time: 1793955600, update_time: 1793955600, gizmo_id: null,
		messages: [{
			id: 'message-user', author: { role: 'user' }, content: { content_type: 'text', parts: ['See the paste.'] },
			metadata: { attachments: [{ id: LIB_FILE, is_big_paste: true, library_file_id: 'libfile_a1ccd46a034c8191ad570fbdf773da5a', mime_type: 'text/plain', name: 'Pasted markdown.md', size: content.length, source: 'local' }] },
		}, message('message-answer', 'Read it.')],
		page_info: { has_previous_page: false },
	};
	let library: Answer = answerOf(415, { 'content-type': 'text/plain; charset=utf-8' }, 'Could not resolve file URL');
	const asked: string[] = [];
	testHooks.requestUrl = async (r) => {
		asked.push(r.url);
		const url = new URL(r.url);
		if (url.pathname === `/backend-api/files/download/${LIB_FILE}`) {
			return answerOf(200, { 'content-type': 'application/json' }, JSON.stringify({ status: 'success', download_url: LIB_LINK, metadata: null, file_name: 'Pasted markdown.md', creation_time: null, no_auth_user_upload: null, mime_type: null, file_size_bytes: content.length }));
		}
		if (r.url === LIB_LINK) return library;
		throw new Error('Unexpected request ' + r.url);
	};
	const connect = GptApi.connect;
	GptApi.connect = async () => Object.assign(signedInApi(), {
		inventoryKey: 'account:library-test',
		listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
		projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
		chatPath: () => 'chat',
		get: async (path: string) => {
			if (path === 'list:0:false:true') return raw({ items: [{ id, title: 'Library', create_time: date, update_time: date, gizmo_id: null }], offset: 0, total: 1 });
			if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
			if (path.startsWith('projects:')) return raw({ items: [] });
			if (path === 'chat') return raw(chat);
			throw new Error('Unexpected request ' + path);
		},
	});
	const due = () => { for (const r of Object.values(g.assetRetries ?? {})) r.nextAttempt = 0; };
	try {
		const first = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(first.stopped, undefined, 'a Library file chatgpt.com cannot serve does not stop the sync');
		assert.equal(first.newCount, 1);
		assert.equal(first.filesSaved, 0);
		assert.equal(first.pendingAssets, 1);
		assert.match(g.assetRetries?.[LIB_FILE]?.reason ?? '', /library file answered 415/, 'it waits with the reason');
		assert(asked.includes(LIB_LINK), 'the Library link was asked for (no longer refused unsent)');

		due();
		library = libraryFile(content.slice(0, 10));
		const short = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(short.filesSaved, 0, 'a file shorter than chatgpt.com said is not saved');
		assert.equal(g.assetRetries?.[LIB_FILE]?.reason, 'size mismatch', 'the usual size check applies');

		due();
		library = libraryFile(content);
		const saved = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(saved.stopped, undefined);
		assert.equal(saved.filesSaved, 1, 'the Library file is saved');
		const path = g.fileIndex[LIB_FILE]!;
		assert.match(path, /Pasted markdown\.md$/);
		assert.equal(h.read(path), content, 'with exactly the bytes chatgpt.com sent');
		assert.equal(g.assetRetries?.[LIB_FILE], undefined, 'its wait is cleared');
	} finally {
		testHooks.requestUrl = null;
		GptApi.connect = connect;
	}
	console.log('Library file sync passed: 415 waits for its retry without stopping, short answer = size mismatch, full file saved and its wait cleared.');
}

async function main() {
	await testFileForbiddenSkipsFile();
	await testNetworkErrorRetried();
	await testLibraryFileLink();
	await testSandboxJsonAnswer();
	assert.equal(retryDeadline('120', 1000), 121000);
	assert.equal(retryDeadline('invalid', 1000), 601000);
	assert.equal(retryDeadline('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 120000);
	assert.throws(() => checkGptChat({ ...top, page_info: undefined }, id));
	assert.throws(() => checkGptOlderPage({ messages: [], page_info: {} }));
	await testAutomaticResume();
	await testArchiveSettingTiming();
	Object.assign(globalThis, { window: { setTimeout: (fn: () => void) => setTimeout(fn, 0) } });
	await testVoiceReimport();
	await testLibraryFileSync();
	await testJsonFolder();
	await testQuickCheck();
	await testQuickCheckSameResult();
	await testQuickCheckSavedInBatches();
	await testArchiveRelativeLink();
	await testLocalArchiveToggle();
	await testArchivedPlacement();
	let calls = 0;
	let sandboxCalls = 0;
	let listingLimit = true;
	let olderPageLimit = false;
	let fixtureVisible = true;
	let phase: 'limit' | 'missing' | 'ok' = 'limit';
	const h = harness();
	const paths: string[] = [];
	let olderPayload = older;
	let topPayload: typeof top = top;
	let listDate = date;
	const connect = GptApi.connect;
	GptApi.connect = async () => {
		calls++;
		return {
			inventoryKey: 'account:integration-test',
			listPath: (offset: number, tpp: boolean, archived: boolean, pinned = false) => 'list:' + [offset, tpp, archived].join(':') + (pinned ? ':pinned' : ''),
			projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
			chatPath: () => 'chat',
			olderPath: () => 'older',
			redact: (value: string) => value,
			get: async (path: string) => {
				paths.push(path);
				if (listingLimit && path === 'list:1:false:true') throw new GptRateLimitError(Date.now() + 60_000);
				if (fixtureVisible && path === 'list:0:false:true') return raw({ items: [{ id, title: 'Fixture', create_time: date, update_time: listDate, gizmo_id: null }], offset: 0, total: listingLimit ? 2 : 1 });
				if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
				if (path === 'projects:') return raw({ items: [], cursor: 'next' });
				if (path === 'projects:next') return raw({ items: [] });
				if (path === 'chat') return raw(topPayload);
				if (path === 'older') {
					if (olderPageLimit) throw new GptRateLimitError(Date.now() + 60_000);
					return raw(olderPayload);
				}
				throw new Error('Unexpected request ' + path);
			},
			sandboxBytes: async (chat: string, msg: string, path: string) => {
				assert.deepEqual([chat, msg, path], [id, 'message-new', '/mnt/data/demo (1).pdf']);
				sandboxCalls++;
				if (phase === 'limit') throw new GptRateLimitError(Date.now() + 60_000);
				return phase === 'ok' ? bytes('%PDF-1.7 fixture') : null;
			},
		} as unknown as GptApi;
	};
	try {
		const limitedListing = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.match(limitedListing.stopped ?? '', /429/);
		assert.match(limitedListing.stopped ?? '', /listing archived normal chats \(offset 1\)\. Saved 0 chats/);
		assert(!limitedListing.stopped?.includes('Fixture'));
		assert.equal(limitedListing.listingRequests, 6);
		assert(paths.includes('list:0:false:false:pinned') && paths.includes('list:0:true:false:pinned'), 'pinned chats are listed');
		assert.equal(limitedListing.leftForLater, 1);
		h.restart();
		const inventory = h.settings.chatgpt[0]!.web.inventories!.accounts['account:integration-test']!;
		assert.equal(inventory.queue[id]?.id, id);
		assert(inventory.checkpoints['active-normal']);
		assert.equal(inventory.checkpoints['archived-normal'], undefined);
		assert.equal(inventory.checkpoints['archived-tpp'], undefined);
		const beforeListingCooldown = calls;
		assert.match((await runGptSync(h.plugin, h.settings.chatgpt[0]!)).stopped ?? '', /cooling down/);
		assert.equal(calls, beforeListingCooldown);
		h.settings.chatgpt[0]!.web.cooldownUntil = Date.now() - 1;
		listingLimit = false;

		olderPageLimit = true;
		const limitedPage = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.match(limitedPage.stopped ?? '', /fetching older conversation page 1 for "Fixture" \(queued chat 1 of 1, ID /);
		assert(h.read('Logs/sync.md').includes(limitedPage.stopped!));
		h.settings.chatgpt[0]!.web.cooldownUntil = Date.now() - 1;
		olderPageLimit = false;

		h.interrupt();
		const interrupted = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.match(interrupted.stopped ?? '', /simulated interruption/);
		h.restart();
		const journal = h.settings.chatgpt[0]!.web.pendingCaptures![id]!;
		assert(h.entries.has(journal.json));
		const initial = h.read(journal.json);
		const displayed: string[] = [];
		const limited = await runGptSync(h.plugin, h.settings.chatgpt[0]!, (_msg, _done, _total, stage) => {
			const count = h.settings.chatgpt[0]!.web.chatProgress;
			if (stage && count) displayed.push(`${count.saved}/${count.total}: ${stage}`);
		});
		assert(displayed.includes('0/1: downloading chat 1'));
		assert(displayed.includes('1/1: checking files for chat 1'));
		assert.match(limited.stopped ?? '', /429/);
		assert.match(limited.stopped ?? '', /downloading generated file "demo \(1\)\.pdf" for "Fixture" \(queued chat 1 of 1, ID /);
		assert.match(limited.stopped ?? '', /Saved 1 chat this run/);
		assert(h.read('Logs/sync.md').includes(limited.stopped!));
		assert.equal(h.settings.chatgpt[0]!.web.index[id]?.json, journal.json);
		assert.equal(h.read(journal.json), initial);
		assert(h.entries.has(journal.older![0]!));
		assert(paths.includes('projects:next'));
		h.restart();
		assert.equal(h.settings.chatgpt[0]!.web.chatProgress?.saved, 1);
		const beforeCooldown = calls;
		assert.match((await runGptSync(h.plugin, h.settings.chatgpt[0]!)).stopped ?? '', /cooling down/);
		assert.equal(calls, beforeCooldown);

		h.settings.chatgpt[0]!.web.cooldownUntil = Date.now() - 1;
		phase = 'missing';
		const missing = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(missing.pendingAssets, 1);
		const key = sandboxKey(id, 'message-new', '/mnt/data/demo (1).pdf');
		assert.equal(h.settings.chatgpt[0]!.web.assetRetries?.[key]?.attempts, 1);
		const beforeRetry = sandboxCalls;
		await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(sandboxCalls, beforeRetry);
		h.settings.chatgpt[0]!.web.assetRetries![key]!.nextAttempt = Date.now() - 1;
		phase = 'ok';
		const recovered = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(recovered.filesSaved, 1);
		assert.equal(recovered.refreshedViews, 1);
		const index = h.settings.chatgpt[0]!.web.index[id]!;
		assert.equal(index.view, index.md, 'the file link goes into the one note');
		assert(h.read(index.md).includes('demo (1).pdf|PDF]]'));
		assert(h.read(index.md).includes('https://example.org/reference'));
		assert(![...h.entries.keys()].some((p) => p.includes('(transcript ')), 'no "(transcript …)" copy');
		assert.equal((await runGptSync(h.plugin, h.settings.chatgpt[0]!)).refreshedViews, 0);
		assert.equal(h.settings.chatgpt[0]!.web.assetRetries?.[key], undefined);

		fixtureVisible = false;
		const beforeReconciliation = paths.filter((path) => path === 'chat').length;
		const reconciled = await runGptSync(h.plugin, h.settings.chatgpt[0]!, undefined, true);
		assert.equal(reconciled.fullLists, 6);
		assert.equal(paths.filter((path) => path === 'chat').length, beforeReconciliation);
		assert.equal(h.read(journal.json), initial);

		// A deleted older part is fetched again under the same names: no "(recovered)" pair.
		h.entries.delete(journal.older![0]!);
		h.contents.delete(journal.older![0]!);
		olderPayload = { ...older, messages: [message('different-old', 'Changed remote text')] };
		const repaired = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(repaired.restored.length, 1);
		assert.equal(h.settings.chatgpt[0]!.web.index[id]?.json, journal.json);
		assert.equal(h.read(journal.json), initial);
		assert(h.read(h.settings.chatgpt[0]!.web.index[id]!.older![0]!).includes('Changed remote text'));
		assert(![...h.entries.keys()].some((p) => p.includes('(recovered)')));
		assert(!h.settings.chatgpt[0]!.web.index[id]!.versions?.length, 'the same version again keeps no earlier one');

		// The chat continues: one note, rewritten; the version before (main file and older part) is kept.
		fixtureVisible = true;
		const web = h.settings.chatgpt[0]!.web;
		const beforeMd = web.index[id]!.md;
		const beforeOlder = h.read(web.index[id]!.older![0]!);
		const notes = () => [...h.entries.keys()].filter((p) => p.endsWith('.md') && p.startsWith('Chats/')).sort();
		const notesBefore = notes();
		listDate = '2026-11-08T10:30:00Z';
		topPayload = { ...top, update_time: 1794133800, messages: [...top.messages, message('message-newer', 'A later answer')] };
		// Stopped in the middle of keeping the earlier version, then run again: still exactly one version.
		h.interrupt();
		assert.match((await runGptSync(h.plugin, h.settings.chatgpt[0]!)).stopped ?? '', /simulated interruption/);
		h.restart();
		assert.equal(h.read(web.index[id]!.json), initial, 'nothing written over before the earlier version is safe');
		const continued = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		const now = web.index[id]!;
		assert.equal(continued.changedCount, 1, continued.stopped);
		assert.equal(now.md, beforeMd);
		assert.equal(now.json, journal.json);
		assert.deepEqual(notes(), notesBefore, 'no second note');
		assert(h.read(now.md).includes('A later answer'));
		assert(h.read(now.json).includes('A later answer'));
		assert.equal(now.versions?.length, 1);
		const [keptMain, keptOlder] = now.versions![0]!.files;
		assert.match(keptMain!, /Fixture \(version \d{4}-\d\d-\d\d \d{4}\)\.json$/);
		assert.match(keptOlder!, /Fixture \(version \d{4}-\d\d-\d\d \d{4}\) \(older 1\)\.json$/);
		assert.equal(h.read(keptMain!), initial);
		assert.equal(h.read(keptOlder!), beforeOlder);
		assert(h.read(now.md).includes('earlier_versions: 1'));
		assert(h.read(now.md).includes(`  - "[[${keptMain}]]"`));
		assert(![...h.entries.keys()].some((p) => p.includes('(updated ')));
		assert.equal(web.pendingCaptures?.[id], undefined);
		const settledFiles = h.entries.size;
		const quiet = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(quiet.changedCount + quiet.newCount + quiet.refreshedViews, 0);
		assert.equal(h.entries.size, settledFiles, 'syncing again adds no files');
		console.log('ChatGPT sync integration passed: listing and download 429 recovery, archive scope, project cursors, interrupted capture, file retry, citations, note refreshed in place, repair under the same names, and a continued chat as one note with its earlier version kept.');
	} finally {
		GptApi.connect = connect;
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
