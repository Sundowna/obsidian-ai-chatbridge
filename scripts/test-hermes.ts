// Hermes test: builds a small synthetic state.db (WAL mode, with messages that exist only in the
// -wal file), then checks both SQLite readers, the parser, the transcript and a full sync on a
// fake vault. Never touches a real Hermes database. Run: npm run test:hermes
// Optional: HERMES_PYTHON=<python.exe> to test the Python reader with that interpreter.

import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TFile } from 'obsidian';
import { normalizeSettings } from '../src/migrate';
import { buildSession, columns, messageText, messagesSql, sessionsSql, toMessageRow, toSessionRow } from '../src/hermes/parse';
import { addFoundProfiles, dedupeLabels, findProfiles, hermesRoots, newProfile, profileGone, profileId, refreshProfiles, refreshSummary, removeProfile } from '../src/hermes/profiles';
import { findPython, isPrivatePath, nodeSqliteBackend, pythonBackend, pythonCandidates, type SqliteBackend } from '../src/hermes/reader';
import { prettyResult, renderHermesTranscript } from '../src/hermes/render';
import { runHermesSync } from '../src/hermes/sync';
import { followRename } from '../src/follow';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- node:sqlite is only reachable through require here
const sqlite = require('node:sqlite') as {
	DatabaseSync: new (p: string, o?: Record<string, unknown>) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void };
};

const dir = mkdtempSync(join(tmpdir(), 'chatbridge-hermes-test-'));
const home = join(dir, 'hermes').replace(/\\/g, '/');
const profileDir = `${home}/profiles/tester`;
const dbPath = `${profileDir}/state.db`;
require('fs').mkdirSync(profileDir, { recursive: true });

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const t = (minutesAgo: number) => (NOW - minutesAgo * 60_000) / 1000;
const JSONP = '\u0000json:';

const writer = new sqlite.DatabaseSync(dbPath);
writer.exec(`
PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT, system_prompt TEXT,
  parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0,
  billing_provider TEXT, title TEXT, cwd TEXT, profile_name TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
  tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0,
  display_metadata TEXT, message_uid TEXT);
`);
const addSession = writer.prepare('INSERT INTO sessions (id, source, model, model_config, parent_session_id, started_at, billing_provider, title, cwd) VALUES (?,?,?,?,?,?,?,?,?)');
const addMsg = writer.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, display_metadata, message_uid, tool_call_id, tool_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const msg = (sid: string, role: string, content: string | null, ts: number, o: { tools?: string; active?: number; compacted?: number; meta?: string; uid?: string; callId?: string; toolName?: string } = {}) =>
	addMsg.run(sid, role, content, o.tools ?? null, ts, o.active ?? 1, o.compacted ?? 0, o.meta ?? null, o.uid ?? null, o.callId ?? null, o.toolName ?? null);

