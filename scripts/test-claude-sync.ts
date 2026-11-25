// Offline test of one claude.ai sync on an in-memory vault: a chat that continues stays one note,
// and the version before is kept as raw JSON. No network: ClaudeApi.get answers from fixtures.
// Run: npm run test:claude

import { TFile } from 'obsidian';
import { ClaudeApi } from '../src/api';
import { normalizeSettings } from '../src/migrate';
import { localStamp } from '../src/naming';
import { runSync } from '../src/sync';
import { followRename } from '../src/follow';
import { readWrite } from './fake-vault';

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
	getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : folders.has(p) ? {} : null),
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
	} as { read: (p: string) => Promise<string>; stat?: unknown },
	...readWrite(files),
};

const settings = normalizeSettings({ maxChatsPerRun: 0, logPath: 'log.md' }).settings;
const account = settings.claude[0]!;
Object.assign(account.web, { orgId: ORG, secretId: 'key', chatFolder: 'AI/Claude/Chat', downloadFiles: false, cloudSessions: false });
const plugin = {
	manifest: { dir: PLUGIN_DIR, version: 'test' },
	app: { vault, fileManager: { processFrontMatter: async () => undefined }, secretStorage: { getSecret: () => 'sk-test' } },
	settings,
	saveSettings: async () => undefined,
} as never;

let updated = '2026-11-06T10:00:00Z';
let project: typeof PROJECT | null = PROJECT;
let turns = ['First question', 'First answer'];
const FILE = '55555555-5555-4555-8555-555555555555';
let attach = false;
const chat = () => ({
	uuid: CHAT, name: 'Plan the vault', created_at: '2026-11-06T09:00:00Z', updated_at: updated,
	chat_messages: turns.map((text, i) => ({ uuid: `m${i}`, sender: i % 2 ? 'assistant' : 'human', text, content: [{ type: 'text', text }], created_at: '2026-11-06T09:00:00Z',
		...(attach && i === 0 ? { attachments: [{ file_uuid: FILE, file_name: 'notes.txt', size_bytes: 5 }] } : {}) })),
});
let fileFetches = 0;
ClaudeApi.prototype.getFile = async () => { fileFetches++; return new TextEncoder().encode('notes').buffer; };
ClaudeApi.prototype.readConversation = async () => ({});
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer;
// An archived chat: only in claude.ai's archived list (with the first chat again, to check it is kept once).
const ARCHIVED = '44444444-4444-4444-8444-444444444444';
const archivedChat = {
	uuid: ARCHIVED, name: 'Old garden plan', created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T10:00:00Z',
	chat_messages: [{ uuid: 'a0', sender: 'human', text: 'Archived question', content: [{ type: 'text', text: 'Archived question' }], created_at: '2026-10-01T09:00:00Z' }],
};
const listed: string[] = [];
ClaudeApi.prototype.get = async function (path: string) {
	const current = { uuid: CHAT, name: 'Plan the vault', created_at: '2026-11-06T09:00:00Z', updated_at: updated, project };
	if (path.includes('chat_conversations_v2')) listed.push(path);
	const json = path.includes('chat_conversations_v2')
		? path.includes('archived=true')
			? { data: [{ uuid: ARCHIVED, name: archivedChat.name, created_at: archivedChat.created_at, updated_at: archivedChat.updated_at, project: null }, current], has_more: false }
			: { data: [current], has_more: false }
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

	delete vault.adapter.stat;
	expect('quick: a vault that cannot tell file times always reads it', (await rawReads()).read === 1 && (await rawReads()).read === 1);

	console.log(failures ? `\n${failures} FAILED` : '\nAll Claude sync tests passed.');
	process.exit(failures ? 1 : 0);
})().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
