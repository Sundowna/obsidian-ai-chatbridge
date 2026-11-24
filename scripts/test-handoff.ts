// Active Context upkeep test: Live sessions, the 7-day archive pass, stale "Now" lines and the
// hand-over message, on made-up notes in a fake vault. If Python and the vault's
// archive-handoff.py are there, the archive pass is also compared with the script's own output
// (run on a temp copy, never on the real vault).
// Run: npm run test:handoff

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TFile, TFolder } from 'obsidian';
import {
	addToArchive,
	allChats,
	chatOfNote,
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
import { DIAGNOSTICS_FOLDER, newReportName, numbered, renameOldSystemFiles, reportBase, SYSTEM_NAMES_VERSION } from '../src/system-names';
import { localDate } from '../src/naming';
import { normalizeSettings } from '../src/migrate';
import { handoffArchive, handoffNote, type Settings } from '../src/settings';
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
	'## Waiting for me',
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
	const waiting = r.text.slice(r.text.indexOf('## Waiting for me'), r.text.indexOf('## Next up'));
	expect('three days later: one question per line, at the end of "Waiting for me"', r.flagged === 2 && waiting.includes('- [ ] Something to decide\n- [ ] Still in **Now** since 2026-11-20') && waiting.endsWith('\n\n') && waiting.includes('“Langflow pipeline running”'), waiting);
	const again = flagStale(r.text, r.seen, '2026-11-30', 3);
	expect('a flagged line is asked about once only', again.flagged === 0 && again.text === r.text);
	const changed = flagStale(r.text.replace('- Agent speed-up', '- Agent speed-up, now faster'), again.seen, '2026-11-30', 3);
	expect('a line that is gone from "Now" is forgotten, a changed line counts as new', Object.keys(changed.seen).length === 2 && Object.values(changed.seen).some((v) => v.first === '2026-11-30' && !v.flagged));
	const noWaiting = flagStale(CONTEXT.replace(/## Waiting for me\n\n- \[ \] Something to decide\n\n/, ''), { [Object.keys(seen)[0]!]: { first: '2026-11-01' } }, '2026-11-24', 3);
	expect('without a "Waiting for …" section, "## Waiting for you" is made before "Next up"', /## Waiting for you\n\n- \[ \] Still in \*\*Now\*\* since 2026-11-01[^\n]*\n\n## Next up/.test(noWaiting.text), noWaiting.text);
	const other = flagStale(CONTEXT.replace('## Waiting for me', '## Waiting for the team'), { [Object.keys(seen)[0]!]: { first: '2026-11-01' } }, '2026-11-24', 3);
	expect('any "## Waiting for <name>" section takes the question', other.text.includes('- [ ] Something to decide\n- [ ] Still in **Now**') && !other.text.includes('Waiting for you'));
	expect('a dated "Waiting for …" heading is never archived', splitOld(CONTEXT.replace('## Waiting for me', '## Waiting for you 2026-01-01'), '2026-11-24', 7).keep.includes('Something to decide'));
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
/** A vault of text files; folders come from the paths. A rename moves a file or a whole folder. */
function fakeApp(files: Map<string, string>, extraFolders: string[] = []) {
	const made = new Set<string>(extraFolders);
	let writes = 0;
	const rw = readWrite(files);
	const named = (p: string) => Object.assign(new TFile(p, { size: 0 }), { name: p.split('/').pop()! });
	const isFolder = (p: string) => made.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`));
	const folder = (p: string): TFolder => {
		const f = new TFolder(p);
		const kids = new Set<string>();
		for (const k of [...files.keys(), ...made]) {
			if (p && !k.startsWith(`${p}/`)) continue;
			const rest = p ? k.slice(p.length + 1) : k;
			kids.add(p ? `${p}/${rest.split('/')[0]}` : rest.split('/')[0]!);
		}
		f.children = [...kids].map((k) => (files.has(k) ? named(k) : new TFolder(k)));
		return f;
	};
	const get = (p: string) => (files.has(p) ? named(p) : isFolder(p) ? folder(p) : null);
	const renames: string[] = [];
	const vault = {
		getAbstractFileByPath: get,
		getRoot: () => folder(''),
		createFolder: async (p: string) => void made.add(p),
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
	const moveKey = (k: string, from: string, to: string) => (k === from || k.startsWith(`${from}/`) ? to + k.slice(from.length) : null);
	const fileManager = {
		renameFile: async (f: { path: string }, to: string) => {
			if (get(to)) throw new Error('taken ' + to);
			renames.push(`${f.path} -> ${to}`);
			for (const k of [...files.keys()]) {
				const n = moveKey(k, f.path, to);
				if (n) {
					files.set(n, files.get(k)!);
					files.delete(k);
				}
			}
			for (const k of [...made]) {
				const n = moveKey(k, f.path, to);
				if (n) {
					made.delete(k);
					made.add(n);
				}
			}
		},
	};
	return { app: { vault, fileManager } as never, writes: () => writes, renames };
}

async function vaultTests(): Promise<void> {
	const s = settings();
	s.handoff.folder = '90 System/Memory';
	const ctxPath = handoffNote(s.handoff);
	const arch = handoffArchive(s.handoff);
	expect('the note and the archive live in the handoff folder', ctxPath === '90 System/Memory/Active Context.md' && arch === '90 System/Memory/Handoff archive');
	expect('new vaults get the folder "_AI Handoff"', normalizeSettings({}).settings.handoff.folder === '_AI Handoff');
	const files = new Map<string, string>([
		[ctxPath, CONTEXT],
		['AI Chats/Claude/Chat/Plugin work.md', '## Human · x\n\nLet us build the plugin part first\n\n## Claude · y\n\nOK'],
		['AI Chats/Claude/Code/Hook work.md', '## You · x\n\nShow me the hook\n'],
		[`${arch}/2026-10.md`, '---\ntype: handoff-archive\nmonth: 2026-10\nupdated: 2026-10-31\nunread: false\n---\n\nOlder text\n'],
		[`${arch}/2026-09.md`, 'September, from the script'],
		[`${arch}/_2026-09.md`, 'September, already there'],
		[`${arch}/notes.md`, 'not a month file'],
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
	const nov = files.get(`${arch}/_2026-11.md`);
	const oct = files.get(`${arch}/_2026-10.md`);
	expect('daily: 3 entries moved, archive files written', r.found && !r.created && r.moved === 3 && r.archives.length === 2, JSON.stringify(r));
	expect('daily: a new month file starts with "_"', !!nov && nov.includes('## Old session 2026-11-10') && nov.includes('one day too old') && !files.has(`${arch}/2026-11.md`));
	expect('daily: an old month file "2026-10.md" is renamed to "_2026-10.md" and added to', !files.has(`${arch}/2026-10.md`) && !!oct && oct.startsWith('---\ntype: handoff-archive') && oct.includes('Older text') && oct.includes('- 2026-10-30 · last month'));
	expect('daily: an old month file whose "_" name is taken stays; other files are left alone', files.get(`${arch}/2026-09.md`) === 'September, from the script' && files.get(`${arch}/_2026-09.md`) === 'September, already there' && files.has(`${arch}/notes.md`));
	expect('daily: moved lines leave the note, the rest stays, the Live sessions block too', !ctx.includes('one day too old') && !ctx.includes('Old session') && ctx.includes('2026-11-23 · new thing') && ctx.includes(LIVE_START));
	expect('daily: "updated" in the note is today, last run and seen lines remembered', ctx.includes('updated: 2026-11-24') && s.handoff.lastDaily === '2026-11-24' && Object.keys(s.handoff.nowSeen).length === 2);
	const again = await dailyUpkeep(app, s.handoff, '2026-11-24');
	expect('daily: a second run moves nothing more', again.moved === 0 && files.get(ctxPath) === ctx);
	s.handoff.staleDays = 0;
	const later = await dailyUpkeep(app, s.handoff, '2026-12-30');
	expect('daily: stale check off (0) asks nothing', later.flagged === 0 && !files.get(ctxPath)!.includes('Still in **Now**'));

	// A vault without the note: the automatic run makes nothing (turning the upkeep on must not
	// make a folder before you chose one); Update now makes it with the five parts.
	const empty = new Map<string, string>();
	const n = normalizeSettings({}).settings.handoff;
	const emptyApp = fakeApp(empty);
	const auto = await dailyUpkeep(emptyApp.app, n, '2026-11-24');
	expect('daily, automatic: a missing note is not made, nothing written, the day not marked done', !auto.found && emptyApp.writes() === 0 && empty.size === 0 && n.lastDaily === undefined);
	const made = await dailyUpkeep(emptyApp.app, n, '2026-11-24', true);
	const note = empty.get('_AI Handoff/Active Context.md') ?? '';
	expect('daily: a missing note is made with the five empty parts', made.found && made.created && ['## Plan', '## Now', '## Waiting for you', '## Next up', '## Recently done (last 7 days)'].every((h) => note.includes(`\n${h}\n`)) && note.includes('created: 2026-11-24'));
	const busy = note.replace('## Now\n', '## Now\n\n- Something in progress\n');
	const asked = flagStale(busy, flagStale(busy, {}, '2026-11-01', 3).seen, '2026-11-24', 3).text;
	expect('a made note: the stale question goes under "Waiting for you"', /## Waiting for you\n\n- \[ \] Still in \*\*Now\*\* since 2026-11-01/.test(asked), asked);
	expect('a made note has nothing to archive', splitOld(note, '2026-11-24', 7).moved.length === 0);
	const blocked = fakeApp(new Map(), ['_AI Handoff/Active Context.md']);
	expect('daily: a folder where the note should be is reported, nothing written', !(await dailyUpkeep(blocked.app, n, '2026-11-24', true)).found && blocked.writes() === 0);
}

// --- System file names: "_ai-chatbridge-…", renamed once from the old names ---------------------
async function systemNameTests(): Promise<void> {
	expect('new default log is "AI Chats/_ai-chatbridge-log.md"', normalizeSettings({}).settings.logPath === 'AI Chats/_ai-chatbridge-log.md');
	expect('report names: lower case with dashes, after the log', reportBase('AI Chats/_ai-chatbridge-log.md', 'merge report', '2026-11-20 1658') === 'AI Chats/_ai-chatbridge-merge-report-2026-11-20-1658' && numbered('x', 1) === 'x.md' && numbered('x', 2) === 'x-2.md');
	expect('diagnostics folder is "AI Chats/_ai-chatbridge-diagnostics"', DIAGNOSTICS_FOLDER === 'AI Chats/_ai-chatbridge-diagnostics');
	expect('old report names map to new ones; other names do not', newReportName('AI ChatBridge merge report 2026-11-20 1658.md') === '_ai-chatbridge-merge-report-2026-11-20-1658.md' && newReportName('AI ChatBridge merge preview 2026-11-16 0927 2.md') === '_ai-chatbridge-merge-preview-2026-11-16-0927-2.md' && newReportName('AI ChatBridge log.md') === null && newReportName('My merge report 2026-11-20 1658.md') === null);

	const files = new Map<string, string>([
		['AI Chats/AI ChatBridge log.md', 'log with [[AI ChatBridge merge report 2026-11-20 1658]]'],
		['AI Chats/AI ChatBridge merge report 2026-11-20 1658.md', 'report'],
		['AI Chats/AI ChatBridge merge preview 2026-11-16 0927.md', 'preview'],
		['AI Chats/AI ChatBridge merge preview 2026-11-16 0927 2.md', 'second preview'],
		['AI Chats/_ai-chatbridge-merge-preview-2026-11-16-0927.md', 'taken already'],
		['AI Chats/AI ChatBridge diagnostics/2026-11-01 summary.md', 'diag'],
		['AI Chats/Claude/Chat/AI ChatBridge merge report 2026-11-20 1658.md', 'a chat with that name elsewhere'],
	]);
	const s = normalizeSettings({ logPath: 'AI Chats/AI ChatBridge log.md' }).settings;
	expect('an older vault has the rename still to do', (s.systemNames ?? 0) < SYSTEM_NAMES_VERSION);
	const { app, renames } = fakeApp(files);
	expect('renames run once', await renameOldSystemFiles(app, s));
	expect('the log is renamed and the setting follows', files.get('AI Chats/_ai-chatbridge-log.md')?.startsWith('log') === true && !files.has('AI Chats/AI ChatBridge log.md') && s.logPath === 'AI Chats/_ai-chatbridge-log.md');
	expect('reports next to the log are renamed, numbered ones keep their number', files.get('AI Chats/_ai-chatbridge-merge-report-2026-11-20-1658.md') === 'report' && files.get('AI Chats/_ai-chatbridge-merge-preview-2026-11-16-0927-2.md') === 'second preview');
	expect('a report whose new name is taken stays as it is', files.get('AI Chats/AI ChatBridge merge preview 2026-11-16 0927.md') === 'preview' && files.get('AI Chats/_ai-chatbridge-merge-preview-2026-11-16-0927.md') === 'taken already');
	expect('the diagnostics folder is renamed with what is in it', files.get('AI Chats/_ai-chatbridge-diagnostics/2026-11-01 summary.md') === 'diag' && !files.has('AI Chats/AI ChatBridge diagnostics/2026-11-01 summary.md'));
	expect('files elsewhere (chat notes) are never touched', files.has('AI Chats/Claude/Chat/AI ChatBridge merge report 2026-11-20 1658.md'));
	expect('renames go through Obsidian, so links follow', renames.length === 4, renames.join('; '));
	expect('the second start does nothing', s.systemNames === SYSTEM_NAMES_VERSION && !(await renameOldSystemFiles(app, s)) && renames.length === 4);

	const own = normalizeSettings({ logPath: 'Logs/My sync log.md' }).settings;
	const ownFiles = new Map([['Logs/My sync log.md', 'x']]);
	await renameOldSystemFiles(fakeApp(ownFiles).app, own);
	expect('a log you named yourself keeps its name', own.logPath === 'Logs/My sync log.md' && ownFiles.has('Logs/My sync log.md'));
	const gone = normalizeSettings({ logPath: 'AI Chats/AI ChatBridge log.md' }).settings;
	await renameOldSystemFiles(fakeApp(new Map()).app, gone);
	expect('an old log name with no file yet just points to the new name', gone.logPath === 'AI Chats/_ai-chatbridge-log.md');
	const both = normalizeSettings({ logPath: 'AI Chats/AI ChatBridge log.md' }).settings;
	const bothFiles = new Map([['AI Chats/AI ChatBridge log.md', 'old'], ['AI Chats/_ai-chatbridge-log.md', 'new']]);
	await renameOldSystemFiles(fakeApp(bothFiles).app, both);
	expect('when the new log name is taken, both stay and the log keeps its old name', both.logPath === 'AI Chats/AI ChatBridge log.md' && bothFiles.get('AI Chats/AI ChatBridge log.md') === 'old' && bothFiles.get('AI Chats/_ai-chatbridge-log.md') === 'new');

	const c = settings();
	c.chatgpt[0]!.web.codexCloudIndex = { t: { updated: hoursAgo(0.2), md: 'AI Chats/ChatGPT/Codex Cloud/Task.md', json: 't.json', synced: hoursAgo(0.1) } };
	expect('Codex cloud tasks are live sessions too', liveSessions(c, NOW, 48)[0]?.label === 'Codex cloud');
	expect('right-click: a synced chat note is found by its path, other notes are not', chatOfNote(c, 'AI Chats/Claude/Code/Hook work.md')?.label === 'Claude Code' && chatOfNote(c, 'Notes/Hook work.md') === null && chatOfNote(c, 'AI Chats/Claude/Chat/x.json') === null);
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
			const at = `${dir}/90 System/Memory/Handoff archive/`;
			const py = readFileSync(existsSync(`${at}_${month}.md`) ? `${at}_${month}.md` : `${at}${month}.md`, 'utf8');
			return addToArchive(null, month, moved.filter((m) => m.date.startsWith(month)), today, 'Active Context', '\r\n') === py;
		});
		expect('same month files as archive-handoff.py', same, months.join(', '));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

void (async () => {
	await vaultTests();
	await systemNameTests();
	await parityTests();
	console.log(failures ? `\n${failures} FAILED` : '\nAll handoff tests passed.');
	process.exit(failures ? 1 : 0);
})();
