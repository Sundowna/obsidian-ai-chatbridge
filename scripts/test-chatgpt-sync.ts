import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import { GptApi } from '../src/chatgpt/api';
import { runGptSync } from '../src/chatgpt/sync';
import { GptRateLimitError, retryDeadline } from '../src/chatgpt/recovery';
import { sandboxKey } from '../src/chatgpt/files';
import { checkGptChat, checkGptOlderPage } from '../src/chatgpt/schema';
import { DEFAULT_SETTINGS, DEFAULT_GPT } from '../src/settings';
import AIChatBridge from '../src/main';
import { StopError } from '../src/api';

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
	persisted.gpt.chatProgress = { inventoryKey: 'account:retry-test', scope: '[true,[],"",[]]', saved: 285, total: 926 };
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
			app: { ...h.plugin.app, workspace: { onLayoutReady: (fn: () => void) => fn() },
				vault: { ...h.plugin.app.vault, on: () => ({}) } },
			loadData: async () => structuredClone(persisted),
			saveData: async (settings: typeof persisted) => { persisted = structuredClone(settings); },
			addStatusBarItem: () => ({ setText: (text: string) => { status = text; } }),
			addCommand: (command: { id: string; checkCallback?: (checking: boolean) => boolean }) => commands.set(command.id, command),
			addSettingTab: () => {},
			registerInterval: () => 0,
			registerEvent: () => {},
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
	} });
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
		assert.equal(persisted.gpt.cooldownUntil, now + 30_000);
		assert.equal(persisted.gpt.resumeAfter429?.consecutive, 1);
		assert.equal(status, 'ChatGPT: 285 of 926 chats saved · retry in 00:30');
		p.onunload();
		assert.equal(timers.size, 0);
		assert.equal(status, '');
		p = await load();
		assert.equal(calls, 1);
		const due = persisted.gpt.cooldownUntil!;
		fire(now + 1000);
		assert.equal(status, 'ChatGPT: 285 of 926 chats saved · retry in 00:29');
		assert.equal(calls, 1);
		fire(due);
		await flush(() => timers.size === 1 && persisted.gpt.resumeAfter429?.consecutive === 2);
		assert.equal(calls, 2);
		assert.equal(persisted.gpt.cooldownUntil, due + 60_000);
		assert.equal(status, 'ChatGPT: 285 of 926 chats saved · retry in 01:00');
		outcome = 'success';
		fire(persisted.gpt.cooldownUntil!);
		await flush(() => calls === 3 && !persisted.gpt.resumeAfter429 && status === '');
		assert.equal(timers.size, 0);
		// Idle after a finished sync: the status bar is cleared.
		assert.equal(status, '');

		outcome = 'limit';
		await p.syncGpt('auto');
		assert.equal(timers.size, 1);
		assert(commands.get('cancel-chatgpt-retry')?.checkCallback?.(false));
		await flush(() => persisted.gpt.resumeAfter429 === null);
		assert.equal(timers.size, 0);
		assert(persisted.gpt.cooldownUntil! > now);
		p.onunload();
		p = await load();
		assert.equal(timers.size, 0);

		// A pre-upgrade cooldown can be adopted, then a login error disarms it.
		delete persisted.gpt.resumeAfter429;
		p.onunload();
		p = await load();
		assert.equal(timers.size, 1);
		outcome = 'login-error';
		fire(persisted.gpt.cooldownUntil!);
		await flush(() => !persisted.gpt.resumeAfter429);
		assert.equal(timers.size, 0);

		// Automatic sync on and idle: the status bar says so, unless an error paused it.
		p.settings.intervalMinutes = 30;
		p.restartTimer();
		assert.equal(status, '', 'paused after the login error');
		p.onunload();
		p = await load();
		p.settings.intervalMinutes = 30;
		p.restartTimer();
		assert.equal(status, 'AI ChatBridge active');
		p.settings.intervalMinutes = 0;
		p.restartTimer();
		assert.equal(status, '');
		p.onunload();
		console.log('Automatic 429 retry passed: visible countdown, persisted timer, restart, backoff, success, cancellation, login-error stop and idle auto-sync status.');
	} finally {
		Date.now = realNow;
		GptApi.connect = connect;
		Object.assign(globalThis, { window: originalWindow });
	}
}

