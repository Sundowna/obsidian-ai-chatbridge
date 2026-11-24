// Active Context upkeep test: Live sessions, the 7-day archive pass, stale "Now" lines and the
// hand-over message, on made-up notes in a fake vault. If Python and the vault's
// archive-handoff.py are there, the archive pass is also compared with the script's own output
// (run on a temp copy, never on the real vault).
// Run: npm run test:handoff

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TFile } from 'obsidian';
import {
	addToArchive,
	allChats,
	daysBefore,
	flagStale,
	handoverText,
	lastAsk,
	LIVE_END,
	LIVE_START,
	liveSessions,
	nowLines,
	putLive,
	renderLive,
	setFrontmatter,
	splitOld,
	type SeenLine,
} from '../src/handoff/core';
import { dailyUpkeep, updateLive } from '../src/handoff/run';
import { localDate } from '../src/naming';
import { normalizeSettings } from '../src/migrate';
import type { Settings } from '../src/settings';
import { readWrite } from './fake-vault';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
const count = (s: string, part: string) => s.split(part).length - 1;

const NOW = Date.parse('2026-11-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function settings(): Settings {
	const s = normalizeSettings({}).settings;
	s.handoff.enabled = true;
	s.claude[0]!.web.index = {
		a: { updated_at: hoursAgo(1), json: 'x.json', md: 'AI Chats/Claude/Chat/Plugin work.md', synced: hoursAgo(0.5) },
		b: { updated_at: hoursAgo(100), json: 'y.json', md: 'AI Chats/Claude/Chat/Old chat.md', synced: hoursAgo(99) },
		broken: { updated_at: 'not a date', json: '', md: 'AI Chats/Claude/Chat/Broken.md', synced: '' },
	};
	s.claude[0]!.desktop.index = { c: { updated: hoursAgo(3), size: 1, mtime: 1, source: 's', md: 'AI Chats/Claude/Code/Hook work.md', synced: hoursAgo(2) } };
	s.chatgpt[0]!.desktop.index = { d: { updated: hoursAgo(5), size: 1, mtime: 1, source: 's', md: 'AI Chats/ChatGPT/Codex/Codex run.md', synced: hoursAgo(5) } };
	s.hermes.profiles = [{ id: 'p', label: 'default', path: '/h', enabled: true, index: { e: { rev: '1', updated: hoursAgo(10), md: 'AI Chats/Hermes/default/Bot.md', synced: hoursAgo(10) } } }];
	return s;
}

// --- Which chats are live -------------------------------------------------------------------
{
	const s = settings();
	const all = allChats(s);
	expect('every synced chat note is found, ones without a usable date are left out', all.length === 5 && !all.some((i) => i.md.includes('Broken')), all.map((i) => i.md).join(', '));
	const live = liveSessions(s, NOW, 48);
	expect('live sessions: only the last 48 hours, newest first', live.map((i) => i.md.split('/').pop()).join('|') === 'Plugin work.md|Hook work.md|Codex run.md|Bot.md');
	expect('labels name the surface: Claude, Claude Code, Codex, Hermes (profile)', live.map((i) => i.label).join('|') === 'Claude|Claude Code|Codex|Hermes (default)', live.map((i) => i.label).join('|'));
	s.claude.push({ ...s.claude[0]!, id: 'b', label: 'Work', web: { ...s.claude[0]!.web, index: {} }, desktop: { ...s.claude[0]!.desktop, index: {} } });
	expect('with two Claude accounts the account name is added', liveSessions(s, NOW, 48)[0]!.label === `Claude (${s.claude[0]!.label})`, liveSessions(s, NOW, 48)[0]!.label);
	expect('a short window leaves only the newest', liveSessions(settings(), NOW, 2).length === 1);
}

