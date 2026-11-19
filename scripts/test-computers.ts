// One vault, several computers: data.json holds what you set, computers/<name>.json what each
// computer synced; what the others synced is combined before a sync; the busy marker.
// Run: npm run test:computers

(globalThis as unknown as { window: unknown }).window = globalThis;

import { normalizeSettings } from '../src/migrate';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import { accountKey, hasMachinePart, isUnsplit, joinSaved, machinePart, machinePaths, parseComputerFile, splitSettings, STORAGE_VERSION, withoutMachinePart, type ComputerFile } from '../src/computers/split';
import { mergeIndex, mergeOthers, mergeRuns, pickEntry } from '../src/computers/merge';
import { ABANDONED_AFTER_MS, busyElsewhere, busyText, idleMarker, parseBusy, runningMarker } from '../src/computers/busy';
import { belongsHere, ComputerStore } from '../src/computers/store';
import { runText, type LastRun } from '../src/last-run';
import type { IndexEntry } from '../src/types';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
/** JSON with sorted keys: the same content in another key order compares equal. */
function canon(v: unknown): string {
	return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
}
/** Where two texts first differ, for a failing comparison. */
function firstDiff(a: string, b: string): string {
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return i >= a.length && a.length === b.length ? '' : `at ${i}: …${a.slice(Math.max(0, i - 60), i + 60)}… vs …${b.slice(Math.max(0, i - 60), i + 60)}…`;
}

const entry = (md: string, synced: string, extra: Partial<IndexEntry> = {}): IndexEntry => ({ updated_at: synced, json: md.replace(/\.md$/, '.json'), md, synced, ...extra });
const run = (at: number, label = 'claude.ai', device?: string): LastRun => ({ at, trigger: 'auto', outcome: 'ok', label, newCount: 1, changedCount: 0, unchanged: 3, restored: 0, leftForLater: 0, ...(device ? { device } : {}) });

/** A Tower-like settings object: two Claude accounts, ChatGPT with a cooldown, Claude Code and Hermes. */
function towerSettings(): Settings {
	const s = normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS))).settings;
	s.claude[0]!.web.index = { c1: entry('AI Chats/Claude/Chat/One.md', '2026-11-01T10:00:00Z') };
	s.claude[0]!.web.fileIndex = { f1: 'AI Chats/Claude/Chat/Attachments/a.png' };
	s.claude[0]!.web.cloudIndex = { cse_1: { updated: 'x', md: 'AI Chats/Claude/Code-Cloud/s.md', json: 's.json', synced: '2026-11-01T10:00:00Z' } };
	s.claude[0]!.desktop.extraFolders = ['D:/Old/claude/projects'];
	s.claude[0]!.desktop.index = { d1: { updated: 'u', size: 1, mtime: 1, source: 'C:/Users/Walter/.claude/projects/a/d1.jsonl', md: 'AI Chats/Claude/Code-Local/Tower/d1.md', synced: 's' } };
	s.claude.push({ ...JSON.parse(JSON.stringify(s.claude[0])), id: 'work', label: 'Work' });
	s.claude[1]!.web.index = { w1: entry('AI Chats/Claude/Chat/Work.md', '2026-11-02T10:00:00Z') };
	s.chatgpt[0]!.web.index = { g1: entry('AI Chats/ChatGPT/Chat/G.md', '2026-11-03T10:00:00Z') };
	s.chatgpt[0]!.web.cooldownUntil = 12345;
	s.chatgpt[0]!.web.workspaceId = 'ws-1';
	s.gemini[0]!.studio.index = { p1: entry('AI Chats/Gemini/AI Studio/P.md', '2026-11-04T10:00:00Z') };
	s.hermes.profiles = [{ id: 'd:/ai/hermes', label: 'default', path: 'D:/AI/Hermes', enabled: true, index: {} }];
	s.hermes.pythonPath = 'C:/Python/python.exe';
	s.memory.states = { 'claude/Main': { hash: 'h', snapshot: 'AI Memory/x.md', synced: '2026-11-05T10:00:00Z', files: 2 } };
	s.lastRuns = { 'web:claude:default': run(1000) };
	s.lastAll = { start: 1, at: 2, trigger: 'manual', stopped: false };
	s.intervalMinutes = 60;
	return s;
}

