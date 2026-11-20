// Offline test of the plan behind "Merge chat copies into one note" (src/merge.ts): which note
// stays, which merge into it, which raw files become earlier versions, and how links are rewritten.
// Run: npm run test:merge

import { TFile, type App } from 'obsidian';
import { copyKind, planMerge, plainStem, relink, rewriteLinks, type FoundNote, type KnownChat, type LinkRef } from '../src/merge';
import { canvasLinks, linksInText, rewriteCanvas } from '../src/merge-canvas';
import { canvasesLinking, fixLinks, mergeLogLine, mergeReportText, type MergeResult } from '../src/merge-run';
import { mayStartWhileMergeWaits, startMergeWhenIdle, type MergeStartHost } from '../src/merge-wait';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const C = 'AI/Claude/Chat/Recent';
const R = '80 Archive/raw/AI/Claude/Chat/Recent';
const n = (stem: string, id: string, updated: string, raw: string | null = `${R}/${stem}.json`, dir = C, mtime = 0): FoundNote => ({ path: `${dir}/${stem}.md`, id, updated, raw, mtime });

// --- names -------------------------------------------------------------------------------------
expect('kind: first note', copyKind(`${C}/2026-11-06 Trip to Lisbon.md`) === null);
expect('kind: updated', copyKind(`${C}/2026-11-06 RAM (updated 2026-11-08 2349).md`) === 'updated');
expect('kind: transcript of an updated note counts as updated', copyKind(`${C}/X (updated 2026-11-07 1951) (transcript c2e54700f268309d).md`) === 'updated');
expect('kind: transcript copy, recovered', copyKind(`${C}/X (transcript c2e54700f268309d).md`) === 'transcript' && copyKind(`${C}/X (recovered).md`) === 'recovered');
expect('kind: a title that only mentions "updated" is no copy', copyKind(`${C}/2026-11-06 Plan (updated draft).md`) === null);
expect('plain: endings stripped', plainStem('X (updated 2026-11-07 1951) (transcript c2e54700f268309d)') === 'X' && plainStem('X (recovered)') === 'X' && plainStem('X (updated 2026-11-07 1951) (1a2b3c4d) 2') === 'X');
expect('plain: a bracket in the title stays', plainStem('Trip notes (A) - Lisbon (updated 2026-11-12 1620)') === 'Trip notes (A) - Lisbon' && plainStem('Plan (v2)') === 'Plan (v2)');