// 1: a normal CLI chat with a tool call.
addSession.run('s1-garden', 'cli', 'anthropic/claude-sonnet-4.6', null, null, t(300), 'anthropic', 'Plan the garden', 'D:/Projects/garden');
msg('s1-garden', 'system', 'You are Hermes.', t(300));
msg('s1-garden', 'user', 'Which vegetables grow in shade?', t(299));
msg('s1-garden', 'assistant', '', t(298), { tools: JSON.stringify([
	{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'shade vegetables' }) } },
	{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'D:/Notes/Private/plan.md' }) } },
	{ id: 'c3', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'D:/Projects/garden/big.txt' }) } },
]) });
msg('s1-garden', 'tool', '{"results": ["lettuce"]}', t(298), { callId: 'c1', toolName: 'web_search' });
msg('s1-garden', 'tool', 'secret plan text', t(298), { callId: 'c2', toolName: 'read_file' });
msg('s1-garden', 'tool', `~~~ fence inside
${'x'.repeat(5000)}`, t(298), { callId: 'c3', toolName: 'read_file' });
msg('s1-garden', 'assistant', 'Lettuce, spinach and chard do well.', t(297));
// 2: a local Qwen chat: multimodal content, compaction duplicates, an undone row, a model-only row.
addSession.run('s2-qwen', 'desktop', 'qwen3.5-9b', null, null, t(200), 'custom', null, null);
msg('s2-qwen', 'user', `${JSONP}${JSON.stringify([{ type: 'text', text: 'What is in this picture?' }, { type: 'image_url', image_url: { url: 'data:...' } }])}`, t(199), { uid: 'u1', compacted: 1, active: 0 });
msg('s2-qwen', 'assistant', 'A cat on a sofa.', t(198), { uid: 'u2', compacted: 1, active: 0 });
msg('s2-qwen', 'user', `${JSONP}${JSON.stringify([{ type: 'text', text: 'What is in this picture?' }, { type: 'image_url', image_url: { url: 'data:...' } }])}`, t(199), { uid: 'u1' });
msg('s2-qwen', 'assistant', 'A cat on a sofa.', t(198), { uid: 'u2' });
msg('s2-qwen', 'user', 'Undone question', t(197), { uid: 'u3', active: 0 });
msg('s2-qwen', 'user', '[memory injection]', t(196), { uid: 'u4', meta: JSON.stringify({ model_only: true }) });
msg('s2-qwen', 'user', 'What colour is the cat?', t(195), { uid: 'u5' });
msg('s2-qwen', 'assistant', 'Grey.', t(194), { uid: 'u6' });
// 3: a subagent helper run (skipped by default).
addSession.run('s3-sub', 'subagent', 'qwen3.5-9b', '{"_delegate_from":"s2-qwen"}', 's2-qwen', t(190), null, 'helper', null);
msg('s3-sub', 'user', 'helper task', t(190));
// 4: only an assistant message (no message from you).
addSession.run('s4-empty', 'cron', 'qwen3.5-9b', null, null, t(180), null, null, null);
msg('s4-empty', 'assistant', 'Good morning.', t(180));
// 5: ran inside a Private folder (never read into the vault).
addSession.run('s5-private', 'cli', 'qwen3.5-9b', null, null, t(170), null, 'secret', 'D:/Notes/Private/taxes');
msg('s5-private', 'user', 'private question', t(170));
// 6: still being written.
addSession.run('s6-active', 'cli', 'gpt-5.5', null, null, t(5), 'openai', 'Live chat', null);
msg('s6-active', 'user', 'hello', t(2));