// --- split and join -------------------------------------------------------------------
{
	const s = towerSettings();
	const { shared, local } = splitSettings(s, 'Tower', new Date('2026-11-19T12:00:00Z'));
	const sharedText = JSON.stringify(shared);
	expect('split: data.json is marked as split', shared.storage === STORAGE_VERSION && !isUnsplit(shared));
	expect('split: data.json keeps what you set', sharedText.includes('"intervalMinutes":60') && sharedText.includes('"workspaceId":"ws-1"') && sharedText.includes('"label":"Work"'));
	expect('split: no chat history, cooldown, run or path in data.json', !/"index"|fileIndex|cloudIndex|cooldownUntil|lastRuns|lastAll|extraFolders|profiles|pythonPath|"states"|\.claude\/projects|D:\/AI\/Hermes/.test(sharedText), sharedText.slice(0, 200));
	expect('split: the computer file names the computer and holds the history', local.computer === 'Tower' && local.savedAt === '2026-11-19T12:00:00.000Z'
		&& (local.accounts[accountKey('claude', 'default')]!.web!.index as Record<string, unknown>).c1 !== undefined
		&& (local.accounts[accountKey('claude', 'work')]!.web!.index as Record<string, unknown>).w1 !== undefined
		&& local.accounts[accountKey('chatgpt', 'default')]!.web!.cooldownUntil === 12345
		&& (local.accounts[accountKey('gemini', 'default')]!.studio!.index as Record<string, unknown>).p1 !== undefined);
	expect('split: the desktop paths and Hermes profiles go to the computer file', JSON.stringify(local.accounts[accountKey('claude', 'default')]!.desktop!.extraFolders) === '["D:/Old/claude/projects"]' && local.hermes?.pythonPath === 'C:/Python/python.exe' && local.hermes.profiles.length === 1);
	expect('split: the settings object itself is untouched', s.claude[0]!.web.index.c1 !== undefined && s.hermes.profiles.length === 1 && s.lastRuns['web:claude:default'] !== undefined);

	const back = normalizeSettings(joinSaved(JSON.parse(sharedText), JSON.parse(JSON.stringify(local)) as ComputerFile)).settings;
	expect("join: data.json plus the computer file gives the same settings back", canon(back) === canon(normalizeSettings(JSON.parse(JSON.stringify(s))).settings), firstDiff(canon(back), canon(normalizeSettings(JSON.parse(JSON.stringify(s))).settings)));

	const fresh = normalizeSettings(joinSaved(JSON.parse(sharedText), null)).settings;
	expect('join: a new computer gets the settings with an empty history', fresh.intervalMinutes === 60 && fresh.claude.length === 2 && Object.keys(fresh.claude[0]!.web.index).length === 0 && fresh.hermes.profiles.length === 0 && Object.keys(fresh.lastRuns).length === 0 && fresh.chatgpt[0]!.web.cooldownUntil === undefined);
	expect('join: the folders you chose are kept on a new computer', fresh.claude[0]!.web.chatFolder === s.claude[0]!.web.chatFolder && fresh.claude[0]!.desktop.folder === s.claude[0]!.desktop.folder && fresh.hermes.folder === s.hermes.folder);

	// An older ChatBridge on another computer wrote everything into data.json again.
	const old = JSON.parse(sharedText);
	old.claude[0].web.index = { stale: entry('Old.md', '2020-01-01T00:00:00Z') };
	const joined = normalizeSettings(joinSaved(old, JSON.parse(JSON.stringify(local)) as ComputerFile)).settings;
	expect('join: history in data.json never wins over the computer file', joined.claude[0]!.web.index.stale === undefined && joined.claude[0]!.web.index.c1 !== undefined);
	expect('join: data.json from before the split counts as unsplit', isUnsplit(JSON.parse(JSON.stringify(s))) && !isUnsplit(null));
}

