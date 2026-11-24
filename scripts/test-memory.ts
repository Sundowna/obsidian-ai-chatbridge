// AI memory test: builds a made-up Codex home and Claude Code home in a temp folder (memory
// files in English, German and Afrikaans, a memory database, a Private folder), then checks
// the readers, the note and full sync runs on a fake vault. Never reads the real homes.
// Run: npm run test:memory

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TFile } from 'obsidian';
import type { DesktopFs } from '../src/desktop/scan';
import { nodeSqliteBackend } from '../src/hermes/reader';
import { instructionsText, parseSummaryStream, savedMemories, summaryText } from '../src/memory/chatgpt-web';
import { memoryPaths, shownPath } from '../src/memory/claude-web';
import { describeHits, redact } from '../src/memory/redact';
import { fenceFor, hashOfNote, renderBody, sha256 } from '../src/memory/render';
import { captureClaudeCode, captureCodex, rowText } from '../src/memory/sources';
import { runMemorySync } from '../src/memory/sync';
import { normalizeSettings } from '../src/migrate';
import { readWrite } from './fake-vault';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- node:sqlite is only reachable through require here
const sqlite = require('node:sqlite') as {
	DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void };
};

const dir = mkdtempSync(join(tmpdir(), 'chatbridge-memory-test-')).replace(/\\/g, '/');
const codex = `${dir}/codex-home`;
const claude = `${dir}/home/.claude`;
const put = (path: string, text: string) => {
	mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
	writeFileSync(path, text);
};

// The three languages, a secret-looking line and Markdown that would break a note if it were not fenced.
const SUMMARY = '# Memory summary\n\n- Der Nutzer schreibt auf Deutsch, English en Afrikaans.\n- Hy sê: "moenie my woorde regmaak nie".\n- Passwort: hunter2 (bleibt drin, es wird nichts gefiltert)\n';
const FENCED = '---\nname: tricky\n---\n\n## A heading of its own\n\n```js\nconsole.log("three backticks inside");\n```\n\n````\nfour\n````\nno newline at the end';

function seed(): void {
	put(`${codex}/AGENTS.md`, 'Antworte kurz.\n');
	put(`${codex}/memories/memory_summary.md`, SUMMARY);
	put(`${codex}/memories/MEMORY.md`, FENCED);
	put(`${codex}/memories/topics/boerdery.md`, 'Plaas naby Windhoek.\r\nTweede reël.\r\n');
	put(`${codex}/memories/Private/secret.md`, 'never read\n');
	put(`${codex}/memories/blob.bin`, 'a\u0000b');
	put(`${codex}/memories/empty.md`, '');
	put(`${codex}/sessions/x.jsonl`, '{}\n');
	const db = new sqlite.DatabaseSync(`${codex}/memories_1.sqlite`);
	db.exec('CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT, generated_at INTEGER NOT NULL, usage_count INTEGER, last_usage INTEGER, selected_for_phase2 INTEGER NOT NULL DEFAULT 0)');
	db.prepare('INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at, usage_count, last_usage) VALUES (?,?,?,?,?,?,?,?)')
		.run('thread-b', 1700000000, 'Line one\nLine two über Äpfel', 'Short summary', 'apples', 1700000100, 3, 1700000200);
	db.close();

	put(`${claude}/CLAUDE.md`, 'Global rules.\n');
	put(`${claude}/projects/D--Work-garden/memory/MEMORY.md`, '- [Beds](beds.md)\n');
	put(`${claude}/projects/D--Work-garden/memory/beds.md`, '---\nname: beds\n---\n\nDrei Beete.\n');
	put(`${claude}/projects/D--Work-garden/a-session.jsonl`, '{}\n');
	put(`${claude}/projects/D--Notes-Private-diary/memory/MEMORY.md`, 'never read\n');
	mkdirSync(`${claude}/projects/C--empty/memory`, { recursive: true });
}

function realFs(env: Record<string, string>): DesktopFs {
	return {
		home: `${dir}/home`,
		env: (n) => env[n],
		readDir: async (d) => (await readdir(d, { withFileTypes: true }).catch(() => [])).map((e) => ({ name: e.name, dir: e.isDirectory() })),
		stat: async (p) => stat(p).then((s) => (s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null)).catch(() => null),
		readText: async (p) => readFile(p, 'utf8').catch(() => null),
		readBytes: async (p) => readFile(p).then((b) => new Uint8Array(b)).catch(() => null),
	};
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
		...readWrite(files),
	};
	return { files, vault };
}