// --- the plan ----------------------------------------------------------------------------------
{
	const notes: FoundNote[] = [
		// A: first note plus two updates; the history points at the newest.
		n('2026-11-06 RAM', 'a', '2026-11-06T10:00:00Z'),
		n('2026-11-06 RAM (updated 2026-11-08 2349)', 'a', '2026-11-08T22:49:00Z'),
		n('2026-11-06 RAM (updated 2026-11-09 1203)', 'a', '2026-11-09T11:03:00Z'),
		// B: ChatGPT, an update with a transcript copy; the history points at the copy.
		n('2026-11-07 Guide', 'b', '2026-11-07T17:00:00Z'),
		n('2026-11-07 Guide (transcript aaaaaaaaaaaaaaaa)', 'b', '2026-11-07T17:00:00Z', `${R}/2026-11-07 Guide.json`),
		n('2026-11-07 Guide (updated 2026-11-07 1951)', 'b', '2026-11-07T18:51:00Z'),
		n('2026-11-07 Guide (updated 2026-11-07 1951) (transcript bbbbbbbbbbbbbbbb)', 'b', '2026-11-07T18:51:00Z', `${R}/2026-11-07 Guide (updated 2026-11-07 1951).json`),
		// C: only a transcript copy. D: only a recovered note. E: one note (nothing to do).
		n('2026-11-01 Solo', 'c', '2026-11-01T10:00:00Z'),
		n('2026-11-01 Solo (transcript cccccccccccccccc)', 'c', '2026-11-01T10:00:00Z', `${R}/2026-11-01 Solo.json`),
		n('2026-11-02 Lost', 'd', '2026-11-02T10:00:00Z'),
		n('2026-11-02 Lost (recovered)', 'd', '2026-11-02T10:00:00Z'),
		n('2026-11-03 Single', 'e', '2026-11-03T10:00:00Z'),
		// F: the first note was deleted; the chat was renamed between its two updates.
		n('2026-11-04 Old title (updated 2026-11-05 0900)', 'f', '2026-11-05T08:00:00Z'),
		n('2026-11-04 New title (updated 2026-11-06 0900)', 'f', '2026-11-06T08:00:00Z'),
		// G: your own copy elsewhere carries the same ID; H: two notes, none named like a copy.
		n('2026-11-05 Mine', 'g', '2026-11-05T10:00:00Z'),
		n('2026-11-05 Mine (updated 2026-11-06 1000)', 'g', '2026-11-06T09:00:00Z'),
		n('My summary of that chat', 'g', '2026-11-05T10:00:00Z', null, 'Wiki'),
		n('Copy A', 'h', '2026-11-05T10:00:00Z'),
		n('Copy B', 'h', '2026-11-05T10:00:00Z'),
		// I: the history points at a note that is not there. J: your "(my edits …)" copy is not a member.
		n('2026-11-06 Astray', 'i', '2026-11-06T10:00:00Z'),
		n('2026-11-06 Astray (updated 2026-11-07 1000)', 'i', '2026-11-07T09:00:00Z'),
		n('2026-11-07 Edited', 'j', '2026-11-07T10:00:00Z'),
		n('2026-11-07 Edited (my edits 2026-11-08 1000)', 'j', '2026-11-07T10:00:00Z'),
		// K: a Hermes session (no raw files).
		n('2026-11-08 Garden', 'k', '2026-11-08 10:00', null, 'AI/Hermes/default'),
		n('2026-11-08 Garden (updated 2026-11-09 1100)', 'k', '2026-11-09 11:00', null, 'AI/Hermes/default'),
	];
	const known = new Map<string, KnownChat>([
		['a', { note: `${C}/2026-11-06 RAM (updated 2026-11-09 1203).md` }],
		['b', { note: `${C}/2026-11-07 Guide (updated 2026-11-07 1951) (transcript bbbbbbbbbbbbbbbb).md` }],
		['c', { note: `${C}/2026-11-01 Solo (transcript cccccccccccccccc).md` }],
		['d', { note: `${C}/2026-11-02 Lost (recovered).md` }],
		['g', { note: `${C}/2026-11-05 Mine (updated 2026-11-06 1000).md` }],
		['i', { note: `${C}/somewhere else.md` }],
		['k', { note: 'AI/Hermes/default/2026-11-08 Garden (updated 2026-11-09 1100).md', hermes: true }],
	]);
	const taken = new Set(notes.map((x) => x.path));
	const plan = planMerge(notes, known, (p) => taken.has(p));
	const g = (id: string) => plan.groups.find((x) => x.id === id);

	const a = g('a')!;
	expect('A: the first note stays and gets the newest text', a.kind === 'updated' && a.target === `${C}/2026-11-06 RAM.md` && a.targetExists && a.newest === `${C}/2026-11-06 RAM (updated 2026-11-09 1203).md`);
	expect('A: both updates merge away', a.remove.length === 2 && a.remove.every((p) => p.includes('(updated')));
	expect('A: raw files: newest is the main one under the first name, two earlier versions oldest first', a.mainRaw === `${R}/2026-11-06 RAM (updated 2026-11-09 1203).json` && a.targetRaw === `${R}/2026-11-06 RAM.json` && a.olderRaws.map((o) => o.at).join() === '2026-11-06T10:00:00Z,2026-11-08T22:49:00Z' && a.olderRaws[0]!.path === `${R}/2026-11-06 RAM.json`);

	const b = g('b')!;
	expect('B: transcript copies go with their notes; a shared raw file counts once', b.kind === 'updated' && b.remove.length === 3 && b.newest.endsWith('(transcript bbbbbbbbbbbbbbbb).md') && b.olderRaws.length === 1 && b.olderRaws[0]!.path === `${R}/2026-11-07 Guide.json` && b.mainRaw === `${R}/2026-11-07 Guide (updated 2026-11-07 1951).json`);
	expect('C, D: their own kinds, so the preview can leave them out', g('c')!.kind === 'transcript' && g('c')!.olderRaws.length === 0 && g('c')!.targetRaw === `${R}/2026-11-01 Solo.json` && g('d')!.kind === 'recovered');
	expect('E: a chat with one note is not listed', !g('e'));

	const f = g('f')!;
	expect('F: first note gone -> the newest name without its ending, as a new note', !f.targetExists && f.target === `${C}/2026-11-04 New title.md` && f.remove.length === 2 && f.notes.some((x) => x.includes('not in the sync history')));
	taken.add(`${C}/2026-11-04 New title.md`);
	const f2 = planMerge(notes, known, (p) => taken.has(p)).groups.find((x) => x.id === 'f')!;
	expect('F: that name taken by another file -> the newest keeps its name', f2.target === f2.newest && f2.remove.length === 1 && f2.notes.some((x) => x.includes('is taken')));

	const gg = g('g')!;
	expect('G: a second note without a copy ending is left alone, and said so', gg.target === `${C}/2026-11-05 Mine.md` && gg.remove.length === 1 && !gg.remove.includes('Wiki/My summary of that chat.md') && gg.notes.some((x) => x.includes('Wiki/My summary of that chat.md')));
	expect('H: same ID, no copy names -> not touched at all', !g('h') && !plan.skipped.some((s) => s.id === 'h'));
	expect('I: history points elsewhere -> skipped with the reason', !g('i') && plan.skipped.some((s) => s.id === 'i' && s.reason.includes('Refresh index')));
	expect('J: "(my edits …)" is yours -> never merged', !g('j'));
	const k = g('k')!;
	expect('K: Hermes keeps the old note text instead of a raw file', k.olderNotes.length === 1 && k.olderNotes[0]!.path.endsWith('2026-11-08 Garden.md') && k.mainRaw === null && k.targetRaw === null && !k.notes.some((x) => x.includes('no raw file')));
}