// --- the part that belongs to one computer ---------------------------------------------
{
	const { local } = splitSettings(towerSettings(), 'Tower');
	const paths = machinePaths(local);
	expect('machine: its paths are the extra folders, session sources and Hermes homes', paths.includes('D:/Old/claude/projects') && paths.includes('C:/Users/Walter/.claude/projects/a/d1.jsonl') && paths.includes('D:/AI/Hermes'));
	expect('machine: it is this computer when one of them exists here', belongsHere(local, (p) => p === 'D:/AI/Hermes') && !belongsHere(local, () => false));
	const part = machinePart(local);
	const rest = withoutMachinePart(local);
	expect('machine: the put-aside part has only desktop apps and Hermes', !JSON.stringify(part).includes('"web"') && part.hermes?.profiles.length === 1 && hasMachinePart(part));
	expect('machine: what stays has the web history, no desktop or Hermes', JSON.stringify(rest).includes('"c1"') && !JSON.stringify(rest).includes('d1.jsonl') && rest.hermes === undefined && !hasMachinePart(rest));
	const none = splitSettings(normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS))).settings, 'X').local;
	expect('machine: a computer with no desktop app or Hermes history belongs anywhere', belongsHere(none, () => false));
}

// --- combining what the other computers synced -----------------------------------------
{
	const here = (p: string) => p === 'Renamed.md' || p === 'A.md';
	expect('pick: the same entry stays ours', pickEntry(entry('A.md', '1'), entry('A.md', '1'), here).md === 'A.md');
	expect('pick: the entry whose note is in the vault wins (a rename on the other computer)', pickEntry(entry('Old name.md', '2026-11-02'), entry('Renamed.md', '2026-11-01'), here).md === 'Renamed.md');
	expect('pick: ours wins when only our note is there', pickEntry(entry('A.md', '2026-11-01'), entry('Gone.md', '2026-11-09'), here).md === 'A.md');
	expect('pick: otherwise the newer one', pickEntry(entry('X.md', '2026-11-01'), entry('Y.md', '2026-11-02'), () => false).md === 'Y.md' && pickEntry(entry('X.md', '2026-11-03'), entry('Y.md', '2026-11-02'), () => false).md === 'X.md');
	const idx: Record<string, unknown> = { a: entry('A.md', '1') };
	const n = mergeIndex(idx, { a: entry('A.md', '1'), b: entry('B.md', '2') }, () => true);
	expect('index: a chat only the other computer saved is added; ours is kept', n === 1 && idx.b !== undefined && Object.keys(idx).length === 2);
	expect('index: junk from the other file is ignored', mergeIndex(idx, { c: 'nope', d: null }, () => true) === 0 && idx.c === undefined && mergeIndex(idx, 'junk', () => true) === 0);

	const s = normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS))).settings;
	s.claude[0]!.web.index = { mine: entry('Mine.md', '2026-11-01T00:00:00Z') };
	s.lastRuns = { 'web:claude:default': run(500) };
	const tower = splitSettings(towerSettings(), 'Tower').local;
	const learned = mergeOthers(s, [tower], 'Laptop', () => true);
	expect('others: the laptop learns what the tower saved, and keeps its own', learned >= 4 && s.claude[0]!.web.index.c1 !== undefined && s.claude[0]!.web.index.mine !== undefined && s.chatgpt[0]!.web.index.g1 !== undefined && s.gemini[0]!.studio.index.p1 !== undefined);
	expect('others: downloaded files and cloud sessions too', s.claude[0]!.web.fileIndex.f1 !== undefined && s.claude[0]!.web.cloudIndex?.cse_1 !== undefined);
	expect('others: an account the laptop does not have is skipped', s.claude.length === 1);
	expect('others: desktop sessions, Hermes and cooldowns stay with their computer', Object.keys(s.claude[0]!.desktop.index).length === 0 && s.hermes.profiles.length === 0 && s.chatgpt[0]!.web.cooldownUntil === undefined && s.claude[0]!.desktop.extraFolders.length === 0);
	expect('others: web memory snapshots are known too', s.memory.states['claude/Main']?.hash === 'h');
	expect('others: the newer last run is shown, with its computer', s.lastRuns['web:claude:default']?.at === 1000 && s.lastRuns['web:claude:default']?.device === 'Tower');
	expect('others: our own file is never read as another computer', mergeOthers(s, [{ ...tower, computer: 'Laptop' }], 'Laptop', () => true) === 0);
	expect('others: merging again learns nothing new', mergeOthers(s, [tower], 'Laptop', () => true) === 0);

	const runs: Record<string, LastRun> = { a: run(5) };
	mergeRuns(runs, { a: run(9, 'x', 'Laptop'), b: run(3) }, 'Tower', 'Laptop');
	expect('runs: a run this computer did elsewhere comes back without a computer name', runs.a?.at === 9 && runs.a.device === undefined && runs.b?.device === 'Tower');
	expect('runs: "on Tower" appears in the last-sync line', runText(run(Date.now(), 'x', 'Tower')).text.includes(' on Tower') && !runText(run(Date.now())).text.includes(' on '));
}