function harness() {
	const entries = new Map<string, TFile | TFolder>();
	const contents = new Map<string, ArrayBuffer>();
	const settings = structuredClone({ ...DEFAULT_SETTINGS, gpt: { ...DEFAULT_GPT, folder: 'Chats', includeArchived: true }, logPath: 'Logs/sync.md' });
	let saved = structuredClone(settings);
	let crashOnOlder = false;
	const read = (path: string) => new TextDecoder().decode(contents.get(path));
	const put = (path: string, content: ArrayBuffer) => {
		assert(!entries.has(path), 'original was overwritten');
		if (crashOnOlder && path.endsWith('(older 1).json')) {
			crashOnOlder = false;
			throw new Error('simulated interruption while saving an older page');
		}
		const f = new TFile(path, { size: content.byteLength });
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
		adapter: { readBinary: async (path: string) => contents.get(path)!, read: async (path: string) => read(path) },
	};
	const plugin = {
		settings, app: { vault, fileManager: { processFrontMatter: async () => {} } },
		saveSettings: async () => { saved = structuredClone(settings); },
	} as unknown as AIChatBridge;
	return { settings, entries, contents, plugin, read,
		interrupt: () => { crashOnOlder = true; },
		restart: () => { Object.assign(settings.gpt, structuredClone(saved.gpt)); },
	};
}