// --- links -------------------------------------------------------------------------------------
{
	expect('link: plain wikilink', relink('[[2026-11-06 RAM (updated 2026-11-08 2349)]]', '2026-11-06 RAM') === '[[2026-11-06 RAM]]');
	expect('link: alias, heading and embed stay', relink('![[Old (updated 2026-11-08 2349)#Human · 2026-11-06 10:00|that chat]]', 'Old') === '![[Old#Human · 2026-11-06 10:00|that chat]]');
	expect('link: written with a path', relink('[[AI/Claude/Chat/Recent/Old (updated 2026-11-08 2349).md|x]]', 'AI/Claude/Chat/Recent/Old') === '[[AI/Claude/Chat/Recent/Old|x]]');
	expect('link: Markdown style', relink('[that chat](Old%20(updated%202026-11-08%202349).md#top)', 'AI/Chat/Old note') === '[that chat](AI/Chat/Old%20note.md#top)' && relink('[img](<a b.png>)', 'c d.png') === '[img](<c d.png>)');
	expect('link: unknown form -> not guessed', relink('<a href="Old.md">x</a>', 'Old') === null);

	const text = 'See [[Old (updated 2026-11-08 2349)]] and again [[Old (updated 2026-11-08 2349)|here]], plus [[Other]] and [[Old (updated 2026-11-09 1203)#H]].';
	const out = rewriteLinks(text, [
		{ original: '[[Old (updated 2026-11-08 2349)]]', from: 'a.md' },
		{ original: '[[Old (updated 2026-11-08 2349)|here]]', from: 'a.md' },
		{ original: '[[Old (updated 2026-11-09 1203)#H]]', from: 'b.md' },
		{ original: '[[Gone already]]', from: 'a.md' },
		{ original: '<odd>', from: 'a.md' },
	], (from) => (from === 'a.md' || from === 'b.md' ? 'Old' : null));
	expect('rewrite: every link to a merged note, others untouched', out.text === 'See [[Old]] and again [[Old|here]], plus [[Other]] and [[Old#H]].' && out.changed === 3, out.text);
	expect('rewrite: a form not understood is reported', out.failed.length === 1 && out.failed[0]!.original === '<odd>');
}