// --- Your last request ----------------------------------------------------------------------
{
	const note = '---\nuuid: 1\n---\n## Human · 2026-11-24 10:00\n\nFirst ask\n\n## Claude · 2026-11-24 10:01\n\nAnswer\n\n## Human · 2026-11-24 11:00\n\n![[pic.png]]\n\n📎 [[a.pdf|a]]\n\nBuild the   plugin part\nfirst, please\n\n## Claude · 2026-11-24 11:02\n\nOK\n';
	expect('last ask: the last message from you, on one line, files left out', lastAsk(note) === 'Build the plugin part first, please', lastAsk(note));
	expect('last ask: "## You" headings (ChatGPT, Codex, Claude Code, Gemini, Lumo, Hermes) work too', lastAsk('## You · 1\n\nHi there\n\n## ChatGPT\n\nHello') === 'Hi there');
	expect('last ask: Windows line endings', lastAsk('## You\r\n\r\nLine one\r\nLine two\r\n') === 'Line one Line two');
	expect('last ask: a message with only a file falls back to the one before', lastAsk('## You\n\nReal ask\n\n## You\n\n![[x.png]]\n') === 'Real ask');
	const long = lastAsk(`## You\n\n${'word '.repeat(80)}`);
	expect('last ask: shortened to 160 characters with …', long.length === 160 && long.endsWith('…'), String(long.length));
	expect('last ask: none in a note without your messages', lastAsk('## Claude\n\nOnly me') === '');
}

const CONTEXT = [
	'---',
	'type: handoff',
	'updated: 2026-11-20',
	'---',
	'',
	'> [!info] Read this first.',
	'',
	'## Plan',
	'',
	'Goal 2026-01-01 stays.',
	'',
	'## Now',
	'',
	'- **Langflow pipeline** running',
	'- Agent speed-up',
	'  - an indented detail',
	'',
	'## Waiting for Walter',
	'',
	'- [ ] Something to decide',
	'',
	'## Next up',
	'',
	'- Later',
	'',
	'## Recently done (last 7 days)',
	'',
	'- 2026-11-23 · new thing',
	'- 2026-11-17 · exactly at the cutoff',
	'- 2026-11-16 · one day too old',
	'- 2026-10-30 · last month',
	'  not a dated line, stays',
	'',
	'## Old session 2026-11-10',
	'',
	'Long section text.',
	'',
	'## Undated extra',
	'',
	'Stays.',
	'',
].join('\n');

