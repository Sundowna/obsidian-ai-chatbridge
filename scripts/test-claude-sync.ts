// Offline test of one claude.ai sync on an in-memory vault: a chat that continues stays one note,
// and the version before is kept as raw JSON. No network: ClaudeApi.get answers from fixtures.
// Run: npm run test:claude

import { TFile, TFolder, testHooks } from 'obsidian';
import { isOutputPath, outputFiles, outputKey, OUTPUTS_DIR } from '../src/files';
import { ClaudeApi, chatViewNotOffered, RateLimitError, StopError } from '../src/api';
import { clearCooldown, coolingUntil, countdown, retryDeadline, startCooldown, stillCooling, type Cooling } from '../src/rate-limit';
import { endCooldown, heldByCooldown, pausedBy } from '../src/cooldown-run';
import { addAccount } from '../src/accounts';
import { normalizeSettings } from '../src/migrate';
import { localStamp } from '../src/naming';
import { runSync } from '../src/sync';
import { followRename } from '../src/follow';
import { netRetry, NetworkFailure, sendWithRetry, triedText } from '../src/net-retry';
import { OddChats, readOrSkip } from '../src/odd-chats';
import { FULL_LIST_EVERY, ListRead, needsFullList, type ListCatalog } from '../src/quick-list';
import { ShapeError } from '../src/schema';
import { readWrite } from './fake-vault';
import { noteHash } from '../src/versions';
import { restoreSavedChats, separateSavedChats } from '../src/archive-local';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const PROJECT = { name: '2nd Brain', uuid: '33333333-3333-4333-8333-333333333333' };

/** Path -> content; every write moves that path's modified time on, like a real disk. */
const times = new Map<string, number>();
let clock = 0;
class StampedMap extends Map<string, string> {
	override set(key: string, value: string): this {
		times?.set(key, ++clock);
		return super.set(key, value);
	}
}
const files = new StampedMap();
const folders = new Set<string>();
/** Paths read through the adapter: shows which raw files a sync opened. */
const reads: string[] = [];
const PLUGIN_DIR = '.obsidian/plugins/ai-chatbridge';
let buildTime = 1;
const vault = {
	getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : folders.has(p) ? new TFolder(p) : null),
	createFolder: async (p: string) => void folders.add(p),
	create: async (p: string, d: string) => {
		if (files.has(p)) throw new Error('exists ' + p);
		files.set(p, d);
	},
	process: async (f: { path: string }, fn: (d: string) => string) => void files.set(f.path, fn(files.get(f.path) ?? '')),
	adapter: {
		read: async (p: string) => { reads.push(p); return files.get(p) ?? ''; },
		stat: async (p: string): Promise<{ type: string; size: number; mtime: number } | null> => {
			if (p === `${PLUGIN_DIR}/main.js`) return { type: 'file', size: 1000, mtime: buildTime };
			return files.has(p) ? { type: 'file', size: files.get(p)!.length, mtime: times.get(p)! } : null;
		},
		exists: async (p: string) => folders.has(p) || files.has(p),
		list: async (p: string) => {
			const child = (path: string) => path.startsWith(p + '/') && !path.slice(p.length + 1).includes('/');
			return { folders: [...folders].filter(child), files: [...files.keys()].filter(child) };
		},
		rmdir: async (p: string, recursive: boolean) => {
			if (recursive || [...folders, ...files.keys()].some((path) => path.startsWith(p + '/'))) throw new Error('folder is not empty');
			folders.delete(p);
		},
	},
	...readWrite(files),
};

const settings = normalizeSettings({ maxChatsPerRun: 0, logPath: 'log.md' }).settings;
const account = settings.claude[0]!;
Object.assign(account.web, { orgId: ORG, secretId: 'key', chatFolder: 'AI/Claude/Chat', downloadFiles: false, cloudSessions: false });
const plugin = {
	manifest: { dir: PLUGIN_DIR, version: 'test' },
	app: { vault, fileManager: {
		processFrontMatter: async () => undefined,
		renameFile: async (f: TFile, to: string) => {
			if (files.has(to)) throw new Error('exists ' + to);
			files.set(to, files.get(f.path)!);
			files.delete(f.path);
			f.path = to;
		},
	}, secretStorage: { getSecret: () => 'sk-test' } },
	settings,
	saveSettings: async () => undefined,
} as never;

let updated = '2026-11-06T10:00:00Z';
let project: typeof PROJECT | null = PROJECT;
let turns = ['First question', 'First answer'];
const FILE = '55555555-5555-4555-8555-555555555555';
let attach = false;
let oddShape = false;
let star: boolean | undefined;
let pastes: Record<string, unknown>[] = [];
const chat = () => ({
	uuid: CHAT, name: 'Plan the vault', created_at: '2026-11-06T09:00:00Z', updated_at: updated, model: 'claude-opus-5-5', ...(star === undefined ? {} : { is_starred: star }),
	chat_messages: oddShape ? 'not a list' as never : turns.map((text, i) => ({ uuid: `m${i}`, sender: i % 2 ? 'assistant' : 'human', text, content: [{ type: 'text', text }], created_at: '2026-11-06T09:00:00Z',
		...((attach || pastes.length) && i === 0 ? { attachments: [...(attach ? [{ file_uuid: FILE, file_name: 'notes.txt', size_bytes: 5 }] : []), ...pastes] } : {}) })),
});
let fileFetches = 0;
ClaudeApi.prototype.getFile = async () => { fileFetches++; return new TextEncoder().encode('notes').buffer; };
const realReadConversation = ClaudeApi.prototype.readConversation;
ClaudeApi.prototype.readConversation = async () => ({});
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer;
// An archived chat: only in claude.ai's archived list (with the first chat again, to check it is kept once).
const ARCHIVED = '44444444-4444-4444-8444-444444444444';
const archivedChat = {
	uuid: ARCHIVED, name: 'Old garden plan', created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T10:00:00Z',
	chat_messages: [{ uuid: 'a0', sender: 'human', text: 'Archived question', content: [{ type: 'text', text: 'Archived question' }], created_at: '2026-10-01T09:00:00Z' }],
};
const listed: string[] = [];
let currentMembership: 'active' | 'archived' | 'both' = 'both';
let bodyRequests = 0;
let limited = false;
let requests = 0;
/** A long chat list for the quick-list tests, in the order claude.ai hands it out; null = the small fixtures below. */
let big: { uuid: string; name: string; created_at: string; updated_at: string; project: null }[] | null = null;
ClaudeApi.prototype.get = async function (path: string) {
	requests++;
	if (limited) throw new RateLimitError('claude.ai', Date.now() + 1000);
	if (big) {
		let json: unknown;
		if (path.includes('chat_conversations_v2')) {
			listed.push(path);
			const offset = Number(/offset=(\d+)/.exec(path)![1]);
			json = path.includes('archived=true') ? { data: [], has_more: false } : { data: big.slice(offset, offset + 30), has_more: offset + 30 < big.length };
		} else {
			bodyRequests++;
			const row = big.find((r) => path.includes(r.uuid))!;
			json = { ...row, chat_messages: [{ uuid: 'q0', sender: 'human', text: `Question in ${row.name}`, content: [{ type: 'text', text: `Question in ${row.name}` }], created_at: row.created_at }] };
		}
		return { json, bytes: bytes(json) };
	}
	const current = { uuid: CHAT, name: 'Plan the vault', created_at: '2026-11-06T09:00:00Z', updated_at: updated, project, ...(star === undefined ? {} : { is_starred: star }) };
	if (path.includes('chat_conversations_v2')) listed.push(path);
	else bodyRequests++;
	const json = path.includes('chat_conversations_v2')
		? path.includes('archived=true')
			? { data: [{ uuid: ARCHIVED, name: archivedChat.name, created_at: archivedChat.created_at, updated_at: archivedChat.updated_at, project: null }, ...(currentMembership === 'active' ? [] : [current])], has_more: false }
			: { data: currentMembership === 'archived' ? [] : [current], has_more: false }
		: path.includes(ARCHIVED) ? archivedChat : chat();
	return { json, bytes: bytes(json) };
};
Object.assign(globalThis, { window: { setTimeout: (fn: () => void) => setTimeout(fn, 0) } });