const fileHash = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing');
const walBytes = () => (existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`).length : 0);

async function readAll(b: SqliteBackend) {
	const db = await b.snapshot(dbPath);
	try {
		const sCols = await columns(db, 'sessions');
		const mCols = await columns(db, 'messages');
		const rows = (await db.query(sessionsSql(sCols))).map(toSessionRow);
		const ids = rows.map((r) => r.id);
		const msgs = (await db.query(messagesSql(mCols, ids.length), ids)).map(toMessageRow);
		return { rows, msgs };
	} finally {
		await db.close();
	}
}

async function checkBackend(b: SqliteBackend) {
	const before = [fileHash(dbPath), fileHash(`${dbPath}-wal`)];
	const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('ai-chatbridge-hermes-')).length;
	const { rows, msgs } = await readAll(b);
	expect(`${b.name}: all 6 sessions read`, rows.length === 6, String(rows.length));
	expect(`${b.name}: undone row left out, archived + live rows read`, !msgs.some((m) => m.content === 'Undone question') && msgs.filter((m) => m.sessionId === 's2-qwen').length === 7);
	const s1 = rows.find((r) => r.id === 's1-garden')!;
	expect(`${b.name}: model, provider, cwd`, s1.model === 'anthropic/claude-sonnet-4.6' && s1.provider === 'anthropic' && s1.cwd === 'D:/Projects/garden');
	expect(`${b.name}: subagent recognised`, rows.find((r) => r.id === 's3-sub')!.isSubagent);
	expect(`${b.name}: source files unchanged (state.db and -wal)`, fileHash(dbPath) === before[0] && fileHash(`${dbPath}-wal`) === before[1]);
	const tmpAfter = readdirSync(tmpdir()).filter((n) => n.startsWith('ai-chatbridge-hermes-')).length;
	expect(`${b.name}: temp snapshot deleted`, tmpAfter <= tmpBefore, `${tmpBefore} -> ${tmpAfter}`);
	expect(`${b.name}: no -journal or new files next to state.db`, readdirSync(profileDir).every((n) => /^state\.db(-wal|-shm)?$/.test(n)), readdirSync(profileDir).join(','));
}

function fakeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const vault = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? Object.assign(new TFile(p, { size: 0 }), { path: p }) : folders.has(p) ? {} : null),
		createFolder: async (p: string) => void folders.add(p),
		create: async (p: string, d: string) => {
			if (files.has(p)) throw new Error('exists');
			files.set(p, d);
		},
		process: async (f: { path: string }, fn: (d: string) => string) => void files.set(f.path, fn(files.get(f.path) ?? '')),
	};
	return { files, vault };
}

async function main() {
	// The whole DB is still in the -wal file: nothing was checkpointed.
	expect('fixture: messages sit in the -wal file', walBytes() > 0, `${walBytes()} bytes`);

	// ---- Pure parts ----
	expect('messageText: multimodal parts', messageText(`${JSONP}[{"type":"text","text":"Hi"},{"type":"image_url"}]`) === 'Hi\n\n*(image)*');
	expect('messageText: plain', messageText('  plain  ') === 'plain');
	expect('isPrivatePath', isPrivatePath('D:\\Notes\\Private\\x') && !isPrivatePath('D:/Notes/PrivateNot/x'));
	expect('hermesRoots: profile HERMES_HOME -> root', hermesRoots({ HERMES_HOME: 'D:\\AI\\Hermes\\profiles\\coder' }, 'C:/Users/me', 'win32')[0] === 'D:/AI/Hermes');
	expect('hermesRoots: defaults', hermesRoots({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:/Users/me', 'win32').join('|') === 'C:/Users/me/AppData/Local/hermes|C:/Users/me/.hermes');

	// ---- Reader 1: node:sqlite ----
	const node = nodeSqliteBackend();
	expect('node:sqlite reader available in this Node', !!node);
	if (node) await checkBackend(node);

	// ---- Reader 2: Python ----
	const req = require as unknown as (m: string) => unknown;
	const candidates = pythonCandidates(req, process.env.HERMES_PYTHON ?? '', [profileDir]);
	const python = await findPython(req, candidates);
	if (python) {
		console.log(`      (Python: ${python})`);
		await checkBackend(pythonBackend(python, req)!);
	} else console.log('SKIP  Python reader: no Python found (set HERMES_PYTHON)');

	// ---- Parser and transcript ----
	const { rows, msgs } = await readAll(node!);
	const of = (id: string) => buildSession(rows.find((r) => r.id === id)!, msgs.filter((m) => m.sessionId === id), 'tester');
	const s1 = of('s1-garden')!;
	const steps = s1.turns[1]!.parts[0] as { steps: { name: string; args: string; result?: string }[] };
	expect('s1: two turns, three tool steps then the answer', s1.turns.length === 2 && steps.steps.length === 3 && JSON.stringify(s1.turns[1]!.parts[1]) === JSON.stringify({ text: 'Lettuce, spinach and chard do well.' }), JSON.stringify(s1.turns).slice(0, 300));
	expect('s1: results matched to their calls', steps.steps[0]!.name === 'web_search' && steps.steps[0]!.result === '{"results": ["lettuce"]}' && steps.steps[1]!.result === 'secret plan text');
	const s2 = of('s2-qwen')!;
	const s2texts = s2.turns.flatMap((x) => x.parts.flatMap((p) => ('text' in p ? [p.text] : [])));
	expect('s2: compaction duplicates shown once, model-only row hidden', JSON.stringify(s2texts) === JSON.stringify(['What is in this picture?\n\n*(image)*', 'A cat on a sofa.', 'What colour is the cat?', 'Grey.']), JSON.stringify(s2texts));
	expect('s2: title from first message', s2.title === 'What is in this picture?');
	expect('s4: no message from you -> null', of('s4-empty') === null);
	const md = renderHermesTranscript(s1, dbPath);
	const fm = md.split('---')[1]!;
	expect('transcript: required front matter', ['source: hermes', 'hermes_profile: "tester"', 'session_id: "s1-garden"', 'model: "anthropic/claude-sonnet-4.6"'].every((l) => fm.includes(l)), fm);
	expect('transcript: dates are YYYY-MM-DD', /\ncreated: \d{4}-\d{2}-\d{2}\n/.test(fm) && /\nupdated: \d{4}-\d{2}-\d{2}\n/.test(fm));
	expect('transcript: tool steps in a collapsed callout', md.includes('> [!example]- 3 tool steps') && md.includes('> **1. web_search**') && md.includes('"query": "shade vegetables"') && md.includes('>  "results": [') && md.includes('>   "lettuce"'));
	expect('transcript: Private step keeps only its name', md.includes('> **2. read_file**\n> *(details not saved') && !md.includes('secret plan text') && !md.includes('Private/plan.md'));
	expect('transcript: long result shortened, fence longer than ~~~ inside', md.includes('more characters)') && md.includes('> ~~~~\n> ~~~ fence inside') && !md.includes('x'.repeat(1300)));
	const lines = md.split('\n');
	const callout = lines.slice(lines.findIndex((l) => l.startsWith('> [!example]')), lines.findIndex((l) => l.startsWith('Lettuce')));
	expect('transcript: every callout line starts with >', callout.filter((l) => l.trim()).every((l) => l.startsWith('>')), String(callout.length));
	const wrapped = prettyResult('{"content": "a\\nb", "truncated": false}');
	expect('prettyResult: unwraps {"content"} and keeps other fields', wrapped === 'a\nb\n\n{"truncated":false}', JSON.stringify(wrapped));
	expect('prettyResult: plain text and other JSON', prettyResult(' hi ') === 'hi' && prettyResult('[1,2]') === '[\n 1,\n 2\n]');
	expect('transcript: unread and headings', fm.includes('unread: true') && md.includes('\n## You · ') && md.includes('\n## Hermes · '));

	// ---- Full sync on a fake vault ----
	const { settings } = normalizeSettings({});
	settings.maxChatsPerRun = 0;
	settings.hermes.folder = '30 Sources/AI Chats/Hermes';
	const profile = newProfile('tester', profileDir);
	profile.enabled = true;
	settings.hermes.profiles = [profile];
	const { files, vault } = fakeVault();
	const plugin = { app: { vault, fileManager: { processFrontMatter: async () => undefined } }, settings, saveSettings: async () => undefined } as never;

	const r1 = await runHermesSync(plugin, undefined, undefined, node, NOW);
	expect('sync 1: two new, subagent/private skipped, empty and active counted', r1.newCount === 2 && r1.empty === 1 && r1.active === 1 && !r1.stopped, JSON.stringify({ ...r1, written: r1.written.length }));
	const notes = [...files.keys()].filter((p) => p.endsWith('.md') && !p.includes('log'));
	expect('sync 1: files in <folder>/<profile>/', notes.every((p) => p.startsWith('30 Sources/AI Chats/Hermes/tester/')), notes.join(', '));
	expect('sync 1: Private session not written', ![...files.values()].some((d) => d.includes('private question')));
	expect('sync 1: log line', [...files.entries()].some(([p, d]) => p.includes('log') && d.includes('**Hermes:** 2 new')));

	const r2 = await runHermesSync(plugin, undefined, undefined, node, NOW);
	expect('sync 2: nothing new (stable)', r2.newCount === 0 && r2.changedCount === 0 && r2.unchanged === 2, JSON.stringify({ ...r2, written: r2.written.length }));

	// A new message lands (still only in the -wal file): the session is saved again as "(updated …)".
	msg('s1-garden', 'user', 'And in full sun?', t(60));
	msg('s1-garden', 'assistant', 'Tomatoes.', t(59));
	const r3 = await runHermesSync(plugin, undefined, undefined, node, NOW);
	const updated = [...files.keys()].find((p) => p.includes('(updated '));
	expect('sync 3: changed session -> new "(updated …)" file, old one kept', r3.changedCount === 1 && !!updated && notes.every((p) => files.has(p)), updated ?? 'none');
	expect('sync 3: new turn is in it (read from -wal)', !!updated && files.get(updated)!.includes('Tomatoes.'));

	// Deleted from the vault -> restored under the same name.
	const gone = profile.index['s2-qwen']!.md;
	files.delete(gone);
	const r4 = await runHermesSync(plugin, undefined, undefined, node, NOW);
	expect('sync 4: deleted transcript restored under the same name', r4.restored.length === 1 && files.has(gone));

	// Moving a note in Obsidian moves the index with it.
	const moved = followRename(settings, '30 Sources/AI Chats/Hermes/tester', '30 Sources/AI Chats/Hermes/Tester 2');
	expect('rename followed for Hermes notes', moved >= 2 && profile.index['s2-qwen']!.md.startsWith('30 Sources/AI Chats/Hermes/Tester 2/'));

	// Fails gracefully: no reader, missing database, Private profile.
	const r5 = await runHermesSync(plugin, undefined, undefined, null, NOW);
	expect('no SQLite reader -> clear stop message', !!r5.stopped && /No way to read SQLite/.test(r5.stopped));
	// A profile whose state.db is gone is skipped; the other profiles still sync.
	const nope = Object.assign(newProfile('missing', `${home}/profiles/nope`), { enabled: true });
	settings.hermes.profiles = [nope, profile];
	const r6 = await runHermesSync(plugin, undefined, undefined, node, NOW);
	expect('missing state.db -> skipped, the other profile still syncs', !r6.stopped && r6.missing.join() === 'missing' && r6.listed > 0 && r6.newCount === 0, JSON.stringify({ ...r6, written: r6.written.length }));
	const r6b = await runHermesSync(plugin, undefined, nope.id, node, NOW);
	expect('syncing only a missing profile -> skipped, not stopped', !r6b.stopped && r6b.missing.join() === 'missing' && r6b.listed === 0, JSON.stringify(r6b));
	nope.enabled = false;
	const r6c = await runHermesSync(plugin, undefined, undefined, node, NOW);
	expect('missing profile turned off -> not reported', r6c.missing.length === 0 && !r6c.stopped);
	// Remove: off the list, and not a single vault file touched.
	const before = [...files.entries()].map(([p, d]) => `${p}:${d.length}`).join('|');
	expect('removeProfile: off the list', removeProfile(settings.hermes.profiles, nope) && settings.hermes.profiles.length === 1 && settings.hermes.profiles[0] === profile);
	expect('removeProfile: vault files untouched', [...files.entries()].map(([p, d]) => `${p}:${d.length}`).join('|') === before);
	expect('removeProfile: twice -> false', !removeProfile(settings.hermes.profiles, nope));
	settings.hermes.profiles = [Object.assign(newProfile('p', 'D:/x/Private/hermes'), { enabled: true })];
	const r7 = await runHermesSync(plugin, undefined, undefined, node, NOW);
	expect('Private profile refused', !!r7.stopped && /Private/.test(r7.stopped));
	const twins = [newProfile('default', 'D:/A/hermes'), newProfile('default', 'C:/B/hermes')];
	expect('dedupeLabels: second "default" becomes "default (2)"', dedupeLabels(twins) === 1 && twins[1]!.label === 'default (2)' && twins[0]!.label === 'default');
	const listed = [newProfile('default', 'D:/A/hermes')];
	addFoundProfiles(listed, [{ label: 'default', path: 'C:/B/hermes' }, { label: 'default', path: 'D:/A/hermes' }]);
	expect('addFoundProfiles: no duplicate paths or labels, added turned off', listed.length === 2 && listed[1]!.label === 'default (2)' && !listed[1]!.enabled);
	expect('migration: duplicate labels fixed on load', normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: {} }], hermes: { profiles: [newProfile('x', 'D:/1'), newProfile('x', 'D:/2')] } }).settings.hermes.profiles[1]!.label === 'x (2)');
	expect('profileId normalises', profileId('D:\\AI\\Hermes\\') === 'd:/ai/hermes');

	// ---- Finding profiles again (Refresh) on a fake folder tree ----
	const tree = ['R/state.db', 'R/profiles/a/state.db', 'R/profiles/.deleted-x/state.db', 'R/profiles/Private/state.db', 'R/profiles/empty/notes.txt', 'S/profiles/b/state.db'];
	const under = (p: string) => tree.filter((x) => x.startsWith(`${p}/`));
	const fakeFs = {
		existsSync: (p: string) => tree.includes(p) || under(p).length > 0,
		readdirSync: (p: string) => {
			const names = [...new Set(under(p).map((x) => x.slice(p.length + 1).split('/')[0]!))];
			if (!names.length) throw new Error('ENOENT');
			return names.map((name) => ({ name, isDirectory: () => under(`${p}/${name}`).length > 0 }));
		},
	};
	const foundNow = findProfiles(['R', 'S', 'R'], fakeFs);
	expect('findProfiles: home, profiles/, second root; deleted/Private/no state.db skipped; no duplicates', foundNow.map((f) => `${f.label}=${f.path}`).join('|') === 'default=R|a=R/profiles/a|b=S/profiles/b', JSON.stringify(foundNow));
	const saved = [newProfile('a', 'R/profiles/a'), newProfile('gone', 'R/profiles/gone'), newProfile('nodb', 'R/profiles/empty')];
	saved[1]!.enabled = true;
	expect('profileGone: folder vs database vs there', profileGone(saved[1]!, fakeFs) === 'folder' && profileGone(saved[2]!, fakeFs) === 'database' && profileGone(saved[0]!, fakeFs) === null);
	expect('profileGone: no fs (mobile) -> never gone', profileGone(saved[1]!, null) === null);
	const rf = refreshProfiles(saved, foundNow, fakeFs);
	expect('refreshProfiles: 2 new (turned off), 2 gone kept in the list', rf.added.map((p) => p.label).join() === 'default,b' && rf.added.every((p) => !p.enabled) && rf.missing.map((p) => p.label).join() === 'gone,nodb' && rf.present === 1 && saved.length === 5, JSON.stringify(rf.missing.map((p) => p.label)));
	expect('refreshProfiles: gone profile keeps its switch', saved[1]!.enabled);
	expect('refreshSummary: new and gone', refreshSummary(rf) === '2 new profiles found, 2 no longer exist', refreshSummary(rf));
	const rf2 = refreshProfiles(saved, foundNow, fakeFs);
	expect('refreshProfiles again: nothing added twice', rf2.added.length === 0 && saved.length === 5 && refreshSummary(rf2) === '2 no longer exist', refreshSummary(rf2));
	const one = refreshProfiles([newProfile('a', 'R/profiles/a')], [], fakeFs);
	expect('refreshSummary: one gone / no changes / none', refreshSummary({ added: [], missing: [saved[1]!], present: 0 }) === '1 no longer exists'
		&& refreshSummary(one) === 'No changes: the profile is still there'
		&& refreshSummary(refreshProfiles([], [], fakeFs)) === 'No Hermes profiles found', refreshSummary(one));
	expect('refreshSummary: all still there', refreshSummary({ added: [], missing: [], present: 3 }) === 'No changes: all 3 profiles are still there');

	// Settings from an older version get Hermes defaults.
	const old = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: { chatFolder: '30 Sources/AI Chats/Claude/Chat' } }] }).settings;
	expect('migration: Hermes folder next to the other providers', old.hermes.folder === '30 Sources/AI Chats/Hermes' && old.hermes.profiles.length === 0, old.hermes.folder);

	writer.close();
}

main()
	.catch((e) => {
		console.error(e);
		failures++;
	})
	.finally(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// temp folder
		}
		console.log(failures ? `\n${failures} FAILED` : '\nAll Hermes tests passed.');
		process.exit(failures ? 1 : 0);
	});