// --- The Live sessions block ----------------------------------------------------------------
{
	const block = renderLive([{ label: 'Claude', md: 'AI Chats/Claude/Chat/Plugin work.md', updated: hoursAgo(1), synced: hoursAgo(0.5), ask: 'Build it' }], 48);
	expect('block: link without ".md" and the note name as text, plus the last ask', block.includes('[[AI Chats/Claude/Chat/Plugin work|Plugin work]]') && block.includes('last ask: “Build it”'));
	const once = putLive(CONTEXT, block);
	expect('block goes in a "## Live sessions" section right before "## Now"', /## Live sessions\n\n<!-- ai-chatbridge:live-sessions -->[\s\S]*<!-- \/ai-chatbridge:live-sessions -->\n\n## Now/.test(once));
	const twice = putLive(once, renderLive([], 48));
	expect('the next update replaces the block, never adds a second one', count(twice, LIVE_START) === 1 && count(twice, '## Live sessions') === 1 && twice.includes('- No chat in the last 48 hours.') && !twice.includes('Plugin work'));
	expect('nothing else in the note changes', twice.replace(/## Live sessions\n\n[\s\S]*?\n\n(?=## Now)/, '') === CONTEXT);
	const crlf = putLive(CONTEXT.replace(/\n/g, '\r\n'), block);
	expect('Windows line endings are kept', !/[^\r]\n/.test(crlf) && crlf.includes(`${LIVE_START}\r\n`));
	const noNow = putLive('# Note\n\nText\n', block);
	expect('a note without "## Now" gets the section at the end', noNow.startsWith('# Note\n\nText\n\n## Live sessions') && noNow.trimEnd().endsWith(LIVE_END));
}

// --- The archive pass (same rules as archive-handoff.py) -------------------------------------
{
	const today = '2026-11-24';
	expect('cutoff is 7 days back', daysBefore(today, 7) === '2026-11-17');
	const { keep, moved } = splitOld(CONTEXT, today, 7);
	const bodies = moved.map((m) => m.body.split('\n')[0]);
	expect('older "Recently done" lines and old dated sections move', bodies.join('|') === '- 2026-11-16 · one day too old|- 2026-10-30 · last month|## Old session 2026-11-10', bodies.join('|'));
	expect('a line exactly at the cutoff, newer lines and undated lines stay', keep.includes('2026-11-17 · exactly') && keep.includes('2026-11-23') && keep.includes('not a dated line, stays'));
	expect('the five parts and undated sections stay, even with a date in their text', keep.includes('Goal 2026-01-01 stays.') && keep.includes('## Undated extra'));
	expect('nothing is lost: kept + moved hold every line', CONTEXT.split('\n').every((l) => keep.includes(l) || moved.some((m) => m.body.includes(l))));
	const withLive = putLive(CONTEXT, renderLive([], 48)).replace('## Live sessions', '## Live sessions');
	expect('the Live sessions section is never archived', splitOld(withLive, today, 7).keep.includes(LIVE_START));

	const fresh = addToArchive(null, '2026-11', moved.filter((m) => m.date.startsWith('2026-11')), today, 'Active Context');
	expect('a new month file: frontmatter, the note callout, dated heading, newest first', fresh.startsWith('---\ntype: handoff-archive\nmonth: 2026-11\ncreated: 2026-11-24') && fresh.includes('[[Active Context]]') && fresh.indexOf('## Old session') > fresh.indexOf('one day too old'));
	const more = addToArchive(fresh.replace('updated: 2026-11-24', 'updated: 2026-11-01').replace('unread: true', 'unread: false'), '2026-11', [{ date: '2026-11-18', kind: 'item', body: '- 2026-11-18 · later' }], '2026-11-26', 'Active Context');
	expect('adding to a month file keeps what was there and marks it updated and unread', more.startsWith(fresh.replace(/\n+$/, '').replace('updated: 2026-11-24', 'updated: 2026-11-26')) && more.includes('## Moved from Active Context on 2026-11-26\n\n- 2026-11-18 · later') && more.includes('unread: true'));
	const crlf = addToArchive(fresh.replace(/\n/g, '\r\n'), '2026-11', [{ date: '2026-11-18', kind: 'item', body: '- x' }], today, 'Active Context');
	expect('a month file with Windows line endings keeps them', !/[^\r]\n/.test(crlf));
	expect('setFrontmatter changes only the first match', setFrontmatter('updated: a\nupdated: b', 'updated', 'c') === 'updated: c\nupdated: b');
}

// --- Stale "Now" lines ------------------------------------------------------------------------
{
	expect('"Now" lines are the top-level bullets only', nowLines(CONTEXT).join('|') === '- **Langflow pipeline** running|- Agent speed-up');
	let seen: Record<string, SeenLine> = {};
	let r = flagStale(CONTEXT, seen, '2026-11-20', 3);
	expect('first day: lines are remembered, nothing flagged', r.flagged === 0 && r.text === CONTEXT && Object.keys(r.seen).length === 2);
	seen = r.seen;
	r = flagStale(CONTEXT, seen, '2026-11-22', 3);
	expect('two days later: still nothing', r.flagged === 0);
	r = flagStale(CONTEXT, r.seen, '2026-11-23', 3);
	const waiting = r.text.slice(r.text.indexOf('## Waiting for Walter'), r.text.indexOf('## Next up'));
	expect('three days later: one question per line, at the end of "Waiting for Walter"', r.flagged === 2 && waiting.includes('- [ ] Something to decide\n- [ ] Still in **Now** since 2026-11-20') && waiting.endsWith('\n\n') && waiting.includes('“Langflow pipeline running”'), waiting);
	const again = flagStale(r.text, r.seen, '2026-11-30', 3);
	expect('a flagged line is asked about once only', again.flagged === 0 && again.text === r.text);
	const changed = flagStale(r.text.replace('- Agent speed-up', '- Agent speed-up, now faster'), again.seen, '2026-11-30', 3);
	expect('a line that is gone from "Now" is forgotten, a changed line counts as new', Object.keys(changed.seen).length === 2 && Object.values(changed.seen).some((v) => v.first === '2026-11-30' && !v.flagged));
	const noWaiting = flagStale(CONTEXT.replace(/## Waiting for Walter\n\n- \[ \] Something to decide\n\n/, ''), { [Object.keys(seen)[0]!]: { first: '2026-11-01' } }, '2026-11-24', 3);
	expect('without a "Waiting for Walter" section one is made before "Next up"', /## Waiting for Walter\n\n- \[ \] Still in \*\*Now\*\* since 2026-11-01[^\n]*\n\n## Next up/.test(noWaiting.text), noWaiting.text);
	const crlf = flagStale(CONTEXT.replace(/\n/g, '\r\n'), { [Object.keys(seen)[0]!]: { first: '2026-11-01' } }, '2026-11-24', 3);
	expect('Windows line endings are kept when flagging', crlf.flagged === 1 && !/[^\r]\n/.test(crlf.text));
}

// --- Hand-over message ------------------------------------------------------------------------
{
	const item = { label: 'Claude Code', md: 'AI Chats/Claude/Code/Hook work.md', updated: hoursAgo(3), synced: hoursAgo(2) };
	const t = handoverText(item, 'Build the plugin part first', NOW, '90 System/Memory/Active Context.md', 'D:\\Vault\\AI Chats\\Claude\\Code\\Hook work.md');
	expect('hand-over: names the chat, its vault path, the full path, freshness, Active Context and the last ask', t.includes('Claude Code chat "Hook work"') && t.includes('`AI Chats/Claude/Code/Hook work.md`') && t.includes('D:\\Vault\\AI Chats') && t.includes('synced 2 h ago') && t.includes('Read `90 System/Memory/Active Context.md` first') && t.endsWith('My last request there was: "Build the plugin part first"'), t);
	expect('hand-over: works without a full path and without an ask', !handoverText(item, '', NOW, 'A.md').includes('on this computer') && !handoverText(item, '', NOW, 'A.md').includes('last request'));
}

// --- In a vault -------------------------------------------------------------------------------
function fakeApp(files: Map<string, string>) {
	const folders = new Set<string>();
	let writes = 0;
	const rw = readWrite(files);
	const vault = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: 0 }) : folders.has(p) ? {} : null),
		createFolder: async (p: string) => void folders.add(p),
		create: async (p: string, d: string) => {
			if (files.has(p)) throw new Error('exists');
			writes++;
			files.set(p, d);
		},
		...rw,
		modify: async (f: { path: string }, d: string) => {
			writes++;
			await rw.modify(f, d);
		},
	};
	return { app: { vault } as never, writes: () => writes };
}

async function vaultTests(): Promise<void> {
	const s = settings();
	const ctxPath = s.handoff.file;
	const files = new Map<string, string>([
		[ctxPath, CONTEXT],
		['AI Chats/Claude/Chat/Plugin work.md', '## Human · x\n\nLet us build the plugin part first\n\n## Claude · y\n\nOK'],
		['AI Chats/Claude/Code/Hook work.md', '## You · x\n\nShow me the hook\n'],
		[`${s.handoff.archiveFolder}/2026-10.md`, '---\ntype: handoff-archive\nmonth: 2026-10\nupdated: 2026-10-31\nunread: false\n---\n\nOlder text\n'],
	]);
	const { app, writes } = fakeApp(files);
	expect('updateLive: says when the note is missing', !(await updateLive(fakeApp(new Map()).app, s, NOW)));
	await updateLive(app, s, NOW);
	const live = files.get(ctxPath)!;
	expect('updateLive: the block lists the live chats with their last ask; a missing note gets no ask', live.includes('[[AI Chats/Claude/Chat/Plugin work|Plugin work]] · last ask: “Let us build the plugin part first”') && live.includes('· last ask: “Show me the hook”') && /Codex · \[\[AI Chats\/ChatGPT\/Codex\/Codex run\|Codex run\]\]\n/.test(live));
	const before = writes();
	await updateLive(app, s, NOW);
	expect('updateLive: nothing new, so the note is not written again', writes() === before);

	const r = await dailyUpkeep(app, s.handoff, '2026-11-24');
	const ctx = files.get(ctxPath)!;
	const nov = files.get(`${s.handoff.archiveFolder}/_2026-11.md`);
	const oct = files.get(`${s.handoff.archiveFolder}/2026-10.md`)!;
	expect('daily: 3 entries moved, archive files written', r.found && r.moved === 3 && r.archives.length === 2, JSON.stringify(r));
	expect('daily: a new month file starts with "_"', !!nov && nov.includes('## Old session 2026-11-10') && nov.includes('one day too old') && !files.has(`${s.handoff.archiveFolder}/2026-11.md`));
	expect('daily: an existing month file without "_" is added to, not replaced', oct.startsWith('---\ntype: handoff-archive') && oct.includes('Older text') && oct.includes('- 2026-10-30 · last month') && !files.has(`${s.handoff.archiveFolder}/_2026-10.md`));
	expect('daily: moved lines leave the note, the rest stays, the Live sessions block too', !ctx.includes('one day too old') && !ctx.includes('Old session') && ctx.includes('2026-11-23 · new thing') && ctx.includes(LIVE_START));
	expect('daily: "updated" in the note is today, last run and seen lines remembered', ctx.includes('updated: 2026-11-24') && s.handoff.lastDaily === '2026-11-24' && Object.keys(s.handoff.nowSeen).length === 2);
	const again = await dailyUpkeep(app, s.handoff, '2026-11-24');
	expect('daily: a second run moves nothing more', again.moved === 0 && files.get(ctxPath) === ctx);
	s.handoff.staleDays = 0;
	const later = await dailyUpkeep(app, s.handoff, '2026-12-30');
	expect('daily: stale check off (0) asks nothing', later.flagged === 0 && !files.get(ctxPath)!.includes('Still in **Now**'));
	expect('daily: missing note is reported, nothing written', !(await dailyUpkeep(fakeApp(new Map()).app, s.handoff, '2026-11-24')).found);
}

// --- Same result as archive-handoff.py ----------------------------------------------------------
async function parityTests(): Promise<void> {
	const script = 'D:/BrainTest/SecondBrain/Open/Brain/90 System/Tools/archive-handoff.py';
	let python = '';
	for (const p of ['python', 'python3', 'py']) {
		try {
			execFileSync(p, ['--version'], { stdio: 'ignore' });
			python = p;
			break;
		} catch {
			/* next */
		}
	}
	if (!python || !existsSync(script)) {
		console.log('SKIP  same result as archive-handoff.py (no Python or no script here)');
		return;
	}
	const today = localDate(new Date().toISOString());
	const d = (n: number) => daysBefore(today, n);
	const text = CONTEXT.replace('2026-11-23', d(1)).replace('2026-11-17', d(7)).replace('2026-11-16', d(8)).replace('2026-10-30', d(40)).replace('Old session 2026-11-10', `Old session ${d(14)}`).replace(/\n/g, '\r\n');
	const dir = mkdtempSync(join(tmpdir(), 'chatbridge-handoff-test-')).replace(/\\/g, '/');
	try {
		mkdirSync(`${dir}/90 System/Tools`, { recursive: true });
		mkdirSync(`${dir}/90 System/Memory`, { recursive: true });
		copyFileSync(script, `${dir}/90 System/Tools/archive-handoff.py`);
		writeFileSync(`${dir}/90 System/Memory/Active Context.md`, text);
		execFileSync(python, [`${dir}/90 System/Tools/archive-handoff.py`, '--write'], { stdio: 'ignore' });
		const pyContext = readFileSync(`${dir}/90 System/Memory/Active Context.md`, 'utf8');
		const { keep, moved } = splitOld(text, today, 7);
		expect('same Active Context as archive-handoff.py', setFrontmatter(keep, 'updated', today) === pyContext);
		const months = [...new Set(moved.map((m) => m.date.slice(0, 7)))];
		const same = months.every((month) => {
			const py = readFileSync(`${dir}/90 System/Memory/Handoff archive/${month}.md`, 'utf8');
			return addToArchive(null, month, moved.filter((m) => m.date.startsWith(month)), today, 'Active Context', '\r\n') === py;
		});
		expect('same month files as archive-handoff.py (only the name differs: "_")', same, months.join(', '));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

void (async () => {
	await vaultTests();
	await parityTests();
	console.log(failures ? `\n${failures} FAILED` : '\nAll handoff tests passed.');
	process.exit(failures ? 1 : 0);
})();