(async () => {
	const md = 'AI/Claude/Chat/2nd Brain/2026-11-06 Plan the vault.md';
	const json = '80 Archive/raw/AI/Claude/Chat/2nd Brain/2026-11-06 Plan the vault.json';
	const notes = () => [...files.keys()].filter((p) => p.endsWith('.md') && p !== 'log.md');

	const r1 = await runSync(plugin, account);
	expect('sync 1: new chat saved', !r1.stopped && r1.newCount === 1 && files.has(md) && files.has(json), r1.stopped ?? [...files.keys()].join(' | '));
	const first = files.get(json)!;
	expect('sync 1: the note names the model in its properties', files.get(md)!.split('---')[1]!.includes('\nmodel: "claude-opus-5-5"\n'), files.get(md)!.split('---')[1]);

	const r2 = await runSync(plugin, account);
	expect('sync 2: unchanged', r2.unchanged === 1 && r2.newCount + r2.changedCount === 0);

	// The chat continues (and was moved to no project on claude.ai): the note stays where it is.
	turns = [...turns, 'Second question', 'Second answer'];
	updated = '2026-11-07T15:30:00Z';
	project = null;
	const r3 = await runSync(plugin, account);
	const entry = account.web.index[CHAT]!;
	const kept = `80 Archive/raw/AI/Claude/Chat/2nd Brain/2026-11-06 Plan the vault (version ${localStamp('2026-11-06T10:00:00Z')}).json`;
	expect('sync 3: one note, same name, rewritten with the whole chat', r3.changedCount === 1 && entry.md === md && notes().length === 1 && files.get(md)!.includes('Second answer') && files.get(md)!.includes('First question'), notes().join(' | '));
	expect('sync 3: no "(updated …)" file', ![...files.keys()].some((p) => p.includes('(updated')));
	expect('sync 3: the earlier version is in the raw folder, byte for byte', files.get(kept) === first && entry.versions?.[0]?.files[0] === kept, [...files.keys()].join(' | '));
	expect('sync 3: the raw file holds the current chat', entry.json === json && files.get(json)!.includes('Second answer'));
	expect('sync 3: note says when it was updated and how many earlier versions exist', files.get(md)!.includes('updated: 2026-11-07T15:30:00Z') && files.get(md)!.includes('earlier_versions: 1') && files.get(md)!.includes(`  - "[[${kept}]]"`));
	expect('sync 3: log names the note', (files.get('log.md') ?? '').includes('[[2026-11-06 Plan the vault]]'));

	// You renamed the note in Obsidian; the chat continues: the renamed note is the one updated.
	const renamed = 'AI/Claude/Chat/2nd Brain/Vault plan (mine).md';
	files.set(renamed, files.get(md)!);
	files.delete(md);
	entry.md = renamed;
	turns = [...turns, 'Third question'];
	updated = '2026-11-08T08:00:00Z';
	const r4 = await runSync(plugin, account);
	expect('sync 4: your renamed note is updated, no new one', r4.changedCount === 1 && account.web.index[CHAT]!.md === renamed && notes().length === 1 && files.get(renamed)!.includes('Third question') && account.web.index[CHAT]!.versions?.length === 2);

	// Deleted note: written again under the same name, with its version info.
	files.delete(renamed);
	const r5 = await runSync(plugin, account);
	expect('sync 5: deleted note restored with its version info', r5.restored.length === 1 && files.get(renamed)!.includes('earlier_versions: 2'));

	// Include archived chats: off by default, so the archived list is never asked for.
	expect('archived off: only the normal list is read', listed.length > 0 && listed.every((p) => p.includes('archived=false')), listed.join(' | '));
	listed.length = 0;
	account.web.includeArchived = true;
	const r6 = await runSync(plugin, account);
	const archivedMd = 'AI/Claude/Chat/Recent/2026-10-01 Old garden plan.md';
	expect('archived on: both lists read', listed.some((p) => p.includes('archived=false')) && listed.some((p) => p.includes('archived=true')), listed.join(' | '));
	expect('archived on: archived chat saved in its normal folder, chat in both lists kept once', r6.listed === 2 && r6.newCount === 1 && r6.unchanged === 1 && files.get(archivedMd)?.includes('Archived question') === true, `${JSON.stringify({ listed: r6.listed, newCount: r6.newCount, unchanged: r6.unchanged, stopped: r6.stopped })} ${notes().join(' | ')}`);

	{
		// A manually moved and edited note is parked under the mirror of its actual active path.
		const manual = 'Projects/Custom/Vault plan (mine).md';
		const projectNote = 'Projects/Custom/DECISIONS.md';
		const saved = account.web.index[CHAT]!;
		await vault.create(manual, files.get(saved.md)! + '\nMy edit\n');
		await vault.create(projectNote, 'Keep this decision');
		files.delete(saved.md);
		saved.md = manual;
		account.web.separateArchived = true;
		project = PROJECT;
		currentMembership = 'archived';
		const beforeBodies = bodyRequests;
		const stopped = await runSync(plugin, account, (text) => {
			if (text === 'moving archived chats 2 of 2') throw new StopError('Stopped by you.');
		});
		expect('separation: Stop finishes between chats', stopped.archive?.moved === 1 && stopped.stopped === 'Stopped by you.' && saved.md === manual);
		const reconciled = await runSync(plugin, account);
		const manualArchive = 'AI/Claude/Chat/Archived/_External/Projects/Custom/Vault plan (mine).md';
		expect('separation: existing chat moves with its name and edits', reconciled.archive?.moved === 1 && saved.md === manualArchive && files.get(manualArchive)?.includes('My edit') === true, JSON.stringify(reconciled.archive));
		expect('separation: the unrelated project note stays', files.get(projectNote) === 'Keep this decision');
		account.web.separateArchived = false;
		const target = { kind: 'claude', account } as const;
		const listRequestsBefore = listed.length;
		const restored = await restoreSavedChats(plugin, target, () => {});
		expect('separation: turning it off restores original folders and clears the empty archive', restored.report.moved === 2 && saved.md === manual && files.has(archivedMd) && !folders.has('AI/Claude/Chat/Archived'));
		account.web.separateArchived = true;
		const local = await separateSavedChats(plugin, target, () => {});
		expect('separation: re-enabling uses last known status without a provider request', local.report.moved === 2 && !local.unresolved && listed.length === listRequestsBefore && saved.md === manualArchive);
		currentMembership = 'active';
		const returned = await runSync(plugin, account);
		expect('separation: unchanged unarchive restores the manual folder', returned.archive?.moved === 1 && files.has(manual) && !files.has(manualArchive));
		expect('separation: archive changes cause no body requests', bodyRequests === beforeBodies);

		// A second account shares the same configured root, with flat archives and a custom raw folder.
		const second = addAccount(settings, 'claude', 'Second') as typeof account;
		settings.rawRootOn = false;
		Object.assign(second.web, {
			orgId: '55555555-5555-4555-8555-555555555555', secretId: 'synthetic', cloudSessions: false, downloadFiles: false,
			includeArchived: true, separateArchived: true, projectSubfolders: false, onlyProjects: true,
			projects: [PROJECT.uuid, ':no-project'], customProjectFolders: true,
			projectFolders: { [PROJECT.uuid]: 'Projects/Second' }, chatRawFolder: 'Raw/Second',
			projectRawFolders: { [PROJECT.uuid]: 'Raw/Second/Custom' },
		});
		currentMembership = 'archived';
		// The same login as Main (its chats already saved there) stops before anything is written.
		const filesBefore = files.size;
		const same = await runSync(plugin, second);
		expect('same login: chats another account already saved stop the sync, nothing written', (same.stopped ?? '').startsWith('These are the chats of "Main"') && same.newCount === 0 && files.size === filesBefore && !Object.keys(second.web.index).length, same.stopped ?? '');
		// The fake claude.ai serves Main's chats to every account, so for the folder checks below
		// Main's sync history is set aside: the second account then stands for another person.
		const mainIndex = account.web.index;
		account.web.index = {};
		const secondSync = await runSync(plugin, second);
		const secondRoot = `${second.web.chatFolder}/Archived/_Accounts/claude-${second.id}`;
		const secondProject = second.web.index[CHAT]!;
		const secondLoose = second.web.index[ARCHIVED]!;
		expect('separation: a shared root has isolated flat account paths', secondSync.newCount === 2 && [secondProject, secondLoose].every((e) => e.md.slice(0, e.md.lastIndexOf('/')) === secondRoot), secondSync.stopped ?? notes().join(' | '));
		expect('separation: the explicit project raw override takes precedence', secondProject.json.startsWith('Raw/Second/Custom/') && !secondProject.json.includes('/Archived/'));
		expect('separation: the account raw folder has its own archive mirror', secondLoose.json.startsWith(`Raw/Second/Archived/_Accounts/claude-${second.id}/`));
		currentMembership = 'active';
		const secondReturn = await runSync(plugin, second);
		expect('separation: a new archived chat returns to its configured active project', secondReturn.archive?.moved === 1 && secondProject.md.startsWith('Projects/Second/') && secondProject.json.startsWith('Raw/Second/Custom/'));
		account.web.index = mainIndex;
		// The stand-in for another person goes again: it holds the same chats as Main.
		settings.claude.splice(settings.claude.indexOf(second), 1);
	}
	settings.rawRootOn = true;
	project = null;

	// Quick check: an unchanged chat's .json is not read again once a full check found its files there.
	const raw = account.web.index[CHAT]!.json;
	const rawReads = async () => {
		reads.length = 0;
		const r = await runSync(plugin, account);
		return { r, read: reads.filter((p) => p === raw).length };
	};
	account.web.downloadFiles = true;
	attach = true;
	updated = '2026-11-09T08:00:00Z';
	const q1 = await runSync(plugin, account);
	const saved = account.web.fileIndex[FILE];
	expect('quick: the continued chat and its file are saved', q1.changedCount === 1 && !!saved && files.has(saved) && fileFetches === 1, JSON.stringify({ changed: q1.changedCount, saved, fileFetches, stopped: q1.stopped }));
	const q2 = await rawReads();
	expect('quick: the first check of the saved chat reads its .json', q2.read === 1 && !!account.web.index[CHAT]!.quick, String(q2.read));
	const q3 = await rawReads();
	expect('quick: then its .json is not read, nothing fetched', q3.read === 0 && fileFetches === 1 && q3.r.backfilledChats === 0, String(q3.read));
	files.delete(saved!);
	const q4 = await rawReads();
	expect('quick: a deleted file brings the full check back and is fetched again', q4.read === 1 && fileFetches === 2 && files.has(account.web.fileIndex[FILE]!), JSON.stringify({ read: q4.read, fileFetches }));
	expect('quick: then quiet again', (await rawReads()).read === 0);
	buildTime++;
	expect('quick: a new plugin build reads it once more', (await rawReads()).read === 1);
	expect('quick: and then not', (await rawReads()).read === 0);
	files.set(raw, files.get(raw)!.replace('First question', 'First question, changed on disk'));
	expect('quick: a raw file changed on disk is read again', (await rawReads()).read === 1);
	// Audit 2026-11-24: the shortcut must give the same result as the full check in the two cases
	// the folder check (chatFileDeleted) cannot see.
	// (1) The note moved to another folder, then a saved file deleted from the old one: the full
	//     check fetches it again (it is missing), so the quick check must not skip the chat.
	expect('quick: quiet before the move', (await rawReads()).read === 0);
	const oldMd = account.web.index[CHAT]!.md;
	const movedMd = `AI/Claude/Moved/${oldMd.split('/').pop()}`;
	folders.add('AI/Claude/Moved');
	files.set(movedMd, files.get(oldMd)!);
	files.delete(oldMd);
	followRename(settings, oldMd, movedMd);
	const fetchesBeforeMove = fileFetches;
	const moved = await rawReads();
	expect('quick: a moved note alone changes nothing (as the full check)', moved.read === 0 && fileFetches === fetchesBeforeMove && account.web.index[CHAT]!.md === movedMd, JSON.stringify({ read: moved.read, fileFetches }));
	files.delete(account.web.fileIndex[FILE]!);
	const afterMoveDelete = await rawReads();
	expect('quick: after the move, a deleted saved file is still fetched again', afterMoveDelete.read === 1 && fileFetches === fetchesBeforeMove + 1 && files.has(account.web.fileIndex[FILE]!), JSON.stringify({ read: afterMoveDelete.read, fileFetches, path: account.web.fileIndex[FILE] }));
	expect('quick: and then quiet again', (await rawReads()).read === 0);
	// (2) The chat view could not be read: the full check asks for it again next run, so the
	//     shortcut must not skip the chat until it was read once.
	let viewAnswer: unknown = null;
	let views = 0;
	ClaudeApi.prototype.readConversation = async () => { views++; return viewAnswer; };
	updated = '2026-11-10T08:00:00Z';
	const unread = await rawReads();
	expect('quick: a continued chat whose chat view could not be read is saved', unread.r.changedCount === 1 && unread.r.viewNotRead.length === 1, JSON.stringify({ changed: unread.r.changedCount, viewNotRead: unread.r.viewNotRead }));
	const viewsBefore = views;
	await rawReads();
	await rawReads();
	expect('quick: the chat view is asked for again on every run until it is read', views === viewsBefore + 2, `${views - viewsBefore} of 2`);
	viewAnswer = {};
	await rawReads();
	const viewsRead = views;
	expect('quick: once read, the chat is quiet again', (await rawReads()).read === 0 && views === viewsRead);

	// Issue #46: on some account plans claude.ai answers ReadConversation with 403
	// "blocked_by_org_tier". The chat is still saved (without chat-view files), the sync goes on,
	// and the call is not repeated for the other chats of that run. Any other 403 still stops.
	const NOT_OFFERED = JSON.stringify({ code: 'permission_denied', message: 'This isn’t available for your account.', details: [{ type: 'google.rpc.ErrorInfo', debug: { reason: 'feature_not_available', metadata: { sub_reason: 'blocked_by_org_tier' } } }] });
	expect('#46: a "not offered for this plan" 403 is told apart from a plain 403', chatViewNotOffered(NOT_OFFERED) && !chatViewNotOffered('{"code":"permission_denied","message":"Forbidden"}'));
	let rpcCalls = 0;
	let rpcAnswer = { status: 403, contentType: 'application/json', bytes: new ArrayBuffer(0), text: NOT_OFFERED };
	ClaudeApi.prototype.rpc = async () => { rpcCalls++; return rpcAnswer; };
	ClaudeApi.prototype.readConversation = realReadConversation;
	const direct = new ClaudeApi(ORG, () => 'k');
	const v1 = await direct.readConversation(CHAT);
	const v2 = await direct.readConversation(ARCHIVED);
	expect('#46: not offered: no chat view, asked only once', v1 === null && v2 === null && direct.chatViewUnavailable && rpcCalls === 1, String(rpcCalls));
	rpcAnswer = { ...rpcAnswer, text: '{"code":"permission_denied","message":"Forbidden"}' };
	const plain = await new ClaudeApi(ORG, () => 'k').readConversation(CHAT).then(() => 'no stop', (e: unknown) => (e instanceof Error ? e.message : String(e)));
	expect('#46: any other 403 still stops the sync', plain.includes('403 (forbidden) to ReadConversation'), plain);
	rpcAnswer = { ...rpcAnswer, text: NOT_OFFERED };

	// Issue #46, part 2: on such an account the Claude-made files are found by their paths in the
	// chat's tool calls (chat JSON with render_all_tools=true) and fetched like the chat view does
	// (…/conversations/<chat>/wiggle/download-file?path=…). Real request code, fake network.
	const OUT = '/mnt/user-data/outputs/report.md';
	const OUT2 = '/mnt/user-data/outputs/sub/data.csv';
	let outPaths = [OUT];
	let outputStatus = 200;
	let outputCalls = 0;
	const urls: string[] = [];
	const toolsChat = () => {
		const c = chat();
		return { ...c, chat_messages: [...c.chat_messages, { uuid: 'tools', sender: 'assistant', text: '', created_at: '2026-11-06T09:00:00Z', content: [
			{ type: 'tool_use', name: 'present_files', input: { filepaths: outPaths } },
			{ type: 'tool_use', name: 'bash_tool', input: { command: 'cp a /mnt/user-data/outputs/in-a-command.md' } },
			{ type: 'text', text: '/mnt/user-data/outputs/only-mentioned.md' },
		] }] };
	};
	const answer = (status: number, body: string, type: string) => ({ status, headers: { 'content-type': type }, text: body, arrayBuffer: new TextEncoder().encode(body).buffer });
	testHooks.requestUrl = async (r) => {
		const u = new URL(r.url);
		urls.push(u.pathname + u.search);
		if (u.pathname === `/api/organizations/${ORG}/conversations/${CHAT}/wiggle/download-file`) {
			outputCalls++;
			return outputStatus === 200 ? answer(200, 'report', 'application/octet-stream') : answer(outputStatus, '{"type":"error"}', 'application/json');
		}
		if (u.pathname === `/api/organizations/${ORG}/chat_conversations/${CHAT}` && u.searchParams.get('render_all_tools') === 'true') return answer(200, JSON.stringify(toolsChat()), 'application/json');
		throw new Error('unexpected request ' + r.url);
	};
	expect('#46 paths: only exact output paths in tool calls count', JSON.stringify(outputFiles(toolsChat(), CHAT).map((f) => f.output?.path)) === JSON.stringify([OUT]));
	expect('#46 paths: odd paths are refused', isOutputPath(OUT2) && ![OUTPUTS_DIR, `${OUTPUTS_DIR}a/../b`, `${OUTPUTS_DIR}x/`, '/mnt/user-data/uploads/a.md', `${OUTPUTS_DIR}a\nb`, `${OUTPUTS_DIR}./a`].some(isOutputPath));
	expect('#46 paths: the download address carries the path encoded', new ClaudeApi(ORG, () => 'k').outputFilePath(CHAT, OUT).endsWith(`/conversations/${CHAT}/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Freport.md`));

	updated = '2026-11-11T08:00:00Z';
	turns = [...turns, 'Fourth question'];
	const blocked = await runSync(plugin, account);
	const outSaved = account.web.fileIndex[outputKey(CHAT, OUT)] ?? '';
	expect('#46 paths: the Claude-made file is saved in Artifacts and linked from the note', outSaved.includes('/Artifacts/') && outSaved.endsWith('/report.md') && files.has(outSaved) && files.get(account.web.index[CHAT]!.md)!.includes('report.md'), outSaved);
	expect('#46 paths: paths only mentioned in text or commands are not fetched', outputCalls === 1 && !urls.some((u) => u.includes('only-mentioned') || u.includes('in-a-command')), urls.join(' | '));
	expect('#46 paths: the log says the files were looked up by path', (files.get('log.md') ?? '').includes('looked up by path instead (1 chats)'));

	updated = '2026-11-11T09:00:00Z';
	turns = [...turns, 'Fifth question'];
	await runSync(plugin, account);
	expect('#46 paths: a saved file is not fetched again', outputCalls === 1, String(outputCalls));

	outPaths = [OUT, OUT2];
	outputStatus = 403;
	updated = '2026-11-11T10:00:00Z';
	turns = [...turns, 'Sixth question'];
	const refused = await runSync(plugin, account);
	expect('#46 paths: a refused file does not stop the sync and is tried again later', !refused.stopped && refused.changedCount === 1 && refused.filesSkipped.some((f) => f.includes('data.csv') && f.includes('will retry')) && account.web.fileIndex[outputKey(CHAT, OUT2)] === undefined, JSON.stringify({ stopped: refused.stopped, skipped: refused.filesSkipped }));
	outputStatus = 404;
	updated = '2026-11-11T11:00:00Z';
	turns = [...turns, 'Seventh question'];
	await runSync(plugin, account);
	const goneCalls = outputCalls;
	updated = '2026-11-11T12:00:00Z';
	turns = [...turns, 'Eighth question'];
	await runSync(plugin, account);
	expect('#46 paths: a file gone from claude.ai (404) is remembered and not asked for again', (account.web.fileIndex[outputKey(CHAT, OUT2)] ?? '').startsWith('skipped: ') && outputCalls === goneCalls, `${account.web.fileIndex[outputKey(CHAT, OUT2)]} ${outputCalls - goneCalls}`);

	// Issue #64: claude.ai keeps a long paste as a "Pasted" card: an attachment with no name and
	// no file ID, its text in extracted_content. Short ones go into the note, long ones into a
	// file in Attachments/ (no download needed), or folded into the note with downloads off.
	const SHORT = 'Short pasted line one\n\n## A heading inside the paste\nline three';
	const LONG = Array.from({ length: 80 }, (_, i) => `Long paste line ${i + 1}`).join('\n');
	const LONG_KEY = 'pasted:66666666-6666-4666-8666-666666666666';
	const PASTES = [
		{ id: '77777777-7777-4777-8777-777777777777', file_name: '', file_size: SHORT.length, file_type: 'txt', extracted_content: SHORT },
		{ id: LONG_KEY.slice(7), file_name: '', file_size: LONG.length, file_type: 'txt', extracted_content: LONG },
		{ id: '88888888-8888-4888-8888-888888888888', file_name: 'notes.md', file_size: 15, file_type: 'text/markdown', extracted_content: 'Named file text' },
		{ id: '99999999-9999-4999-8999-999999999999', file_name: '', file_size: 0, file_type: 'txt', extracted_content: '  ' },
		{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', file_name: '', file_size: 29, file_type: 'txt', extracted_content: 'five 1\nfive 2\nfive 3\nfive 4\nfive 5' },
		{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', file_name: 'six.txt', file_size: 23, file_type: 'txt', extracted_content: 'six 1\nsix 2\nsix 3\nsix 4\nsix 5\nsix 6' },
	];
	pastes = PASTES;
	const fetchesBeforePaste = fileFetches;
	const callsBeforePaste = outputCalls;
	updated = '2026-11-11T13:00:00Z';
	turns = [...turns, 'Ninth question'];
	const pasted = await runSync(plugin, account);
	const pNote = files.get(account.web.index[CHAT]!.md) ?? '';
	const pFile = account.web.fileIndex[LONG_KEY] ?? '';
	expect('#64: a short paste is in the note, every line quoted', !pasted.stopped && pNote.includes('> [!quote] Pasted text\n> Short pasted line one\n>\n> ## A heading inside the paste\n> line three'), pasted.stopped ?? pNote.slice(pNote.indexOf('Pasted') - 20, pNote.indexOf('Pasted') + 200));
	expect('#64: a heading in a paste never becomes a transcript heading', !/^## A heading/m.test(pNote));
	expect('#64: a short text file is in the note under its own name', pNote.includes('> [!quote] notes.md\n> Named file text'));
	expect('#64: a long paste is saved in Attachments/ with its exact text', pFile.includes('/Attachments/') && pFile.endsWith('/Pasted text.md') && files.get(pFile) === LONG, pFile);
	expect('#64: the note links the long paste with its first 5 lines', pNote.includes(`> [!quote] [[${pFile}|Pasted text]] (80 lines)\n> Long paste line 1\n> Long paste line 2\n> Long paste line 3\n> Long paste line 4\n> Long paste line 5\n> …`) && !pNote.includes('Long paste line 6'));
	expect('#64: a paste of 5 lines is still in the note', pNote.includes('> [!quote] Pasted text\n> five 1\n> five 2\n> five 3\n> five 4\n> five 5'));
	const sixFile = account.web.fileIndex['pasted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] ?? '';
	expect('#64: 6 lines go to a file under their own name, linked', sixFile.endsWith('/Attachments/2026-11-06 Plan the vault/six.txt') && files.get(sixFile) === 'six 1\nsix 2\nsix 3\nsix 4\nsix 5\nsix 6' && pNote.includes(`> [!quote] [[${sixFile}|six.txt]] (6 lines)\n> six 1\n`) && pNote.includes('> six 5\n> …') && !pNote.includes('> six 6'), sixFile);
	expect('#64: an empty paste adds nothing', (pNote.match(/\[!quote\]/g) ?? []).length === 5);
	expect('#64: pastes need no download', fileFetches === fetchesBeforePaste && outputCalls === callsBeforePaste, `${fileFetches - fetchesBeforePaste} files, ${outputCalls - callsBeforePaste} outputs`);
	const again = await runSync(plugin, account);
	expect('#64: an unchanged chat saves its paste only once', again.filesSaved === 0 && again.unchanged >= 1 && [...files.keys()].filter((k) => k.includes('/Pasted text')).length === 1);
	files.delete(pFile);
	const back = await runSync(plugin, account);
	expect('#64: a deleted paste file is written again', back.backfilledChats === 1 && files.get(account.web.fileIndex[LONG_KEY]!) === LONG, JSON.stringify({ backfilled: back.backfilledChats, path: account.web.fileIndex[LONG_KEY] }));
	files.delete(account.web.fileIndex[LONG_KEY]!);
	account.web.downloadFiles = false;
	updated = '2026-11-11T14:00:00Z';
	turns = [...turns, 'Tenth question'];
	await runSync(plugin, account);
	const folded = files.get(account.web.index[CHAT]!.md) ?? '';
	expect('#64: downloads off: the long paste is folded into the note, all of it', folded.includes('> [!quote]- Pasted text (80 lines)\n> Long paste line 1\n') && folded.includes('> Long paste line 80') && !files.has(account.web.fileIndex[LONG_KEY]!));
	account.web.downloadFiles = true;

	// Issue #64, part 2: notes drawn by an older plugin lack the pasted text. Their saved .json
	// has it, so each such note is redrawn once from that file, with no request to claude.ai.
	updated = '2026-11-11T15:00:00Z';
	turns = [...turns, 'Eleventh question'];
	await runSync(plugin, account); // saves the paste files again
	const e64 = () => account.web.index[CHAT]!;
	const drawnNow = files.get(e64().md)!;
	const asOld = (md: string) => md.split('\n').filter((l) => !l.startsWith('>') && !l.startsWith('📎')).join('\n').replace(/\n{3,}/g, '\n\n').replace('unread: true', 'unread: false');
	const oldPlugin = () => {
		delete e64().pastes;
		files.set(e64().md, asOld(drawnNow));
		e64().noteHash = noteHash(files.get(e64().md)!);
	};
	oldPlugin();
	const bodiesBefore = bodyRequests;
	const redraw = await runSync(plugin, account);
	const redrawn = files.get(e64().md)!;
	expect('#64 redraw: an older note gets its pasted text', redraw.redrawn.length === 1 && redrawn.includes('> [!quote] Pasted text\n> Short pasted line one') && redrawn.includes(`[[${sixFile}|six.txt]] (6 lines)`), JSON.stringify(redraw.redrawn));
	expect('#64 redraw: nothing is asked of claude.ai', bodyRequests === bodiesBefore);
	expect('#64 redraw: "unread" keeps your value', redrawn.includes('unread: false'));
	expect('#64 redraw: the log names the note', (files.get('log.md') ?? '').includes('1 older notes redrawn with their pasted text: [[Vault plan (mine)]]'));
	expect('#64 redraw: only once', e64().pastes === 1 && (await runSync(plugin, account)).redrawn.length === 0 && files.get(e64().md) === redrawn);
	oldPlugin();
	files.set(e64().md, files.get(e64().md)! + '\nMy own line\n');
	const edited = await runSync(plugin, account);
	const copy = [...files.keys()].find((k) => k.includes('(my edits') && files.get(k)!.includes('My own line'));
	expect('#64 redraw: a note you edited is copied first (default setting)', !!copy && files.get(copy)!.includes('My own line') && files.get(e64().md)!.includes('> [!quote] Pasted text') && edited.edits.copies.length === 1, JSON.stringify({ copy, copies: edited.edits.copies, own: !!copy && files.get(copy)!.includes('My own line'), quote: files.get(e64().md)!.includes('> [!quote] Pasted text') }));
	if (copy) files.delete(copy);

	// Setting "Long pasted text" = all of it in the note: no file, the whole text open in the note.
	// Changing the setting clears the marks (as the settings dropdown does), so notes are redrawn once.
	account.web.pastedText = 'note';
	for (const entry of Object.values(account.web.index)) delete entry.pastes;
	const savedBefore = Object.keys(account.web.fileIndex).filter((k) => k.startsWith('pasted:')).length;
	const toNote = await runSync(plugin, account);
	const whole = files.get(e64().md)!;
	expect('#64 setting "note": the whole long paste is open in the note, no link', toNote.redrawn.length === 1 && whole.includes('> [!quote] Pasted text (80 lines)\n> Long paste line 1\n') && whole.includes('> Long paste line 80') && whole.includes('> [!quote] six.txt (6 lines)') && !whole.includes(`[[${pFile}|`), JSON.stringify({ r: toNote.redrawn, long: whole.includes('> [!quote] Pasted text (80 lines)\n> Long paste line 1\n'), all: whole.includes('> Long paste line 80'), six: whole.includes('> [!quote] six.txt (6 lines)'), link: whole.includes(`[[${pFile}|`) }));
	expect('#64 setting "note": no paste files saved', toNote.filesSaved === 0 && Object.keys(account.web.fileIndex).filter((k) => k.startsWith('pasted:')).length === savedBefore);
	updated = '2026-11-11T15:30:00Z';
	turns = [...turns, 'Question in note mode'];
	await runSync(plugin, account);
	expect('#64 setting "note": a chat that continues keeps it in the note', files.get(e64().md)!.includes('> Long paste line 80') && files.get(e64().md)!.includes('Question in note mode'));
	delete account.web.pastedText;
	for (const entry of Object.values(account.web.index)) delete entry.pastes;
	const toFile = await runSync(plugin, account);
	expect('#64 setting back to "file": the note shows the link and preview again', toFile.redrawn.length === 1 && files.get(e64().md)!.includes(`[[${account.web.fileIndex[LONG_KEY]}|Pasted text]] (80 lines)`) && !files.get(e64().md)!.includes('> Long paste line 80'));
	pastes = [];
	updated = '2026-11-11T16:00:00Z';
	turns = [...turns, 'Twelfth question'];
	await runSync(plugin, account);
	delete e64().pastes;
	const plainNote = files.get(e64().md)!;
	const noPaste = await runSync(plugin, account);
	expect('#64 redraw: a chat without pasted text is only marked, its note untouched', noPaste.redrawn.length === 0 && e64().pastes === 1 && files.get(e64().md) === plainNote, JSON.stringify({ r: noPaste.redrawn, m: e64().pastes, same: files.get(e64().md) === plainNote, stopped: noPaste.stopped }));
	testHooks.requestUrl = null;
	expect('#46: the sync is not stopped and the chat is saved', !blocked.stopped && blocked.changedCount === 1 && files.get(account.web.index[CHAT]!.md)!.includes('Fourth question'), JSON.stringify({ stopped: blocked.stopped, changed: blocked.changedCount }));
	expect('#46: reported once as not offered, not as "will retry" per chat', blocked.viewUnavailable === true && blocked.viewNotRead.length === 0 && (files.get('log.md') ?? '').includes('claude.ai does not offer them for this account'), JSON.stringify(blocked.viewNotRead));

	Reflect.deleteProperty(vault.adapter, 'stat');
	expect('quick: a vault that cannot tell file times always reads it', (await rawReads()).read === 1 && (await rawReads()).read === 1);

	// One chat in an odd shape is skipped, named in the log and tried again; it never stops the sync alone.
	{
		const noteBefore = files.get(account.web.index[CHAT]!.md)!;
		testHooks.requestUrl = async () => ({ status: 404, headers: { 'content-type': 'application/json' }, text: '{}', arrayBuffer: new ArrayBuffer(0) });
		updated = '2026-11-20T08:00:00Z';
		oddShape = true;
		const skipped = await runSync(plugin, account);
		expect('odd chat: skipped and named, the sync is not stopped, its note is untouched', !skipped.stopped && skipped.oddChats.join() === 'Plan the vault' && skipped.changedCount === 0 && files.get(account.web.index[CHAT]!.md) === noteBefore, skipped.stopped ?? JSON.stringify(skipped.oddChats));
		expect('odd chat: the log says it could not be read and will be retried', files.get('log.md')!.includes('could not read (will retry): Plan the vault'));
		oddShape = false;
		const again = await runSync(plugin, account);
		expect('odd chat: tried again on the next run and saved', !again.stopped && again.changedCount === 1 && !again.oddChats.length, again.stopped ?? '');
		testHooks.requestUrl = null;
		const odd = new OddChats();
		const shape = new ShapeError('x');
		expect('odd chat: two are skipped, the third stops; other errors are never skipped', odd.skip(shape, 'a') && odd.skip(shape, 'b') && !odd.skip(shape, 'c') && !new OddChats().skip(new Error('y'), 'd') && odd.names.join() === 'a,b');
		const got = await readOrSkip(new OddChats(), 'n', () => { throw shape; });
		const thrown = await readOrSkip(odd, 'n', () => { throw shape; }).then(() => 'no', () => 'thrown');
		expect('odd chat: the shared reader gives nothing for a skipped chat and throws once the limit is reached', got === null && thrown === 'thrown' && (await readOrSkip(odd, 'ok', () => 5)) === 5);
	}

	// Starred on claude.ai: a property of the note, kept up to date from the chat list.
	{
		testHooks.requestUrl = async () => ({ status: 404, headers: { 'content-type': 'application/json' }, text: '{}', arrayBuffer: new ArrayBuffer(0) });
		const path = account.web.index[CHAT]!.md;
		const props = () => files.get(path)!.split('---')[1]!;
		updated = '2026-11-21T08:00:00Z';
		star = true;
		const starred = await runSync(plugin, account);
		expect('starred: a starred chat says so in its properties, before the model', !starred.stopped && props().includes('\nstarred: true\nmodel: "claude-opus-5-5"\n'), starred.stopped ?? props());
		const bodyBefore = files.get(path)!.split('---').slice(2).join('---');
		star = false;
		bodyRequests = 0;
		const unstarred = await runSync(plugin, account);
		expect('starred: an unstar seen in the chat list takes the property out, without fetching the chat', !unstarred.stopped && unstarred.flagChanges === 1 && bodyRequests === 0 && !props().includes('starred') && files.get(path)!.split('---').slice(2).join('---') === bodyBefore, `${unstarred.stopped ?? ''} ${unstarred.flagChanges} ${bodyRequests}`);
		star = true;
		const again = await runSync(plugin, account);
		expect('starred: a new star is written the same way', again.flagChanges === 1 && props().includes('\nstarred: true\n'));
		updated = '2026-11-22T08:00:00Z';
		star = false;
		const changed = await runSync(plugin, account);
		expect('starred: a chat that changed and lost its star does not keep the old property', !changed.stopped && changed.changedCount === 1 && !props().includes('starred'), props());
		star = undefined;
		const silent = await runSync(plugin, account);
		expect('starred: a chat list that does not say is never compared', silent.flagChanges === 0);
		testHooks.requestUrl = null;
	}

	// Quick list: once a full read has shown that claude.ai lists newest change first, a sync
	// reads only the pages that hold something new; the rest of the list is remembered.
	{
		const quick = addAccount(settings, 'claude', 'Quick') as typeof account;
		Object.assign(quick.web, { orgId: ORG, secretId: 'key', chatFolder: 'AI/Claude/Quick', downloadFiles: false, cloudSessions: false });
		const id = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
		const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
		// 70 chats, newest change first: three pages of 30, 30 and 10.
		big = Array.from({ length: 70 }, (_, i) => ({ uuid: id(70 - i), name: `Quick ${70 - i}`, created_at: day(70 - i), updated_at: day(70 - i), project: null }));
		const pages = async (progress?: (text: string) => void) => {
			listed.length = 0;
			const r = await runSync(plugin, quick, progress);
			return { r, pages: listed.length };
		};
		const first = await pages();
		const catalog = () => quick.web.listCatalog as ListCatalog;
		expect('quick list: the first sync reads the whole list and remembers it', !first.r.stopped && first.pages === 3 && first.r.newCount === 70 && first.r.quickList === false && catalog().ordered && catalog().rows.length === 70, `${first.pages} pages, ${first.r.newCount} new, ${first.r.stopped ?? ''}`);
		const second = await pages();
		expect('quick list: nothing new, so one page is read and every chat still counts', !second.r.stopped && second.pages === 1 && second.r.quickList === true && second.r.listed === 70 && second.r.unchanged === 70, `${second.pages} pages, ${second.r.listed} listed`);

		// An old chat (on the third page) continues: claude.ai moves it to the top.
		const old = big.splice(64, 1)[0]!;
		big.unshift({ ...old, updated_at: day(80) });
		const third = await pages();
		expect('quick list: an old chat that continues is found on the first page; reading stops at the next page', !third.r.stopped && third.pages === 2 && third.r.changedCount === 1 && third.r.unchanged === 69 && third.r.listed === 70 && quick.web.index[old.uuid]!.updated_at === day(80), `${third.pages} pages, ${third.r.changedCount} changed`);
		big.unshift({ uuid: id(71), name: 'Quick 71', created_at: day(81), updated_at: day(81), project: null });
		const fourth = await pages();
		expect('quick list: a new chat is saved, the list is one longer', fourth.pages === 2 && fourth.r.newCount === 1 && fourth.r.listed === 71 && catalog().rows.length === 71 && catalog().rows[0]!.item.uuid === id(71), `${fourth.pages} pages, ${fourth.r.listed} listed`);

		// A deleted note of an old chat comes back: the whole list is read for that.
		const goneNote = quick.web.index[id(1)]!.md;
		files.delete(goneNote);
		const fifth = await pages();
		expect('quick list: a deleted note means a full read, and the note is restored', fifth.pages === 3 && fifth.r.quickList === false && fifth.r.restored.length === 1 && files.has(goneNote), `${fifth.pages} pages, ${fifth.r.restored.length} restored`);

		// Once a week the whole list is read: a chat deleted on claude.ai leaves the remembered list.
		big = big.filter((r) => r.uuid !== id(2));
		const sixth = await pages();
		expect('quick list: within the week a chat deleted on claude.ai is still remembered', sixth.pages === 1 && sixth.r.listed === 71);
		catalog().fullAt = Date.now() - FULL_LIST_EVERY - 1000;
		const weekly = await pages();
		expect('quick list: after a week the whole list is read again', weekly.pages === 3 && weekly.r.listed === 70 && catalog().rows.length === 70 && Date.now() - catalog().fullAt < 60_000, `${weekly.pages} pages, ${weekly.r.listed} listed`);

		// A run that fails: the next one reads everything.
		const failed = await pages((text) => { if (text.includes('checking older chats')) throw new StopError('boom'); });
		expect('quick list: a failed run is remembered', failed.r.stopped === 'boom' && catalog().stale === true);
		const after = await pages();
		expect('quick list: after a failed run the whole list is read', after.pages === 3 && !after.r.stopped && catalog().stale === undefined);

		// A 429 is a pause, not a failure: the remembered list stays good.
		limited = true;
		const paused = await pages();
		limited = false;
		quick.web.cooldownUntil = undefined;
		quick.web.resumeAfter429 = undefined;
		expect('quick list: a rate-limit pause does not force a full read', paused.r.resumeAt !== undefined && catalog().stale === undefined && (await pages()).pages === 1);

		// Also reading archived chats is another list: read in full once.
		quick.web.includeArchived = true;
		const scoped = await pages();
		expect('quick list: a changed scope means a full read', scoped.pages === 4 && catalog().scope === 'active+archived', `${scoped.pages} pages`);
		quick.web.includeArchived = false;
		await pages();

		// A list that is not newest change first is never cut short.
		const swap = big[40]!;
		big[40] = big[41]!;
		big[41] = swap;
		catalog().fullAt = 0;
		const unordered = await pages();
		const still = await pages();
		expect('quick list: a list in another order is read in full every time', unordered.pages === 3 && !catalog().ordered && still.pages === 3 && still.r.quickList === false, `${unordered.pages} and ${still.pages} pages`);
		expect('quick list: the remembered list keeps only what the sync uses', Object.keys(catalog().rows[0]!.item).sort().join() === 'created_at,name,project,updated_at,uuid');
		big = null;

		// The rules by themselves.
		const row = (n: number, at: number) => ({ uuid: id(n), name: `c${n}`, created_at: day(1), updated_at: day(at) });
		const cat: ListCatalog = { scope: 'active', fullAt: 1000, ordered: true, rows: [{ item: row(2, 5), archived: false }, { item: row(1, 4), archived: false }] };
		expect('quick list rules: when the whole list is needed', needsFullList(undefined, 'active', 2000) && !needsFullList(cat, 'active', 2000) && needsFullList(cat, 'active+archived', 2000) && needsFullList({ ...cat, ordered: false }, 'active', 2000) && needsFullList({ ...cat, stale: true }, 'active', 2000) && needsFullList(cat, 'active', 1000 + FULL_LIST_EVERY) && needsFullList(cat, 'active', 500));
		const cutRead = new ListRead(cat, 'active', 2000, false);
		expect('quick list rules: a page of known rows stops the read, an empty one does not', !new ListRead(cat, 'active', 2000, false).page([], false) && cutRead.page([row(2, 5)], false) && cutRead.done().rows.length === 2 && cutRead.done().catalog.fullAt === 1000 && !cutRead.done().changed);
		const moved = new ListRead(cat, 'active', 2000, false);
		expect('quick list rules: a row that changed, is new, or sits in the other list does not stop it', !moved.page([row(2, 6)], false) && !new ListRead(cat, 'active', 2000, false).page([row(3, 9)], false) && !new ListRead(cat, 'active', 2000, false).page([row(2, 5)], true) && !new ListRead(cat, 'active', 2000, true).page([row(2, 5)], false));
		const both = new ListRead(undefined, 'active+archived', 2000, true);
		both.page([row(2, 5)], false);
		both.page([row(2, 5)], true);
		expect('quick list rules: a chat in both lists is kept once and marked so', both.done().rows.length === 1 && both.done().rows[0]!.archived === null && both.done().catalog.ordered);
		const wrong = new ListRead(cat, 'active', 2000, false);
		expect('quick list rules: rows out of order end the trust', !wrong.page([row(1, 4), row(2, 5)], false) && !wrong.done().catalog.ordered && wrong.done().changed);
	}

	// A 429 pauses this one account: the run waits (not an error), nothing is asked while the
	// pause lasts, and a run that gets through ends it.
	{
		const web = account.web;
		limited = true;
		const hit = await runSync(plugin, account);
		expect('429: the run waits, with the time the retry comes, and is not an error', typeof hit.resumeAt === 'number' && hit.resumeAt === web.cooldownUntil && web.resumeAfter429?.consecutive === 1 && (hit.stopped ?? '').startsWith('claude.ai answered 429') && (hit.stopped ?? '').endsWith('Automatic retry scheduled.'), hit.stopped);
		expect('429: the first pause is at least 30 seconds', web.cooldownUntil! - Date.now() > 29_000 && web.cooldownUntil! - Date.now() <= 30_000);
		requests = 0;
		const held = await runSync(plugin, account);
		expect('429: while the pause lasts nothing is asked of claude.ai', requests === 0 && held.resumeAt === web.cooldownUntil && (held.stopped ?? '').startsWith('claude.ai is cooling down until'), `${requests} ${held.stopped}`);
		web.cooldownUntil = Date.now() - 1;
		const again = await runSync(plugin, account);
		expect('429: a second one in a row waits longer', again.resumeAt !== undefined && web.resumeAfter429?.consecutive === 2 && web.cooldownUntil! - Date.now() > 59_000, String(web.cooldownUntil! - Date.now()));
		limited = false;
		web.cooldownUntil = Date.now() - 1;
		testHooks.requestUrl = async () => ({ status: 404, headers: { 'content-type': 'application/json' }, text: '{}', arrayBuffer: new ArrayBuffer(0) });
		const through = await runSync(plugin, account);
		testHooks.requestUrl = null;
		expect('429: a run that gets through ends the pause', !through.stopped && through.resumeAt === undefined && web.cooldownUntil === undefined && web.resumeAfter429 === undefined, through.stopped ?? '');

		// The shared rules, used the same way by Gemini, AI Studio and Lumo.
		const c: Cooling = {};
		const r: { stopped?: string; resumeAt?: number } = {};
		expect('pause rules: not paused, nothing held', !heldByCooldown(c, 'Lumo', r, 1000) && r.resumeAt === undefined && coolingUntil(c, 1000) === 0);
		expect('pause rules: only a 429 starts a pause', !pausedBy(new StopError('x'), c, r, 1000) && pausedBy(new RateLimitError('Lumo', 5000), c, r, 1000) && c.cooldownUntil === 31_000 && r.resumeAt === 31_000 && c.resumeAfter429?.consecutive === 1, JSON.stringify(c));
		const r2: { stopped?: string; resumeAt?: number } = {};
		expect('pause rules: a paused account is held and says until when', heldByCooldown(c, 'Lumo', r2, 2000) && r2.resumeAt === 31_000 && (r2.stopped ?? '').startsWith('Lumo is cooling down until'));
		expect('pause rules: a waiting run does not end the pause, a finished one does', !endCooldown(c, r2) && endCooldown(c, {}) && c.cooldownUntil === undefined && !endCooldown(c, {}));
		const adopted: Cooling = { cooldownUntil: 9000 };
		expect('pause rules: a pause without a waiting retry gets one; a canceled retry stays canceled', stillCooling(adopted, 1000) === 9000 && adopted.resumeAfter429?.consecutive === 1 && stillCooling({ cooldownUntil: 9000, resumeAfter429: null }, 1000) === 9000);
		expect('pause rules: the server\'s wait is respected when it is longer', startCooldown({}, 600_000, 0) === 600_000 && retryDeadline('120', 1000) === 121_000 && retryDeadline('', 1000) === 601_000 && clearCooldown({ resumeAfter429: null }));
		expect('pause rules: the countdown reads mm:ss', countdown(65_000, 0) === '01:05' && countdown(0, 5000) === '00:00');
	}

	// A request that gets no answer at all is tried again, up to 3 times (as ChatGPT since 0.41.3).
	const waited: number[] = [];
	netRetry.pause = async (ms) => void waited.push(ms);
	let sends = 0;
	testHooks.requestUrl = async () => {
		if (++sends < 3) throw new Error('net::ERR_SSL_BAD_RECORD_MAC_ALERT');
		return { status: 200, headers: { 'content-type': 'application/octet-stream' }, text: 'ok', arrayBuffer: new TextEncoder().encode('ok').buffer };
	};
	const third = await new ClaudeApi(ORG, () => 'k').getOutputFile(CHAT, '/mnt/user-data/outputs/a.md');
	expect('retry: a broken connection is tried again, the third try answers', third.status === 200 && sends === 3 && waited.join() === '2000,5000', `${sends} sends, waits ${waited.join()}`);
	sends = 0;
	testHooks.requestUrl = async () => { sends++; throw new Error('net::ERR_CONNECTION_RESET k'); };
	const gaveUp = await new ClaudeApi(ORG, () => 'k').getOutputFile(CHAT, '/mnt/user-data/outputs/a.md').then(() => 'no stop', (e: unknown) => (e instanceof StopError ? e.message : `other: ${String(e)}`));
	expect('retry: three failed tries stop the sync and say so', sends === 3 && gaveUp.startsWith('Network error: ') && gaveUp.endsWith('(tried 3 times)'), gaveUp);
	testHooks.requestUrl = null;
	let runs = 0;
	const once = await sendWithRetry(async () => { runs++; return 'fine'; });
	expect('retry: a request that answers is sent once', once === 'fine' && runs === 1);
	const failure = await sendWithRetry(async () => { throw new Error('x'); }).then(() => null, (e: unknown) => e);
	expect('retry: giving up names the tries and keeps the cause', failure instanceof NetworkFailure && failure.tries === 3 && (failure.cause as Error).message === 'x' && triedText(1) === '' && triedText(3) === ' (tried 3 times)');

	console.log(failures ? `\n${failures} FAILED` : '\nAll Claude sync tests passed.');
	process.exit(failures ? 1 : 0);
})().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
