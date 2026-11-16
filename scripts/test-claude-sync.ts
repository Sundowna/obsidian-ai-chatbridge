// Offline test of one claude.ai sync on an in-memory vault: a chat that continues stays one note,
// and the version before is kept as raw JSON. No network: ClaudeApi.get answers from fixtures.
// Run: npm run test:claude

import { TFile } from 'obsidian';
import { ClaudeApi } from '../src/api';
import { normalizeSettings } from '../src/migrate';
import { localStamp } from '../src/naming';
import { runSync } from '../src/sync';
import { readWrite } from './fake-vault';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const PROJECT = { name: '2nd Brain', uuid: '33333333-3333-4333-8333-333333333333' };

const files = new Map<string, string>();
const folders = new Set<string>();
const vault = {
	getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : folders.has(p) ? {} : null),
	createFolder: async (p: string) => void folders.add(p),
	create: async (p: string, d: string) => {
		if (files.has(p)) throw new Error('exists ' + p);
		files.set(p, d);
	},
	process: async (f: { path: string }, fn: (d: string) => string) => void files.set(f.path, fn(files.get(f.path) ?? '')),
	adapter: { read: async (p: string) => files.get(p) ?? '' },
	...readWrite(files),
};

const settings = normalizeSettings({ maxChatsPerRun: 0, logPath: 'log.md' }).settings;
const account = settings.claude[0]!;
Object.assign(account.web, { orgId: ORG, secretId: 'key', chatFolder: 'AI/Claude/Chat', downloadFiles: false, cloudSessions: false });
const plugin = {
	app: { vault, fileManager: { processFrontMatter: async () => undefined }, secretStorage: { getSecret: () => 'sk-test' } },
	settings,
	saveSettings: async () => undefined,
} as never;

let updated = '2026-11-06T10:00:00Z';
let project: typeof PROJECT | null = PROJECT;
let turns = ['First question', 'First answer'];
const chat = () => ({
	uuid: CHAT, name: 'Plan the vault', created_at: '2026-11-06T09:00:00Z', updated_at: updated,
	chat_messages: turns.map((text, i) => ({ uuid: `m${i}`, sender: i % 2 ? 'assistant' : 'human', text, content: [{ type: 'text', text }], created_at: '2026-11-06T09:00:00Z' })),
});
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer;
ClaudeApi.prototype.get = async function (path: string) {
	const json = path.includes('chat_conversations_v2')
		? { data: [{ uuid: CHAT, name: 'Plan the vault', created_at: '2026-11-06T09:00:00Z', updated_at: updated, project }], has_more: false }
		: chat();
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

	console.log(failures ? `\n${failures} FAILED` : '\nAll Claude sync tests passed.');
	process.exit(failures ? 1 : 0);
})().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