// --- the busy marker ------------------------------------------------------------------
{
	const now = Date.UTC(2026, 10, 19, 10, 30);
	const m = runningMarker('Laptop', now - 20 * 60_000, now - 30_000);
	const back = parseBusy(JSON.stringify(m));
	expect('busy: a written marker reads back', back?.device === 'Laptop' && back.state === 'running');
	expect('busy: another computer that is syncing blocks', busyElsewhere(back, 'Tower', now)?.device === 'Laptop');
	expect('busy: our own marker never blocks us', busyElsewhere(back, 'Laptop', now) === null);
	expect('busy: a finished sync does not block', busyElsewhere(idleMarker('Laptop', now), 'Tower', now) === null);
	expect('busy: no sign of life for 30 minutes = left behind', busyElsewhere(runningMarker('Laptop', now - ABANDONED_AFTER_MS - 60_000, now - ABANDONED_AFTER_MS - 1), 'Tower', now) === null);
	expect('busy: a clock a little ahead on the other computer still counts as alive', busyElsewhere(runningMarker('Laptop', now, now + 90_000), 'Tower', now) !== null);
	expect('busy: half written, foreign or empty files are no marker', parseBusy(JSON.stringify(m).slice(0, 20)) === null && parseBusy('{"v":2}') === null && parseBusy('') === null && parseBusy(JSON.stringify({ ...m, at: 'soon' })) === null);
	expect('busy: the message names the computer and when it began', busyText(m, () => '10:10') === 'Laptop is syncing (since 10:10).');
}