async function main() {
	assert.equal(retryDeadline('120', 1000), 121000);
	assert.equal(retryDeadline('invalid', 1000), 601000);
	assert.equal(retryDeadline('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 120000);
	assert.throws(() => checkGptChat({ ...top, page_info: undefined }, id));
	assert.throws(() => checkGptOlderPage({ messages: [], page_info: {} }));
	await testAutomaticResume();
	Object.assign(globalThis, { window: { setTimeout: (fn: () => void) => setTimeout(fn, 0) } });
	let calls = 0;
	let sandboxCalls = 0;
	let listingLimit = true;
	let olderPageLimit = false;
	let fixtureVisible = true;
	let phase: 'limit' | 'missing' | 'ok' = 'limit';
	const h = harness();
	const paths: string[] = [];
	let olderPayload = older;
	const connect = GptApi.connect;
	GptApi.connect = async () => {
		calls++;
		return {
			inventoryKey: 'account:integration-test',
			listPath: (offset: number, tpp: boolean, archived: boolean) => 'list:' + [offset, tpp, archived].join(':'),
			projectPagePath: (cursor?: string) => 'projects:' + (cursor ?? ''),
			chatPath: () => 'chat',
			olderPath: () => 'older',
			redact: (value: string) => value,
			get: async (path: string) => {
				paths.push(path);
				if (listingLimit && path === 'list:1:false:true') throw new GptRateLimitError(Date.now() + 60_000);
				if (fixtureVisible && path === 'list:0:false:true') return raw({ items: [{ id, title: 'Fixture', create_time: date, update_time: date, gizmo_id: null }], offset: 0, total: listingLimit ? 2 : 1 });
				if (path.startsWith('list:')) return raw({ items: [], offset: 0, total: 0 });
				if (path === 'projects:') return raw({ items: [], cursor: 'next' });
				if (path === 'projects:next') return raw({ items: [] });
				if (path === 'chat') return raw(top);
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
		const limitedListing = await runGptSync(h.plugin);
		assert.match(limitedListing.stopped ?? '', /429/);
		assert.match(limitedListing.stopped ?? '', /listing archived normal chats \(offset 1\)\. Saved 0 chats/);
		assert(!limitedListing.stopped?.includes('Fixture'));
		assert.equal(limitedListing.listingRequests, 4);
		assert.equal(limitedListing.leftForLater, 1);
		h.restart();
		const inventory = h.settings.gpt.inventories!.accounts['account:integration-test']!;
		assert.equal(inventory.queue[id]?.id, id);
		assert(inventory.checkpoints['active-normal']);
		assert.equal(inventory.checkpoints['archived-normal'], undefined);
		assert.equal(inventory.checkpoints['archived-tpp'], undefined);
		const beforeListingCooldown = calls;
		assert.match((await runGptSync(h.plugin)).stopped ?? '', /cooling down/);
		assert.equal(calls, beforeListingCooldown);
		h.settings.gpt.cooldownUntil = Date.now() - 1;
		listingLimit = false;

		olderPageLimit = true;
		const limitedPage = await runGptSync(h.plugin);
		assert.match(limitedPage.stopped ?? '', /fetching older conversation page 1 for "Fixture" \(queued chat 1 of 1, ID /);
		assert(h.read('Logs/sync.md').includes(limitedPage.stopped!));
		h.settings.gpt.cooldownUntil = Date.now() - 1;
		olderPageLimit = false;

		h.interrupt();
		const interrupted = await runGptSync(h.plugin);
		assert.match(interrupted.stopped ?? '', /simulated interruption/);
		h.restart();
		const journal = h.settings.gpt.pendingCaptures![id]!;
		assert(h.entries.has(journal.json));
		const initial = h.read(journal.json);
		const displayed: string[] = [];
		const limited = await runGptSync(h.plugin, (_msg, _done, _total, stage) => {
			const count = h.settings.gpt.chatProgress;
			if (stage && count) displayed.push(`${count.saved}/${count.total}: ${stage}`);
		});
		assert(displayed.includes('0/1: downloading chat 1'));
		assert(displayed.includes('1/1: checking files for chat 1'));
		assert.match(limited.stopped ?? '', /429/);
		assert.match(limited.stopped ?? '', /downloading generated file "demo \(1\)\.pdf" for "Fixture" \(queued chat 1 of 1, ID /);
		assert.match(limited.stopped ?? '', /Saved 1 chat this run/);
		assert(h.read('Logs/sync.md').includes(limited.stopped!));
		assert.equal(h.settings.gpt.index[id]?.json, journal.json);
		assert.equal(h.read(journal.json), initial);
		assert(h.entries.has(journal.older![0]!));
		assert(paths.includes('projects:next'));
		h.restart();
		assert.equal(h.settings.gpt.chatProgress?.saved, 1);
		const beforeCooldown = calls;
		assert.match((await runGptSync(h.plugin)).stopped ?? '', /cooling down/);
		assert.equal(calls, beforeCooldown);

		h.settings.gpt.cooldownUntil = Date.now() - 1;
		phase = 'missing';
		const missing = await runGptSync(h.plugin);
		assert.equal(missing.pendingAssets, 1);
		const key = sandboxKey(id, 'message-new', '/mnt/data/demo (1).pdf');
		assert.equal(h.settings.gpt.assetRetries?.[key]?.attempts, 1);
		const beforeRetry = sandboxCalls;
		await runGptSync(h.plugin);
		assert.equal(sandboxCalls, beforeRetry);
		h.settings.gpt.assetRetries![key]!.nextAttempt = Date.now() - 1;
		phase = 'ok';
		const recovered = await runGptSync(h.plugin);
		assert.equal(recovered.filesSaved, 1);
		assert.equal(recovered.refreshedViews, 1);
		const index = h.settings.gpt.index[id]!;
		assert(h.read(index.view!).includes('demo (1).pdf|PDF]]'));
		assert(h.read(index.view!).includes('https://example.org/reference'));
		assert(h.read(index.md).includes('generated file not downloaded'));
		assert.equal((await runGptSync(h.plugin)).refreshedViews, 0);
		assert.equal(h.settings.gpt.assetRetries?.[key], undefined);

		fixtureVisible = false;
		const beforeReconciliation = paths.filter((path) => path === 'chat').length;
		const reconciled = await runGptSync(h.plugin, undefined, true);
		assert.equal(reconciled.fullLists, 4);
		assert.equal(paths.filter((path) => path === 'chat').length, beforeReconciliation);
		assert.equal(h.read(journal.json), initial);

		// Missing older bytes after a remote change must create a separate capture.
		h.entries.delete(journal.older![0]!);
		h.contents.delete(journal.older![0]!);
		olderPayload = { ...older, messages: [message('different-old', 'Changed remote text')] };
		const repaired = await runGptSync(h.plugin);
		assert.equal(repaired.restored.length, 1);
		assert.notEqual(h.settings.gpt.index[id]?.json, journal.json);
		assert.equal(h.read(journal.json), initial);
		assert(h.read(h.settings.gpt.index[id]!.older![0]!).includes('Changed remote text'));
		console.log('ChatGPT sync integration passed: listing and download 429 recovery, archive scope, project cursors, interrupted capture, file retry, citations, refreshed transcript, and repair outside the listing window.');
	} finally {
		GptApi.connect = connect;
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
