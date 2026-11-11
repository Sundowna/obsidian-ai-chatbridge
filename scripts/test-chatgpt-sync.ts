import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import { GptApi } from '../src/chatgpt/api';
import { runGptSync } from '../src/chatgpt/sync';
import { GptRateLimitError, retryDeadline } from '../src/chatgpt/recovery';
import { sandboxKey } from '../src/chatgpt/files';
import { checkGptChat, checkGptOlderPage } from '../src/chatgpt/schema';
import { DEFAULT_SETTINGS, DEFAULT_GPT } from '../src/settings';
import AIChatBridge, { formatClock } from '../src/main';
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
			app: { ...h.plugin.app, workspace: { onLayoutReady: (fn: () => void) => fn() },
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

		// Automatic sync on and idle: the status bar says so, unless an error paused it.
		p.settings.intervalMinutes = 30;
		p.restartTimer();
		assert.equal(status, '', 'paused after the login error');
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

function harness() {
	const entries = new Map<string, TFile | TFolder>();
	const contents = new Map<string, ArrayBuffer>();
	const settings = structuredClone({ ...DEFAULT_SETTINGS, logPath: 'Logs/sync.md' });
	settings.chatgpt[0]!.web = { ...DEFAULT_GPT, folder: 'Chats', includeArchived: true };
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
		restart: () => { Object.assign(settings.chatgpt[0]!.web, structuredClone(saved.chatgpt[0]!.web)); },
	};
}

/** A voice chat saved by an older version gets a new transcript once; syncing again adds nothing. */
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
		listPath: (offset: number, tpp: boolean, archived: boolean) => 'list:' + [offset, tpp, archived].join(':'),
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
		const files = h.entries.size;
		const second = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(second.refreshedViews, 1);
		assert.equal(h.read(entry.md), oldNote, 'the original note is kept as it was');
		assert.equal(h.entries.size, files + 1, 'one new transcript, nothing else');
		const view = h.read(entry.view!);
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
		listPath: (offset: number, tpp: boolean, archived: boolean) => 'list:' + [offset, tpp, archived].join(':'),
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

async function main() {
	assert.equal(retryDeadline('120', 1000), 121000);
	assert.equal(retryDeadline('invalid', 1000), 601000);
	assert.equal(retryDeadline('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 120000);
	assert.throws(() => checkGptChat({ ...top, page_info: undefined }, id));
	assert.throws(() => checkGptOlderPage({ messages: [], page_info: {} }));
	await testAutomaticResume();
	Object.assign(globalThis, { window: { setTimeout: (fn: () => void) => setTimeout(fn, 0) } });
	await testVoiceReimport();
	await testJsonFolder();
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
		const limitedListing = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.match(limitedListing.stopped ?? '', /429/);
		assert.match(limitedListing.stopped ?? '', /listing archived normal chats \(offset 1\)\. Saved 0 chats/);
		assert(!limitedListing.stopped?.includes('Fixture'));
		assert.equal(limitedListing.listingRequests, 4);
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
		assert(h.read(index.view!).includes('demo (1).pdf|PDF]]'));
		assert(h.read(index.view!).includes('https://example.org/reference'));
		assert(h.read(index.md).includes('generated file not downloaded'));
		assert.equal((await runGptSync(h.plugin, h.settings.chatgpt[0]!)).refreshedViews, 0);
		assert.equal(h.settings.chatgpt[0]!.web.assetRetries?.[key], undefined);

		fixtureVisible = false;
		const beforeReconciliation = paths.filter((path) => path === 'chat').length;
		const reconciled = await runGptSync(h.plugin, h.settings.chatgpt[0]!, undefined, true);
		assert.equal(reconciled.fullLists, 4);
		assert.equal(paths.filter((path) => path === 'chat').length, beforeReconciliation);
		assert.equal(h.read(journal.json), initial);

		// Missing older bytes after a remote change must create a separate capture.
		h.entries.delete(journal.older![0]!);
		h.contents.delete(journal.older![0]!);
		olderPayload = { ...older, messages: [message('different-old', 'Changed remote text')] };
		const repaired = await runGptSync(h.plugin, h.settings.chatgpt[0]!);
		assert.equal(repaired.restored.length, 1);
		assert.notEqual(h.settings.chatgpt[0]!.web.index[id]?.json, journal.json);
		assert.equal(h.read(journal.json), initial);
		assert(h.read(h.settings.chatgpt[0]!.web.index[id]!.older![0]!).includes('Changed remote text'));
		console.log('ChatGPT sync integration passed: listing and download 429 recovery, archive scope, project cursors, interrupted capture, file retry, citations, refreshed transcript, and repair outside the listing window.');
	} finally {
		GptApi.connect = connect;
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