// --- canvases ----------------------------------------------------------------------------------
const canvasTests = (async () => {
	const OLD = `${C}/Old (updated 2026-11-08 2349).md`;
	const NEW = `${C}/Old.md`;
	const OTHER = `${C}/Other.md`;
	const canvasJson = (nodes: unknown[], edges: unknown[] = []): string => JSON.stringify({ nodes, edges }, null, '\t');
	const board = canvasJson(
		[
			{ id: 'a1', type: 'file', file: OLD, x: 0, y: 0, width: 400, height: 400, color: '4' },
			{ id: 'a2', type: 'file', file: OLD, subpath: '#Human · 2026-11-06 10:00', x: 500, y: 0, width: 400, height: 400 },
			{ id: 'a3', type: 'text', text: 'See [[Old (updated 2026-11-08 2349)|that chat]] and ![[Old (updated 2026-11-08 2349)#H]], not [[Other]] nor [web](https://x.y/Old).', x: 0, y: 500, width: 300, height: 200, styleAttributes: {} },
			{ id: 'a4', type: 'file', file: OTHER, x: 900, y: 0, width: 400, height: 400 },
			{ id: 'a5', type: 'group', label: 'Chats', x: -50, y: -50, width: 1500, height: 900 },
			{ id: 'a6', type: 'link', url: 'https://example.org', x: 0, y: 900, width: 400, height: 200 },
		],
		[{ id: 'e1', fromNode: 'a1', fromSide: 'right', toNode: 'a2', toSide: 'left', label: 'then' }],
	);
	const resolve = (lp: string): string | null => (lp === 'Old (updated 2026-11-08 2349)' ? OLD : lp === 'Other' ? OTHER : null);
	const targets = new Set([OLD]);

	expect('canvas: links in text, web links skipped', linksInText('[[A|x]] ![[B#h]] [c](C%20d.md#t) [w](https://x) [o](obsidian://open)').map((l) => l.linkpath).join() === 'A,B,C d.md');
	const refs = canvasLinks(board, targets, resolve)!;
	expect('canvas: file nodes (with and without subpath) and text links found', refs.filter((x) => x.kind === 'file').length === 2 && refs.filter((x) => x.kind === 'text').length === 2 && refs.every((x) => x.from === OLD), JSON.stringify(refs));
	expect('canvas: no link to a merged note -> nothing found', canvasLinks(board, new Set([`${C}/Unrelated.md`]), resolve)!.length === 0);
	expect('canvas: broken JSON or not JSON Canvas -> null', canvasLinks('{"nodes": [', targets, resolve) === null && canvasLinks('[1,2]', targets, resolve) === null && canvasLinks('{"nodes": {}}', targets, resolve) === null && rewriteCanvas('{"nodes": [', refs, () => NEW, () => 'Old') === null);

	const out = rewriteCanvas(board, refs, (from) => (from === OLD ? NEW : null), (from) => (from === OLD ? 'Old' : null))!;
	const parsed = JSON.parse(out.text) as { nodes: Record<string, unknown>[]; edges: unknown[] };
	const before = JSON.parse(board) as { nodes: Record<string, unknown>[]; edges: unknown[] };
	expect('canvas: file node points at the note that stays', parsed.nodes[0]!.file === NEW && parsed.nodes[0]!.color === '4');
	expect('canvas: file node keeps its subpath', parsed.nodes[1]!.file === NEW && parsed.nodes[1]!.subpath === '#Human · 2026-11-06 10:00');
	expect('canvas: text node: alias and embed heading kept, other links untouched', parsed.nodes[2]!.text === 'See [[Old|that chat]] and ![[Old#H]], not [[Other]] nor [web](https://x.y/Old).', String(parsed.nodes[2]!.text));
	expect('canvas: 4 links counted', out.changed === 4 && out.failed.length === 0, String(out.changed));
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	expect('canvas: everything else unchanged (other nodes, ids, order, keys, edges)', same(parsed.nodes.slice(3), before.nodes.slice(3)) && same(parsed.edges, before.edges) && parsed.nodes.map((x) => x.id).join() === 'a1,a2,a3,a4,a5,a6' && same(Object.keys(parsed.nodes[2]!), Object.keys(before.nodes[2]!)));
	expect('canvas: written with tabs, as before', out.text === JSON.stringify(parsed, null, '\t'));
	const unchanged = rewriteCanvas(board, [], () => NEW, () => 'Old')!;
	expect('canvas: nothing to change -> same text back, byte for byte', unchanged.text === board && unchanged.changed === 0);
	const missing = rewriteCanvas(board, refs, () => null, () => null)!;
	expect('canvas: a link whose new file is missing is reported, not changed', missing.changed === 0 && missing.text === board && missing.failed.length === 3, String(missing.failed.length));
	const spaced = '{\n  "nodes": [{"id":"b","type":"file","file":"' + OLD + '"}]\n}\n';
	expect('canvas: two-space indentation and the last line break kept', rewriteCanvas(spaced, canvasLinks(spaced, targets, resolve)!, () => NEW, () => 'Old')!.text === JSON.stringify({ nodes: [{ id: 'b', type: 'file', file: NEW }] }, null, 2) + '\n');

	// The merge run itself (step 4), against a fake vault.
	const ART = `${C}/Artifacts/Old (updated 2026-11-08 2349)/board.canvas`;
	const ART_TO = `${C}/Artifacts/Old/board.canvas`;
	const files = new Map<string, string>([
		[NEW, 'note'],
		[OTHER, 'other'],
		[`${C}/board.canvas`, board],
		[ART_TO, board], // a canvas saved with the chat, already moved by step 2
		[`${C}/unrelated.canvas`, canvasJson([{ id: 'u', type: 'file', file: OTHER, x: 0, y: 0, width: 1, height: 1 }])],
		[`${C}/broken.canvas`, '{"nodes": [ {"id": "x", "type": "file", "file": "' + OLD + '"'],
		[`${C}/drawing.excalidraw`, '{"type":"excalidraw"}'],
		[`${C}/changed since.canvas`, '{"nodes": oops'],
	]);
	let writes = 0;
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : null),
			read: async (f: TFile) => files.get(f.path)!,
			process: async (f: TFile, fn: (t: string) => string) => {
				const next = fn(files.get(f.path)!);
				if (next !== files.get(f.path)) writes++;
				files.set(f.path, next);
				return next;
			},
		},
		metadataCache: {
			resolvedLinks: {} as Record<string, Record<string, number>>,
			getFirstLinkpathDest: (lp: string) => {
				const p = resolve(lp);
				return p ? new TFile(p, { size: 0 }) : null;
			},
			fileToLinktext: (f: TFile) => f.path.split('/').pop()!.replace(/\.md$/, ''),
		},
	} as unknown as App;

	const canvases = [...files].filter(([p]) => p.endsWith('.canvas') && p !== ART_TO).map(([path, text]) => ({ path, text }));
	canvases.push({ path: ART, text: board });
	const found = canvasesLinking(app, targets, canvases);
	expect('canvas preview: linking canvases found, the unrelated one not, the broken one naming the note listed to report', found.get(`${C}/board.canvas`)?.length === 4 && found.get(ART)?.length === 4 && !found.has(`${C}/unrelated.canvas`) && found.get(`${C}/broken.canvas`)?.length === 0 && !found.has(`${C}/changed since.canvas`), [...found.keys()].join(' | '));

	const unrelatedBefore = files.get(`${C}/unrelated.canvas`);
	const links = new Map<string, LinkRef[]>([
		[`${C}/board.canvas`, found.get(`${C}/board.canvas`)!],
		[ART, found.get(ART)!],
		[`${C}/broken.canvas`, []],
		[`${C}/drawing.excalidraw`, []],
		[`${C}/changed since.canvas`, found.get(`${C}/board.canvas`)!], // read fine for the preview, broken by now
	]);
	const r = { linksFixed: 0, linksLeft: [] as string[] };
	await fixLinks(app, links, new Map([[ART, ART_TO]]), (from) => (from === OLD ? NEW : from), [OLD], r);
	const fixed = (p: string) => JSON.parse(files.get(p)!) as { nodes: Record<string, unknown>[] };
	expect('merge: canvas file nodes and text links rewritten', fixed(`${C}/board.canvas`).nodes[0]!.file === NEW && fixed(`${C}/board.canvas`).nodes[1]!.subpath === '#Human · 2026-11-06 10:00' && String(fixed(`${C}/board.canvas`).nodes[2]!.text).startsWith('See [[Old|that chat]] and ![[Old#H]]'));
	expect('merge: a canvas that moved with the chat is rewritten at its new place', fixed(ART_TO).nodes[0]!.file === NEW && !files.has(ART));
	expect('merge: links counted, two canvases written', r.linksFixed === 8 && writes === 2, `${r.linksFixed} fixed, ${writes} writes`);
	expect('merge: a canvas with no matching link stays byte for byte', files.get(`${C}/unrelated.canvas`) === unrelatedBefore);
	expect('merge: broken canvases and other non-note files reported, unchanged', r.linksLeft.length === 3 && r.linksLeft.some((l) => l.startsWith(`${C}/broken.canvas`) && l.includes('a canvas that could not be read')) && r.linksLeft.some((l) => l.startsWith(`${C}/drawing.excalidraw`) && l.includes('not a note')) && r.linksLeft.some((l) => l.startsWith(`${C}/changed since.canvas`)) && files.get(`${C}/changed since.canvas`) === '{"nodes": oops', r.linksLeft.join(' | '));
})();