/** The text inside the code block under a heading, as a reader would get it back. */
function blockUnder(note: string, heading: string): string | null {
	const at = note.indexOf(`## ${heading}\n\n`);
	if (at < 0) return null;
	const rest = note.slice(at + heading.length + 5);
	const open = /^(`{3,})[a-z]*\n/.exec(rest);
	if (!open) return null;
	const end = rest.indexOf(`\n${open[1]}\n`, open[0].length - 1);
	return end < 0 ? null : rest.slice(open[0].length, end + 1);
}

async function main() {
	seed();
	const backend = nodeSqliteBackend();
	if (!backend) throw new Error('This Node has no node:sqlite with backup(); use Node 22.16 or newer.');
	const fs = realFs({ CODEX_HOME: codex });

	// ---- Pure pieces ----
	expect('fence is longer than any backtick run', fenceFor('a ``` b ```` c') === '`````' && fenceFor('plain') === '```');
	expect('row text: short values as lines, long text under its name, counters left out',
		rowText({ thread_id: 't', usage_count: 9, last_usage: 5, raw_memory: 'a\nb', n: 2, gone: null }) === 'thread_id: t\nn: 2\n\n--- raw_memory ---\na\nb');

	// ---- Privacy filter ----
	const R = '[REDACTED]';
	const same = (label: string, text: string) => expect(`filter leaves alone: ${label}`, redact(text).text === text && redact(text).total === 0, redact(text).text);
	const gone = (label: string, text: string, want: string, kinds: string) => {
		const r = redact(text);
		expect(`filter: ${label}`, r.text === want && describeHits(r.hits) === kinds, `${r.text} | ${describeHits(r.hits)}`);
	};
	gone('German password, rest of the line stays', 'Passwort: hunter2 (bleibt)', `Passwort: ${R} (bleibt)`, '1 password');
	gone('Afrikaans password in a sentence', 'Die wagwoord is Boerewors#99.', `Die wagwoord is ${R}.`, '1 password');
	gone('password with a "for" part and bold label', '**WiFi password for the farm:** `k4lahari-Sand`', `**WiFi password for the farm:** \`${R}\``, '1 password');
	gone('quoted password with spaces', 'password = "correct horse battery"', `password = ${R}`, '1 password');
	gone('API key', 'API key: sk-live-9f8e7d6c5b4a3210', `API key: ${R}`, '1 secret key');
	gone('2FA seed', '2FA secret: JBSW Y3DP EHPK 3PXP', `2FA secret: ${R}`, '1 2FA seed');
	gone('otpauth link', 'scan otpauth://totp/Proton:w?secret=JBSWY3DPEHPK3PXP&issuer=Proton now', `scan ${R} now`, '1 2FA seed');
	gone('recovery codes on the line and in the list below', 'Backup codes: 1a2b-3c4d\n- 5e6f-7g8h\n- 9i0j-1k2l\n\nNext note 2026.', `Backup codes: ${R}\n- ${R}\n- ${R}\n\nNext note 2026.`, '3 recovery codes');
	gone('German recovery codes', 'Wiederherstellungscodes:\n1. 83920174\n2. 55501928\nDanach kommt Text mit 12345678.', `Wiederherstellungscodes:\n1. ${R}\n2. ${R}\nDanach kommt Text mit 12345678.`, '2 recovery codes');
	gone('card number (checksum fits)', 'Karte 4111 1111 1111 1111 läuft ab', `Karte ${R} läuft ab`, '1 card number');
	gone('IBAN (checksum fits)', 'IBAN CH93 0076 2011 6238 5295 7', `IBAN ${R}`, '1 bank account number');
	gone('Swiss AHV number', 'AHV 756.1234.5678.97', `AHV ${R}`, '1 ID number');
	gone('passport number by label', 'Reisepass Nr.: C01X00T47, gültig', `Reisepass Nr.: ${R}, gültig`, '1 ID number');
	gone('South African ID number (checksum fits)', 'ID 8001015009087', `ID ${R}`, '1 card number');
	same('a rule about passwords', 'Never store passwords: use the manager. Password: stored in Proton Pass.');
	same('German and Afrikaans prose', 'Das Passwort ist nicht im Vault. Die wagwoord is geen geheim nie.');
	same('a long number that is no card', 'Order 4111 1111 1111 1112, phone +41 79 123 45 67, 2026-11-16 09:05:00');
	same('a token that is a plain word', 'token: expired\nsecret: none');
	same('an IBAN-like text with a wrong checksum', 'CH93 0076 2011 6238 5295 8');
	same('2FA note without a seed', '2FA: this code will work fine okay');
	same('a recovery note without codes', 'Recovery codes are in the safe.\nMore text follows here.');
	const twice = redact(redact('Passwort: hunter2').text);
	expect('filter: running it again changes nothing', twice.total === 0 && twice.text === `Passwort: ${R}`);

	// ---- Codex ----
	const cx= await captureCodex(fs, 'Tower', backend);
	const paths = cx.files.map((f) => f.path);
	expect('Codex: CODEX_HOME is used', cx.home === codex, cx.home);
	expect('Codex: AGENTS.md, memory files and database rows, in a stable order',
		paths.join(' | ') === '/AGENTS.md | /memories/MEMORY.md | /memories/blob.bin | /memories/empty.md | /memories/memory_summary.md | /memories/topics/boerdery.md | /memories_1.sqlite/stage1_outputs/thread-b', paths.join(' | '));
	expect('Codex: a Private folder is not read', !paths.some((p) => /private/i.test(p)));
	expect('Codex: session files are not memory', !paths.some((p) => p.includes('sessions')));
	expect('Codex: text is unchanged, secret-looking line included', cx.files.find((f) => f.path.endsWith('memory_summary.md'))?.text === SUMMARY);
	expect('Codex: a binary file is named, not copied', cx.files.find((f) => f.path.endsWith('blob.bin'))?.text === undefined && /Not text/.test(cx.files.find((f) => f.path.endsWith('blob.bin'))?.note ?? ''));
	const row = cx.files.find((f) => f.path.includes('thread-b'))?.text ?? '';
	expect('Codex: database row holds the raw memory and summary, not the use counters', row.includes('Line two über Äpfel') && row.includes('rollout_summary: Short summary') && !row.includes('usage_count') && !row.includes('last_usage'), row);
	expect('Codex: places say what was found', cx.places.map((p) => `${p.name}=${p.status}`).join('; ') === 'AGENTS.md=found; memories/=5 files; memories_v2/=not found; memories_1.sqlite=1 memory in table stage1_outputs', cx.places.map((p) => `${p.name}=${p.status}`).join('; '));
	const cxBody = renderBody(cx);
	expect('note: a file with its own headings, front matter and fences comes back byte for byte', blockUnder(cxBody, '/memories/MEMORY.md') === `${FENCED}\n`, JSON.stringify(blockUnder(cxBody, '/memories/MEMORY.md')));
	expect('note: one H2 per memory file and none from inside a file', (cxBody.match(/^## \//gm) ?? []).length === cx.files.length);
	expect('note: Windows line ends are saved as plain ones, so Obsidian has nothing to change later', blockUnder(cxBody, '/memories/topics/boerdery.md') === 'Plaas naby Windhoek.\nTweede reël.\n' && !cxBody.includes('\r'));
	expect('note: an empty file says so', cxBody.includes('## /memories/empty.md\n\n*Empty file.*'));
	expect('note: no date in the text, so the same memories give the same fingerprint', (await sha256(cxBody)) === (await sha256(renderBody(await captureCodex(fs, 'Tower', backend)))));

	const none = await captureCodex(realFs({ CODEX_HOME: `${dir}/nowhere` }), 'Tower', backend);
	expect('Codex: no home folder = nothing found', !none.found && !none.files.length);
	let refused = '';
	try {
		await captureCodex(realFs({ CODEX_HOME: `${dir}/Private/codex` }), 'Tower', backend);
	} catch (e) {
		refused = e instanceof Error ? e.message : String(e);
	}
	expect('Codex: a home inside a Private folder is refused', /Private/.test(refused));

	// ---- Claude Code ----
	const cc = await captureClaudeCode(fs, 'Tower');
	expect('Claude Code: ~/.claude is used', cc.home === claude, cc.home);
	expect('Claude Code: global CLAUDE.md and each project memory file',
		cc.files.map((f) => f.path).join(' | ') === '/CLAUDE.md | /projects/D--Work-garden/memory/MEMORY.md | /projects/D--Work-garden/memory/beds.md', cc.files.map((f) => f.path).join(' | '));
	expect('Claude Code: a project with Private in its name is skipped and named', cc.places.some((p) => p.name === 'skipped' && p.status.includes('D--Notes-Private-diary')));
	expect('Claude Code: counts files and projects', cc.places.some((p) => p.status === '2 files in 1 project (3 projects looked at)'), cc.places.map((p) => p.status).join('; '));

	// ---- Full sync on a fake vault ----
	const { settings } = normalizeSettings({});
	expect('settings: every source is off by default', !settings.memory.codexLocal && !settings.memory.claudeCodeLocal && settings.memory.intervalMinutes === 0 && settings.memory.folder === 'AI Memory');
	expect('settings: the privacy filter is on by default', settings.memory.redact === true);
	settings.memory.folder = '30 Sources/AI Memory';
	const { files, vault } = fakeVault();
	const plugin = { app: { vault, fileManager: { processFrontMatter: async () => undefined } }, settings, saveSettings: async () => undefined } as never;
	const run = (now: Date) => runMemorySync(plugin, undefined, { fs, backend, now, account: 'Tower' });
	const memoryFiles = () => [...files.keys()].filter((p) => p.startsWith('30 Sources/AI Memory/')).sort();
	const day1 = new Date(2026, 10, 16, 9, 5, 0);

	const off = await run(day1);
	expect('sync: nothing is on = nothing is read or written', off.newCount === 0 && !memoryFiles().length);

	settings.memory.codexLocal = true;
	settings.memory.claudeCodeLocal = true;
	const r1 = await run(day1);
	const C = '30 Sources/AI Memory/Codex/Tower';
	const L = '30 Sources/AI Memory/Claude Code/Tower';
	expect('sync 1: a snapshot and _latest.md per source', r1.newCount === 2 && !r1.stopped && memoryFiles().join(' | ') === `${L}/2026-11-16.md | ${L}/_latest.md | ${C}/2026-11-16.md | ${C}/_latest.md`, `${r1.stopped ?? ''} ${memoryFiles().join(' | ')}`);
	const snap = files.get(`${C}/2026-11-16.md`) ?? '';
	const hash = hashOfNote(snap) ?? '';
	expect('sync 1: properties', snap.startsWith(`---\nprovider: "Codex"\naccount: "Tower"\nsource: local\nsynced: 2026-11-16\nhash: ${hash}\nfiles: 7\nredacted: 1\nunread: true\n---\n\n`) && hash.length === 64, snap.slice(0, 200));
	expect('sync 1: the hash is the fingerprint of the text below the properties', hash === (await sha256(snap.slice(snap.indexOf('\n---\n\n') + 6))));
	expect('sync 1: _latest.md has the same text and links its snapshot', (files.get(`${C}/_latest.md`) ?? '').includes(`snapshot: "[[${C}/2026-11-16|2026-11-16]]"`) && hashOfNote(files.get(`${C}/_latest.md`) ?? '') === hash);
	expect('sync 1: the password is replaced, the rest of its line is kept', snap.includes('- Passwort: [REDACTED] (bleibt drin, es wird nichts gefiltert)') && snap.includes('except for 1 sensitive value'));
	expect('sync 1: the password is nowhere in the vault, log included', ![...files.values()].some((d) => d.includes('hunter2')));
	expect('sync 1: a source without a hit says nothing is filtered and has no redacted property', (files.get(`${L}/2026-11-16.md`) ?? '').includes('nothing is filtered') && !(files.get(`${L}/2026-11-16.md`) ?? '').includes('redacted:'));
	const log = files.get(settings.logPath) ?? '';
	expect('sync 1: the log names the kind and the file', log.includes('replaced by [REDACTED]: 1 password in Codex /memories/memory_summary.md'), log);
	expect('sync 1: one log line', /\*\*AI memory:\*\* 2 new, 0 changed, 0 unchanged/.test(log), log);

	const before = new Map(files);
	const r2 = await run(new Date(2026, 10, 17, 9, 0, 0));
	expect('sync 2 (next day, nothing changed): writes nothing at all', r2.unchanged === 2 && r2.newCount + r2.changedCount === 0 && files.size === before.size && [...files].every(([p, d]) => before.get(p) === d));

	// Codex uses a memory: only its counters change.
	const db = new sqlite.DatabaseSync(`${codex}/memories_1.sqlite`);
	db.exec('UPDATE stage1_outputs SET usage_count = 4, last_usage = 1700009999');
	db.close();
	const r3 = await run(new Date(2026, 10, 17, 10, 0, 0));
	expect('sync 3: a memory was only used, not changed = no snapshot', r3.unchanged === 2 && files.size === before.size);

	put(`${codex}/memories/memory_summary.md`, `${SUMMARY}- Neu: mag Rooibos.\n`);
	const r4 = await run(new Date(2026, 10, 17, 11, 0, 0));
	expect('sync 4: Codex changed = one new dated snapshot, Claude Code untouched', r4.changedCount === 1 && r4.unchanged === 1 && files.has(`${C}/2026-11-17.md`) && !files.has(`${L}/2026-11-17.md`));
	expect('sync 4: the old snapshot is untouched, _latest.md is the new one', files.get(`${C}/2026-11-16.md`) === snap && (files.get(`${C}/_latest.md`) ?? '').includes('mag Rooibos') && (files.get(`${C}/_latest.md`) ?? '').includes('2026-11-17|2026-11-17'));

	put(`${codex}/memories/memory_summary.md`, `${SUMMARY}- Neu: mag Rooibos sehr.\n`);
	const r5 = await run(new Date(2026, 10, 17, 14, 32, 0));
	expect('sync 5: a second change on the same day gets the time in its name', r5.changedCount === 1 && files.has(`${C}/2026-11-17 (1432).md`) && !(files.get(`${C}/2026-11-17.md`) ?? '').includes('sehr'));

	// The sync history is lost (settings cleared): the hash in _latest.md still prevents a duplicate.
	settings.memory.states = {};
	const r6 = await run(new Date(2026, 10, 18, 8, 0, 0));
	expect('sync 6: without sync history, _latest.md still says unchanged', r6.unchanged === 2 && !files.has(`${C}/2026-11-18.md`));

	// Every snapshot deleted: the next sync saves again.
	for (const p of memoryFiles().filter((x) => x.startsWith(L))) files.delete(p);
	const r7 = await run(new Date(2026, 10, 18, 9, 0, 0));
	expect('sync 7: snapshots deleted = saved again', r7.changedCount === 1 && files.has(`${L}/2026-11-18.md`) && files.has(`${L}/_latest.md`));

	settings.memory.folder = 'Private/AI Memory';
	const r8 = await run(new Date(2026, 10, 19, 9, 0, 0));
	expect('sync 8: a memory folder under Private is refused', /Private/.test(r8.stopped ?? '') && ![...files.keys()].some((p) => p.startsWith('Private/')));

	settings.memory.folder = '30 Sources/AI Memory';
	settings.memory.claudeCodeLocal = false;
	const count = files.size;
	const r9 = await runMemorySync(plugin, undefined, { fs: realFs({ CODEX_HOME: `${dir}/nowhere` }), backend, now: new Date(2026, 10, 19, 10, 0, 0), account: 'Tower' });
	expect('sync 9: Codex not installed = nothing written, and it says so', r9.nothing.join() === 'Codex' && files.size === count);

	// Filter off: the text is saved exactly as the AI keeps it.
	settings.memory.redact = false;
	settings.memory.codexLocal = true;
	const r10 = await run(new Date(2026, 10, 20, 9, 0, 0));
	const plain = files.get(`${C}/2026-11-20.md`) ?? '';
	expect('sync 10: filter off = a new snapshot with the text unchanged', r10.changedCount === 1 && !r10.redactions.length && plain.includes('Passwort: hunter2') && plain.includes('nothing is filtered') && !plain.includes('redacted:'), `${r10.changedCount} ${r10.stopped ?? ''}`);
	settings.memory.redact = true;

	// ---- Claude on the web (a made-up claude.ai) ----
	const PID = '01a1a13a-129d-7215-836d-3f2ff80ff328';
	const store: Record<string, string> = {
		'/profile.md': '---\nname: profile\n---\n\nIndustrial engineer. Schreibt Deutsch en Afrikaans.\r\n',
		'/areas/boerdery.md': 'Plaas naby Windhoek.\n',
		[`/projects/${PID}/preferences.md`]: 'Kurz antworten. Wagwoord: Boerewors#99\n',
		'/Private/diary.md': 'never read\n',
	};
	const claudeAsked: string[] = [];
	let profileJson: unknown = { conversation_preferences: null, cowork_global_instructions: null, locale: 'en-GB' };
	const fakeClaude = async () => ({
		legacyMemoryPath: '/api/organizations/org/memory',
		projectNamesPath: (ids: string[]) => `/projects?${ids.join(',')}`,
		memory: async (method: 'list' | 'read', body: Record<string, string>) => {
			claudeAsked.push(`${method} ${body.path ?? ''}`.trim());
			if (method === 'list') return { data: [...Object.keys(store).map((path) => ({ path, size_bytes: 1 })), { path: '/../etc/passwd' }, { nopath: true }], categories: [] };
			return { path: body.path, content: store[body.path ?? ''] };
		},
		get: async (path: string) => {
			claudeAsked.push(`GET ${path}`);
			if (path.startsWith('/projects?')) return { json: [{ uuid: PID, name: '2nd Brain' }] };
			if (path.endsWith('/memory')) return { json: { memory: '', controls: null } };
			return { json: profileJson };
		},
	});
	expect('Claude: memory paths sorted, odd ones dropped', memoryPaths({ data: [{ path: '/b.md' }, { path: '/a.md' }, { path: '/../x' }, { path: 'no-slash.md' }, {}] }).join() === '/a.md,/b.md');
	expect('Claude: a project file is shown under the project\'s name', shownPath(`/projects/${PID}/areas/x.md`, new Map([[PID, '2nd Brain']])) === '/projects/2nd Brain/areas/x.md' && shownPath(`/projects/${PID}/x.md`, new Map()) === `/projects/${PID}/x.md`);
	let oddList = '';
	try {
		memoryPaths({ error: 'nope' });
	} catch (e) {
		oddList = e instanceof Error ? e.message : String(e);
	}
	expect('Claude: a list with an unknown shape stops the read', /does not know/.test(oddList));

	const claudeAccount = settings.claude[0]!;
	settings.memory.codexLocal = false;
	const cweb = (now: Date) => runMemorySync(plugin, undefined, { fs: null, now, claude: fakeClaude, pauseMs: 0 });
	const c0 = await cweb(new Date(2026, 10, 20, 12, 0, 0));
	expect('Claude: off by default, nothing is asked', c0.newCount === 0 && !claudeAsked.length);
	settings.memory.claudeWeb[claudeAccount.id] = true;
	const K = `30 Sources/AI Memory/Claude/${claudeAccount.label}`;
	const c1 = await cweb(new Date(2026, 10, 20, 12, 5, 0));
	const csnap = files.get(`${K}/2026-11-20.md`) ?? '';
	expect('Claude sync 1: one snapshot and _latest.md, without file access', c1.newCount === 1 && !c1.stopped && files.has(`${K}/_latest.md`) && csnap.length > 0, c1.stopped ?? '');
	expect('Claude sync 1: list, project names, one read per file, older memory, profile; the Private file is never read',
		claudeAsked.join(' | ') === `list | GET /projects?${PID} | read /areas/boerdery.md | read /profile.md | read /projects/${PID}/preferences.md | GET /api/organizations/org/memory | GET /api/account_profile`, claudeAsked.join(' | '));
	expect('Claude sync 1: one H2 per memory file, by its own path, the project by name', (csnap.match(/^## \/.*$/gm) ?? []).join(' | ') === '## /areas/boerdery.md | ## /profile.md | ## /projects/2nd Brain/preferences.md | ## /instructions-for-claude', (csnap.match(/^## \/.*$/gm) ?? []).join(' | '));
	expect('Claude sync 1: properties and places', csnap.includes(`provider: "Claude"\naccount: ${JSON.stringify(claudeAccount.label)}\nsource: web\n`) && csnap.includes('- `memory files`: 3 files, 1 of them in 1 project') && csnap.includes('- `skipped`: 1 file in a folder named Private') && csnap.includes('- `instructions for Claude`: no text set'), csnap.slice(0, 600));
	expect('Claude sync 1: text kept, line ends plain, the filter applies', csnap.includes('Industrial engineer. Schreibt Deutsch en Afrikaans.\n') && !csnap.includes('\r') && csnap.includes('Wagwoord: [REDACTED]') && !csnap.includes('Boerewors#99'));
	const sizeC = files.size;
	const c2 = await cweb(new Date(2026, 10, 21, 8, 0, 0));
	expect('Claude sync 2: nothing changed = nothing written', c2.unchanged === 1 && files.size === sizeC);
	profileJson = { conversation_preferences: 'Antworte kurz.', cowork_global_instructions: null };
	const c3 = await cweb(new Date(2026, 10, 21, 8, 30, 0));
	expect('Claude sync 3: new instructions = a new snapshot', c3.changedCount === 1 && (files.get(`${K}/2026-11-21.md`) ?? '').includes('--- conversation_preferences ---\nAntworte kurz.'));
	settings.memory.claudeWeb[claudeAccount.id] = false;

	// ---- ChatGPT on the web (a made-up chatgpt.com) ----
	const sec = (id: string, title: string, description: string) => ({ id, title, description });
	const sections = [sec('overview', 'Overview', 'You farm near Windhoek. Du schreibst auch Deutsch.'), sec('tools', 'Tools And Workflows', 'Obsidian. Passwort: hunter2 steht hier.'), sec('dive-deeper', 'Dive Deeper', '')];
	const streamOf = (list: unknown[]) => [
		'event: started\ndata: {"generatedAtIso": "2026-11-16T11:08:41+00:00", "sourceChecksum": "abc"}',
		...list.map((s) => `event: section\ndata: ${JSON.stringify({ section: s })}`),
		`event: done\ndata: ${JSON.stringify({ generatedAtIso: '2026-11-16T11:08:41+00:00', sections: list })}`,
	].join('\n\n') + '\n\n';
	expect('ChatGPT: summary sections come from the "done" event', parseSummaryStream(streamOf(sections)).map((s) => s.id).join() === 'overview,tools,dive-deeper');
	expect('ChatGPT: without "done" the single section events are used', parseSummaryStream(streamOf(sections).split('event: done')[0] ?? '').length === 3);
	expect('ChatGPT: summary keeps its own section titles and leaves out sections without text', summaryText(parseSummaryStream(streamOf(sections))) === '## Overview\n\nYou farm near Windhoek. Du schreibst auch Deutsch.\n\n## Tools And Workflows\n\nObsidian. Passwort: hunter2 steht hier.');
	let odd = '';
	try {
		parseSummaryStream('<html>Just a moment…</html>');
	} catch (e) {
		odd = e instanceof Error ? e.message : String(e);
	}
	expect('ChatGPT: an answer that is not a summary stops the read', /does not know/.test(odd));
	const memoriesJson = { memories: [
		{ id: 'b', content: 'Older memory.', updated_at: '2026-09-11', status: 'warm', created_timestamp: 100 },
		{ id: 'a', content: 'Nuwer herinnering,\nmet twee reëls.', updated_at: '2026-11-11', status: 'warm', created_timestamp: 200 },
	], memory_num_tokens: 5 };
	expect('ChatGPT: saved memories newest first, without the status', savedMemories(memoriesJson).map((x) => x.id).join() === 'a,b' && !JSON.stringify(savedMemories(memoriesJson)).includes('warm'));
	const ins = instructionsText({ object: 'user_system_message_detail', about_user_message: 'Ich bin Bauer.', about_model_message: '', personality_type_selection: 'professional', enabled: true, disabled_tools: [], personality_traits: {} });
	expect('ChatGPT: custom instructions keep fields with text, short settings as lines', ins.filled === 1 && ins.text === 'enabled: true\npersonality_type_selection: professional\n\n--- about_user_message ---\nIch bin Bauer.', ins.text);

	const asked: string[] = [];
	let memories: unknown = memoriesJson;
	const fakeGpt = async () => ({
		memorySummaryStream: async () => (asked.push('POST summary'), streamOf(sections)),
		get: async (path: string) => (asked.push(`GET ${path}`), { json: path.startsWith('/backend-api/memories') ? memories : { about_user_message: '', personality_type_selection: 'professional' } }),
	});
	const gptAccount = settings.chatgpt[0]!;
	settings.memory.codexLocal = false;
	const web = (now: Date) => runMemorySync(plugin, undefined, { fs: null, backend, now, account: 'Tower', gpt: fakeGpt });
	const w0 = await web(new Date(2026, 10, 21, 9, 0, 0));
	expect('ChatGPT: off by default, nothing is asked', w0.newCount === 0 && !asked.length);
	settings.memory.chatgptWeb[gptAccount.id] = true;
	const G = `30 Sources/AI Memory/ChatGPT/${gptAccount.label}`;
	const w1 = await web(new Date(2026, 10, 21, 9, 5, 0));
	const gsnap = files.get(`${G}/2026-11-21.md`) ?? '';
	expect('ChatGPT sync 1: works without file access, one snapshot and _latest.md', w1.newCount === 1 && !w1.stopped && files.has(`${G}/_latest.md`) && gsnap.length > 0, w1.stopped ?? '');
	expect('ChatGPT sync 1: three requests, the summary as the only POST', asked.join(' | ') === 'POST summary | GET /backend-api/memories?include_memory_entries=true | GET /backend-api/user_system_messages', asked.join(' | '));
	expect('ChatGPT sync 1: properties say web', gsnap.includes(`provider: "ChatGPT"\naccount: ${JSON.stringify(gptAccount.label)}\nsource: web\n`) && gsnap.includes('files: 3\nredacted: 1\n'), gsnap.slice(0, 220));
	expect('ChatGPT sync 1: one H2 per part, the summary\'s own headings inside its block', (gsnap.match(/^## \//gm) ?? []).join() === '## /,## /,## /' && gsnap.includes('## /memory-summary\n\n```markdown\n## Overview\n') && gsnap.includes('## /saved-memories') && gsnap.includes('## /custom-instructions'));
	expect('ChatGPT sync 1: text kept as written, the privacy filter applies', gsnap.includes('[2026-11-11] Nuwer herinnering,\nmet twee reëls.') && gsnap.includes('Passwort: [REDACTED] steht hier.') && !gsnap.includes('hunter2'));
	const sizeW = files.size;
	const w2 = await web(new Date(2026, 10, 22, 9, 0, 0));
	expect('ChatGPT sync 2: nothing changed = nothing written', w2.unchanged === 1 && files.size === sizeW);
	memories = { memories: [...memoriesJson.memories, { id: 'c', content: 'Brand new.', updated_at: '2026-11-22', created_timestamp: 300 }] };
	const w3 = await web(new Date(2026, 10, 22, 10, 0, 0));
	expect('ChatGPT sync 3: a new saved memory = a new snapshot', w3.changedCount === 1 && (files.get(`${G}/2026-11-22.md`) ?? '').includes('[2026-11-22] Brand new.'));
	const w4 = await runMemorySync(plugin, undefined, { fs: null, now: new Date(2026, 10, 23, 9, 0, 0), gpt: async () => { throw new Error('Not logged in to ChatGPT.'); } });
	expect('ChatGPT: no login stops with its message and writes nothing', /Not logged in/.test(w4.stopped ?? '') && !files.has(`${G}/2026-11-23.md`));
	settings.memory.chatgptWeb[gptAccount.id] = false;
	settings.memory.codexLocal = true;

	const mobile = await runMemorySync(plugin, undefined, { fs: null, backend, account: 'Tower' });
	expect('sync: no file access (mobile) stops with a clear message', /desktop/.test(mobile.stopped ?? ''));
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
		console.log(failures ? `\n${failures} FAILED` : '\nAll AI memory tests passed.');
		process.exit(failures ? 1 : 0);
	});