// --- the store, over a fake plugin folder ----------------------------------------------
async function store() {
	const files = new Map<string, string>();
	const writes: string[] = [];
	const dirs = new Set<string>(['P']);
	const adapter = {
		exists: async (p: string) => files.has(p) || dirs.has(p),
		read: async (p: string) => {
			const t = files.get(p);
			if (t === undefined) throw new Error('missing');
			return t;
		},
		write: async (p: string, t: string) => {
			writes.push(p);
			files.set(p, t);
		},
		mkdir: async (p: string) => void dirs.add(p),
		list: async (p: string) => ({ files: [...files.keys()].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/')), folders: [] }),
	};
	let dataJson: unknown = null;
	const saveData = async (d: unknown) => {
		writes.push('data.json');
		dataJson = JSON.parse(JSON.stringify(d));
	};
	const st = new ComputerStore(() => adapter as never, () => 'P');
	const name = st.here; // "This computer" outside Obsidian
	const own = `P/computers/${name}.json`;

	// A vault from before the split, on a computer where none of its desktop or Hermes paths exist.
	const before = JSON.parse(JSON.stringify(towerSettings()));
	const loaded = await st.load(before);
	expect('store: an old data.json is split once', loaded.firstSplit);
	expect('store: desktop and Hermes history from another computer is put aside', loaded.putAside && files.has('P/computers/_unclaimed.json') && JSON.stringify(parseComputerFile(files.get('P/computers/_unclaimed.json')!)).includes('D:/AI/Hermes'));
	const s = normalizeSettings(loaded.raw).settings;
	expect('store: the web history is kept here, the desktop history is not', s.claude[0]!.web.index.c1 !== undefined && Object.keys(s.claude[0]!.desktop.index).length === 0 && s.hermes.profiles.length === 0);
	await st.save(s, saveData);
	expect('store: the first save writes data.json and this computer\'s file', writes.includes('data.json') && files.has(own) && (dataJson as { storage?: number }).storage === STORAGE_VERSION);
	writes.length = 0;
	await st.save(s, saveData);
	expect('store: saving again with nothing changed writes nothing', writes.length === 0, writes.join());
	s.claude[0]!.web.index.c2 = entry('Two.md', '2026-11-19T00:00:00Z');
	await st.save(s, saveData);
	expect('store: a new chat rewrites only this computer\'s file, not data.json', writes.length === 1 && writes[0] === own, writes.join());
	writes.length = 0;
	s.maxChatsPerRun = 9;
	await st.save(s, saveData);
	expect('store: a changed setting rewrites only data.json', writes.length === 1 && writes[0] === 'data.json', writes.join());

	// Another computer's file appears (the vault's sync delivered it), plus a clash copy and junk.
	const laptop = splitSettings(towerSettings(), 'Laptop').local;
	(laptop.accounts[accountKey('claude', 'default')]!.web!.index as Record<string, unknown>).fromLaptop = entry('L.md', '2026-11-19T01:00:00Z');
	files.set('P/computers/Laptop.json', JSON.stringify(laptop));
	files.set('P/computers/Laptop (Name clash 2026-11-19).json', JSON.stringify(laptop));
	files.set('P/computers/notes.txt', 'x');
	files.set('P/computers/Broken.json', '{"v":1,');
	const others = await st.others();
	expect('store: other computers are read, our own file and the put-aside one are not', others.length === 2 && others.every((f) => f.computer === 'Laptop'), others.map((f) => f.computer).join());
	const n = await st.mergeOthers(s, () => true);
	expect('store: what the laptop synced is combined here', n > 0 && s.claude[0]!.web.index.fromLaptop !== undefined);

	// The same vault opened again: data.json is split now.
	const st2 = new ComputerStore(() => adapter as never, () => 'P');
	const again = await st2.load(dataJson);
	const s2 = normalizeSettings(again.raw).settings;
	expect('store: reopened, it is not split again and the history comes from the computer file', !again.firstSplit && s2.claude[0]!.web.index.c2 !== undefined && s2.maxChatsPerRun === 9);
	writes.length = 0;
	await st2.save(s2, saveData);
	expect('store: reopened and saved unchanged, data.json is not rewritten', !writes.includes('data.json'), writes.join());

	// The computer the put-aside history belongs to opens the vault for the first time.
	const st3 = new ComputerStore(() => adapter as never, () => 'P');
	(st3 as unknown as { here: string }).here = 'Tower';
	const origExists = (globalThis as unknown as { require?: unknown }).require;
	(globalThis as unknown as { require: (m: string) => unknown }).require = (m: string) => (m === 'fs' ? { existsSync: (p: string) => p === 'D:/AI/Hermes' } : { homedir: () => 'C:/Users/Walter' });
	const tower = await st3.load(dataJson);
	(globalThis as unknown as { require?: unknown }).require = origExists;
	const s3 = normalizeSettings(tower.raw).settings;
	expect('store: that computer takes its desktop and Hermes history back', s3.hermes.profiles.length === 1 && s3.claude[0]!.desktop.index.d1 !== undefined);
	expect('store: the put-aside file is emptied, not deleted', files.has('P/computers/_unclaimed.json') && !hasMachinePart(parseComputerFile(files.get('P/computers/_unclaimed.json')!)!));

	// Busy marker through the store.
	await st.markRunning(Date.now());
	expect('store: our own running marker does not block us', (await st.busyElsewhere()) === null);
	expect('store: but it blocks the tower', (await st3.busyElsewhere())?.device === name);
	await st.markIdle();
	expect('store: after the sync it blocks nobody', (await st3.busyElsewhere()) === null);
}

void store().then(() => {
	console.log(failures ? `\n${failures} FAILED` : '\nAll computer tests passed.');
	process.exit(failures ? 1 : 0);
});