// --- a merge pressed while a sync runs waits for it -------------------------------------------
const waitTests = (async () => {
	// A fake plugin: `syncs` is how many syncs are still to end before the merge's turn.
	const host = (o: { syncs?: number; refuse?: boolean; unloadWhileWaiting?: boolean; slipIn?: number }) => {
		const log: string[] = [];
		let running = (o.syncs ?? 0) > 0;
		let left = o.syncs ?? 0;
		let slip = o.slipIn ?? 0;
		let unloaded = false;
		const h: MergeStartHost = {
			running: () => running,
			unloaded: () => unloaded,
			waiting: () => log.push('waiting notice'),
			idle: async () => {
				log.push('waited');
				if (o.unloadWhileWaiting) unloaded = true;
				left--;
				running = left > 0;
			},
			start: async () => {
				if (slip > 0) {
					// A sync started by hand got in first: the merge must wait for that one too.
					slip--;
					running = true;
					left = 1;
					log.push('slipped in');
					return false;
				}
				if (o.refuse) return false;
				log.push('merged');
				return true;
			},
		};
		return { h, log };
	};
	{
		const { h, log } = host({});
		expect('merge wait: idle, starts at once with no waiting notice', (await startMergeWhenIdle(h)) && log.join(',') === 'merged', log.join(','));
	}
	{
		const { h, log } = host({ syncs: 1 });
		expect('merge wait: a running sync, one notice, then starts by itself', (await startMergeWhenIdle(h)) && log.join(',') === 'waiting notice,waited,merged', log.join(','));
	}
	{
		const { h, log } = host({ syncs: 2 });
		expect('merge wait: still one notice when it waits twice', (await startMergeWhenIdle(h)) && log.filter((l) => l === 'waiting notice').length === 1 && log.at(-1) === 'merged', log.join(','));
	}
	{
		const { h, log } = host({ syncs: 1, slipIn: 1 });
		expect('merge wait: a sync started by hand in between is waited for too', (await startMergeWhenIdle(h)) && log.join(',') === 'waiting notice,waited,slipped in,waited,merged', log.join(','));
	}
	{
		const { h, log } = host({ syncs: 1, refuse: true });
		expect('merge wait: refused (another computer, you said wait) gives false', !(await startMergeWhenIdle(h)) && !log.includes('merged'), log.join(','));
	}
	{
		const { h, log } = host({ syncs: 1, unloadWhileWaiting: true });
		expect('merge wait: unloaded while waiting gives false, nothing merged', !(await startMergeWhenIdle(h)) && !log.includes('merged'), log.join(','));
	}
	{
		const { h } = host({ syncs: 1, slipIn: 1000 });
		expect('merge wait: gives up rather than wait for ever', !(await startMergeWhenIdle(h)));
	}
	expect('merge wait: automatic, retry and remote syncs wait; a sync by hand may go', !mayStartWhileMergeWaits('auto', true) && !mayStartWhileMergeWaits('resume', true) && mayStartWhileMergeWaits('manual', true) && mayStartWhileMergeWaits('auto', false));

	// --- a stopped merge says where in the report and the log line ---
	const r: MergeResult = { merged: 12, notesTrashed: 30, versionsKept: 4, linksFixed: 7, filesMoved: 0, linksLeft: [], left: ['stopped after 12 of 111 chats; run the command again for the rest'], failed: [], stopped: 'after 12 of 111 chats' };
	expect('stopped merge: log line names where', mergeLogLine(r).includes('stopped after 12 of 111 chats') && mergeLogLine(r).startsWith('**Merged chat copies:** 12 chats'), mergeLogLine(r));
	expect('stopped merge: report starts with where it stopped', mergeReportText([], [], r).startsWith('**Stopped after 12 of 111 chats.**'));
	expect('finished merge: no stop in the log line', !mergeLogLine({ ...r, stopped: undefined }).includes('stopped'));
})();

void Promise.all([canvasTests, waitTests]).then(() => {
	console.log(failures ? `\n${failures} FAILED` : '\nAll merge tests passed.');
	process.exit(failures ? 1 : 0);
});
