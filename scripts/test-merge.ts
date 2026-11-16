// Offline test of the plan behind "Merge chat copies into one note" (src/merge.ts): which note
// stays, which merge into it, which raw files become earlier versions, and how links are rewritten.
// Run: npm run test:merge

import { copyKind, planMerge, plainStem, relink, rewriteLinks, type FoundNote, type KnownChat } from '../src/merge';

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

console.log(failures ? `\n${failures} FAILED` : '\nAll merge tests passed.');
process.exit(failures ? 1 : 0);
