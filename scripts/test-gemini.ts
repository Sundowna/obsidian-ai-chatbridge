// Offline test of the Gemini and AI Studio readers. The samples are made up, but shaped like
// the live replies seen on 2026-11-10 (positions only, no real chat content).
// Run: npm run test:gemini

import { batchPayload, buildChat, GeminiError, readChatPage, readListPage, readTurn } from '../src/gemini/wire';
import { generatedAsLinks, imagesAsLinks, renderGeminiTranscript, renderStudioTranscript } from '../src/gemini/transcript';
import { promptFileId, readPrompt, readPromptList } from '../src/studio/wire';
import { normalizeSettings } from '../src/migrate';
import { ShapeError } from '../src/schema';
import { TFile } from 'obsidian';
import { emptyResult, fileGone, geminiFromRaw, googleAccountId, SAME_GOOGLE_LOGIN, sameGoogleLogin, saveChats, studioFromRaw, type Saved } from '../src/gemini/save';
import type { GeminiChat, StudioPrompt } from '../src/gemini/types';
import { MassMissingError } from '../src/missing-guard';
import { tagAccount } from '../src/naming';
import type { IndexEntry, ListItem } from '../src/types';
import { noteHash } from '../src/versions';
import { readWrite } from './fake-vault';
import { GeminiApi } from '../src/gemini/api';
import { StudioApi } from '../src/studio/api';
import { FULL_LIST_EVERY, listFailed, readList, type ListHolder } from '../src/quick-list';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
function throws(label: string, fn: () => unknown, kind: new (...a: never[]) => Error) {
	try {
		fn();
		expect(label, false, 'did not throw');
	} catch (e) {
		expect(label, e instanceof kind, e instanceof Error ? e.message : String(e));
	}
}

/** A batchexecute reply around one payload, the way Google frames it. */
function reply(rpcId: string, payload: unknown): string {
	const row = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic'], ['di', 109], ['af.httprm', 109, '1', 4]]);
	return `)]}'\n\n${row.length}\n${row}\n25\n[["e",4,null,null,740]]\n`;
}

const at = (sec: number) => [sec, 153005000];

function turn(rid: string, sec: number, prompt: string, answer: string, extra: { reasoning?: string; drafts?: number } = {}): unknown[] {
	const cand = (id: string, text: string) => {
		const c: unknown[] = [id, [text], [null, null, null, null, [null, null, 7]]];
		if (extra.reasoning) c[37] = [[extra.reasoning]];
		return c;
	};
	const cands = [cand('rc_aaa', answer), ...Array.from({ length: extra.drafts ?? 0 }, (_, i) => cand(`rc_x${i}`, 'other'))];
	const answers: unknown[] = [cands, null, null, 'rc_aaa'];
	answers[21] = '3.6 Flash';
	return [['c_421ec87547ddea3f', rid], null, [[prompt], 1, null, 1, 'cf41b0e0dd7d53e5', 0], answers, at(sec)];
}

/** A vault that is a Map of path -> text, with the calls the save loop makes. */
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

/** The save loop Gemini and AI Studio share, on a fake vault. */
async function saveLoop() {
	const { settings } = normalizeSettings({});
	settings.maxChatsPerRun = 2;
	const { files, vault } = fakeVault();
	const plugin = { app: { vault, fileManager: { processFrontMatter: async () => undefined } }, settings, saveSettings: async () => undefined } as never;
	const index: Record<string, IndexEntry> = {};
	const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}T10:00:00.000Z`;
	const chatOf = (item: ListItem, answer: string): GeminiChat => ({ id: item.uuid, title: item.name, createdAt: item.created_at, updatedAt: item.updated_at, turns: [{ rid: 'r1', createdAt: item.created_at, prompt: `Question of ${item.name}`, answer }], raw: [] } as unknown as GeminiChat);
	const items: ListItem[] = [1, 2, 3].map((n) => ({ uuid: `c_${n}`, name: `Chat ${n}`, created_at: day(n), updated_at: day(n) }));
	let reads: string[] = [];
	let answer = 'First answer.';
	const refuse = new Set<string>();
	const read = async (item: ListItem): Promise<Saved | null> => {
		reads.push(item.uuid);
		if (refuse.has(item.uuid)) return null;
		const chat = chatOf(item, answer);
		return { createdAt: chat.createdAt, json: JSON.stringify(chat, null, '\t'), md: (link) => tagAccount(renderGeminiTranscript(chat, link), 'Main') };
	};
	const run = async (list = items, idx = index) => {
		reads = [];
		const r = emptyResult();
		await saveChats(plugin, list, idx, 'G/Chat', 'Raw/G', read, () => undefined, r, { label: 'Gemini chats', fromRaw: geminiFromRaw('Main') });
		return r;
	};
	const notes = () => [...files.keys()].filter((p) => p.endsWith('.md'));

	// Max chats per run: the two newest first, the third left for the next run.
	const r1 = await run();
	expect('loop: two newest saved, one left for next run', r1.newCount === 2 && r1.leftForLater === 1 && reads.join() === 'c_3,c_2' && notes().length === 2, JSON.stringify({ ...r1, reads }));
	const three = index.c_3!;
	expect('loop: note and raw file where the settings say', three.md.startsWith('G/Chat/2026-03-03 Chat 3') && three.json.startsWith('Raw/G/') && files.has(three.md) && files.has(three.json), `${three.md} | ${three.json}`);
	expect('loop: note has the account, the raw link and the text', files.get(three.md)!.includes('account: "Main"') && files.get(three.md)!.includes(`raw: "[[${three.json}]]"`) && files.get(three.md)!.includes('First answer.'), files.get(three.md)!.slice(0, 200));
	const r2 = await run();
	expect('loop: the next run saves the one left over', r2.newCount === 1 && r2.unchanged === 2 && r2.leftForLater === 0 && reads.join() === 'c_1');
	const r3 = await run();
	expect('loop: unchanged chats are not read again', r3.unchanged === 3 && !reads.length && !r3.written.length);

	// A chat that goes on: same note, the earlier raw file kept as a version.
	const rawBefore = files.get(three.json)!;
	answer = 'Second answer.';
	const later = items.map((it) => (it.uuid === 'c_3' ? { ...it, updated_at: day(9) } : it));
	const r4 = await run(later);
	const kept = index.c_3!.versions?.[0]?.files[0] ?? '';
	expect('loop: changed chat keeps its one note', r4.changedCount === 1 && index.c_3!.md === three.md && notes().length === 3 && files.get(three.md)!.includes('Second answer.'), notes().join(', '));
	expect('loop: earlier raw file kept and named in the note', files.get(kept) === rawBefore && files.get(three.md)!.includes('earlier_versions: 1'), kept);

	// A deleted note is written again from its raw file: no request, same name, same text,
	// and it does not use up the per-run limit.
	const noteBefore = files.get(three.md)!;
	files.delete(three.md);
	settings.maxChatsPerRun = 1;
	const r5 = await run(later);
	expect('restore: deleted note rebuilt from the raw file without a request', r5.restored.length === 1 && !reads.length && files.get(three.md) === noteBefore && r5.unchanged === 2 && r5.leftForLater === 0, JSON.stringify({ ...r5, reads }));
	expect('restore: the rebuilt note counts as unedited', index.c_3!.noteHash === noteHash(noteBefore));
	const r5b = await run(later);
	expect('restore: nothing more to do on the next run', r5b.unchanged === 3 && !r5b.restored.length && !reads.length);

	// Raw file gone too, or not readable as this chat: fetched again under the same names.
	files.delete(three.md);
	files.delete(three.json);
	const r6 = await run(later);
	expect('restore: note and raw file gone -> fetched again under the same names', r6.restored.length === 1 && reads.join() === 'c_3' && files.has(three.md) && files.has(three.json));
	files.delete(three.md);
	files.set(three.json, '{"id":"another chat","turns":[]}');
	const r7 = await run(later);
	expect('restore: a raw file of another chat is not used, the chat is fetched', r7.restored.length === 1 && reads.join() === 'c_3' && files.get(three.md)!.includes('Second answer.'));
	files.delete(three.md);
	files.set(three.json, 'not json');
	const r8 = await run(later);
	expect('restore: a damaged raw file is not used, the chat is fetched', r8.restored.length === 1 && reads.join() === 'c_3' && files.get(three.json)!.includes('"turns"'));

	// A chat that cannot be read is named and tried again next run.
	refuse.add('c_4');
	const four: ListItem = { uuid: 'c_4', name: 'Chat 4', created_at: day(4), updated_at: day(4) };
	const r9 = await run([...later, four]);
	expect('loop: unreadable chat named, nothing saved for it', r9.failed.join() === 'Chat 4' && !index.c_4 && r9.newCount === 0);

	// AI Studio: the same loop, its own note text.
	const sIndex: Record<string, IndexEntry> = {};
	const sItem: ListItem = { uuid: 'prompts/abc', name: 'Prompt', created_at: day(5), updated_at: day(5) };
	const sRead = async (item: ListItem): Promise<Saved | null> => {
		reads.push(item.uuid);
		const p: StudioPrompt = { id: item.uuid, title: item.name, updatedAt: item.updated_at, messages: [{ role: 'user', text: 'Studio question' }, { role: 'model', text: 'Studio answer.' }], raw: null };
		return { createdAt: p.updatedAt, json: JSON.stringify(p, null, '\t'), md: (link) => tagAccount(renderStudioTranscript(p, link), 'Main') };
	};
	const sRun = async () => {
		reads = [];
		const r = emptyResult();
		await saveChats(plugin, [sItem], sIndex, 'G/AI Studio', 'Raw/S', sRead, () => undefined, r, { label: 'AI Studio prompts', fromRaw: studioFromRaw('Main') });
		return r;
	};
	const s1 = await sRun();
	const sPath = sIndex['prompts/abc']!.md;
	const sNote = files.get(sPath)!;
	files.delete(sPath);
	const s2 = await sRun();
	expect('AI Studio: saved, then a deleted note rebuilt from the raw file without a request', s1.newCount === 1 && s2.restored.length === 1 && !reads.length && files.get(sPath) === sNote && sNote.includes('Studio answer.'), JSON.stringify({ s1, s2, reads }));

	// Pinned at Google later, then unpinned: only that property changes in the note, no request.
	const pIndex: Record<string, IndexEntry> = {};
	const pins = new Set<string>();
	const pItem: ListItem = { uuid: 'c_pin', name: 'Pin me', created_at: day(6), updated_at: day(6) };
	const pRun = async () => {
		reads = [];
		const r = emptyResult();
		await saveChats(plugin, [pItem], pIndex, 'G/Chat', 'Raw/G', read, () => undefined, r, { label: 'Gemini chats', fromRaw: geminiFromRaw('Main'), flag: { key: 'pinned', of: (it) => pins.has(it.uuid) } });
		return r;
	};
	await pRun();
	const pMd = pIndex.c_pin!.md;
	const unpinned = files.get(pMd)!;
	pins.add('c_pin');
	const p1 = await pRun();
	expect('pinned: a later pin is written into the note without a request', p1.flagChanges === 1 && !reads.length && p1.unchanged === 1 && files.get(pMd)!.includes('\npinned: true\nraw:') && files.get(pMd)!.split('---').slice(2).join('---') === unpinned.split('---').slice(2).join('---'), files.get(pMd)!.slice(0, 200));
	const p2 = await pRun();
	expect('pinned: nothing more to do while it stays pinned', p2.flagChanges === 0 && !reads.length);
	pins.clear();
	const p3 = await pRun();
	expect('pinned: an unpin takes the property out again', p3.flagChanges === 1 && !reads.length && files.get(pMd) === unpinned, files.get(pMd)!.slice(0, 200));

	// A chat that goes on and was unpinned meanwhile must not keep the old property.
	pins.add('c_pin');
	await pRun();
	const laterPin = { ...pItem, updated_at: day(8) };
	pins.clear();
	reads = [];
	const pr = emptyResult();
	await saveChats(plugin, [laterPin], pIndex, 'G/Chat', 'Raw/G', read, () => undefined, pr, { label: 'Gemini chats', fromRaw: geminiFromRaw('Main'), flag: { key: 'pinned', of: (it) => pins.has(it.uuid) } });
	expect('pinned: a chat that changed and was unpinned loses the property', pr.changedCount === 1 && !files.get(pMd)!.split('---')[1]!.includes('pinned'), files.get(pMd)!.split('---')[1]);

	// Safety stop: many saved chats missing stops before anything is read or written.
	settings.maxChatsPerRun = 0;
	const many: ListItem[] = Array.from({ length: 12 }, (_, i) => ({ uuid: `m_${i}`, name: `Many ${i}`, created_at: day(i + 1), updated_at: day(i + 1) }));
	const mIndex: Record<string, IndexEntry> = {};
	await run(many, mIndex);
	for (const e of Object.values(mIndex).slice(0, 9)) files.delete(e.md);
	const few = await run(many, mIndex);
	expect('guard: nine missing notes are still restored', few.restored.length === 9);
	for (const e of Object.values(mIndex).slice(0, 10)) files.delete(e.md);
	const count = files.size;
	let stop = '';
	try {
		await run(many, mIndex);
	} catch (e) {
		stop = e instanceof MassMissingError ? e.message : `other: ${String(e)}`;
	}
	expect('guard: ten of twelve missing stops the sync, nothing read or written', stop.startsWith('10 of 12 saved Gemini chats are not where the sync history says') && !reads.length && files.size === count, stop);
}

// --- quick list for Gemini and AI Studio (quick-list.ts) ---------------------------------

type GeminiCalls = { call: (rpcId: string, args: unknown[]) => Promise<unknown> };
type StudioCalls = { call: (method: string, body: unknown[]) => Promise<unknown> };
type Bare<T> = new (page: unknown, source: unknown) => T;

async function quickLists() {
	const none = async () => undefined;
	const sec = (dayNo: number) => 1767225600 + dayNo * 86400; // 2026-01-01 plus days
	const gid = (n: number) => `c_${n.toString(16).padStart(8, '0')}`;
	const sid = (n: number) => `prompts/quick-list-${String(n).padStart(4, '0')}`;

	// Gemini as Google hands it out: two pinned chats in a list of their own, 120 others, newest activity first, 50 a page.
	let pinned = [{ id: gid(901), at: 20 }, { id: gid(902), at: 10 }];
	let rest = Array.from({ length: 120 }, (_, i) => ({ id: gid(120 - i), at: 120 - i }));
	let gCalls: string[] = [];
	const gemini = new (GeminiApi as unknown as Bare<GeminiApi>)(null, null);
	(gemini as unknown as GeminiCalls).call = async (_rpc, args) => {
		const isPinned = (args[2] as number[])[0] === 1;
		const from = args[1] ? Number(args[1]) : 0;
		const rows = isPinned ? pinned : rest;
		gCalls.push(`${isPinned ? 'pinned' : 'rest'}@${from}`);
		return [null, from + 50 < rows.length ? String(from + 50) : null, rows.slice(from, from + 50).map((r) => [r.id, `Chat ${r.id}`, null, null, null, [sec(r.at), 0]])];
	};
	const g: ListHolder = {};
	const readG = async (fileGone = false, now = 1_000_000) => {
		gCalls = [];
		const r = await readList(g, { scope: 'chats', fileGone, now, wholeSecond: true }, (settled) => gemini.listChats(none, () => undefined, settled));
		return { ...r, items: r.rows.map((row) => ({ ...row.item, pinned: row.archived !== false })) };
	};
	const g1 = await readG();
	expect('Gemini quick list: the first read takes every page of both lists and remembers them', gCalls.join() === 'pinned@0,rest@0,rest@50,rest@100' && !g1.quick && g1.changed && g1.items.length === 122 && g.listCatalog!.ordered && g.listCatalog!.fullAt === 1_000_000, gCalls.join());
	expect('Gemini quick list: pinned chats are still marked', g1.items.filter((it) => it.pinned).map((it) => it.uuid).join() === `${gid(901)},${gid(902)}`);
	const g2 = await readG();
	expect('Gemini quick list: nothing new, one page of each list, every chat still there', gCalls.join() === 'pinned@0,rest@0' && g2.quick && !g2.changed && g2.items.length === 122 && g2.items.filter((it) => it.pinned).length === 2, gCalls.join());

	// An old chat (third page) goes on: Google moves it to the top.
	const old = rest.splice(110, 1)[0]!;
	rest.unshift({ id: old.id, at: 200 });
	const g3 = await readG();
	expect('Gemini quick list: an old chat that goes on is found; reading stops one page later', gCalls.join() === 'pinned@0,rest@0,rest@50' && g3.changed && g3.items.length === 122 && g3.items[2]!.uuid === old.id && g3.items[2]!.updated_at === new Date(sec(200) * 1000).toISOString(), gCalls.join());

	// Unpinned on gemini.google.com: the chat leaves the short pinned list. That shows at once.
	pinned = pinned.filter((p) => p.id !== gid(902));
	rest.splice(115, 0, { id: gid(902), at: 10 });
	const g4 = await readG();
	expect('Gemini quick list: an unpinned chat is known at the same sync, without a full read', gCalls.join() === 'pinned@0,rest@0' && g4.changed && g4.items.length === 122 && g4.items.find((it) => it.uuid === gid(902))!.pinned === false && g4.items.find((it) => it.uuid === gid(901))!.pinned === true, gCalls.join());
	// Pinned on gemini.google.com: the chat shows up in the pinned list.
	pinned.push({ id: gid(5), at: 5 });
	rest = rest.filter((r) => r.id !== gid(5));
	const g5 = await readG();
	expect('Gemini quick list: a newly pinned chat is marked at the same sync', g5.items.find((it) => it.uuid === gid(5))!.pinned === true && g5.items.length === 122 && g5.changed, gCalls.join());

	const g6 = await readG(true);
	expect('Gemini quick list: a missing note or raw file means a full read', gCalls.length === 4 && !g6.quick, gCalls.join());
	expect('Gemini quick list: a failed run means a full read next time, a second failure changes nothing more', listFailed(g) && !listFailed(g) && g.listCatalog!.stale === true);
	await readG();
	expect('Gemini quick list: that full read clears the mark', gCalls.length === 4 && g.listCatalog!.stale === undefined);
	await readG(false, 1_000_000 + FULL_LIST_EVERY);
	expect('Gemini quick list: after a week the whole list is read again', gCalls.length === 4 && g.listCatalog!.fullAt === 1_000_000 + FULL_LIST_EVERY);
	expect('Gemini quick list: nothing remembered, nothing to mark', !listFailed({}));

	// A list that is not newest first is read whole every time.
	const swap = rest[60]!;
	rest[60] = rest[61]!;
	rest[61] = swap;
	g.listCatalog!.fullAt = 0;
	await readG();
	await readG();
	expect('Gemini quick list: a list in another order is never cut short', gCalls.length === 4 && !g.listCatalog!.ordered);

	// AI Studio: one list, 100 prompts a page.
	const prompts = Array.from({ length: 230 }, (_, i) => ({ id: sid(230 - i), at: 230 - i }));
	let sCalls: string[] = [];
	const studio = new (StudioApi as unknown as Bare<StudioApi>)(null, null);
	(studio as unknown as StudioCalls).call = async (_method, body) => {
		const from = body[1] ? Number(body[1]) : 0;
		sCalls.push(String(from));
		const rows = prompts.slice(from, from + 100).map((p) => [p.id, null, null, null, [`Prompt ${p.at}`, null, null, null, [[String(sec(p.at)), 0]]]]);
		return from + 100 < prompts.length ? [rows, String(from + 100)] : [rows];
	};
	const st: ListHolder = {};
	const readS = async (fileGone = false) => {
		sCalls = [];
		return readList(st, { scope: 'prompts', fileGone, now: 1_000_000 }, (settled) => studio.listPrompts(none, () => undefined, (page) => settled(page, false)));
	};
	const s1 = await readS();
	expect('AI Studio quick list: the first read takes every page', sCalls.join() === '0,100,200' && !s1.quick && s1.rows.length === 230 && st.listCatalog!.ordered, sCalls.join());
	const s2 = await readS();
	expect('AI Studio quick list: nothing new, one page, every prompt still there', sCalls.join() === '0' && s2.quick && s2.rows.length === 230 && !s2.changed, sCalls.join());
	prompts.unshift({ id: sid(999), at: 300 });
	const s3 = await readS();
	expect('AI Studio quick list: a new prompt is found and the list is one longer', sCalls.join() === '0,100' && s3.rows.length === 231 && s3.rows[0]!.item.uuid === sid(999) && s3.rows[0]!.item.name === 'Prompt 300', sCalls.join());
	await readS(true);
	expect('AI Studio quick list: a missing note or raw file means a full read', sCalls.join() === '0,100,200');

	// What counts as a missing file.
	const { files, vault } = fakeVault();
	const app = { vault } as never;
	const entry = { updated_at: 'x', json: 'Raw/a.json', md: 'G/a.md', synced: 'x' } as IndexEntry;
	files.set('Raw/a.json', '{}');
	files.set('G/a.md', 'note');
	expect('file gone: both files there', !fileGone(app, { a: entry }) && !fileGone(app, {}));
	files.delete('G/a.md');
	expect('file gone: a deleted note', fileGone(app, { a: entry }));
	files.set('G/a.md', 'note');
	files.delete('Raw/a.json');
	expect('file gone: a deleted raw file', fileGone(app, { a: entry }));
}

function reasoningSwitch() {
	const turn = { rid: 'r1', createdAt: '2026-03-01T10:00:00.000Z', prompt: 'Q', answer: 'A', reasoning: 'Deep thoughts.', images: [], generated: [] };
	const chat = { id: 'c_1', title: 'T', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z', turns: [turn] } as unknown as GeminiChat;
	expect('reasoning switch: Gemini shows reasoning by default', renderGeminiTranscript(chat, 'x.json').includes('Deep thoughts.'));
	expect('reasoning switch: Gemini off leaves it out, the answer stays', !renderGeminiTranscript(chat, 'x.json', false).includes('Deep thoughts.') && renderGeminiTranscript(chat, 'x.json', false).includes('\nA'));
	const prompt = { id: 'prompts/x', updatedAt: '2026-03-01T10:00:00.000Z', messages: [{ role: 'model', text: 'Hmm, thinking.', thought: true }, { role: 'model', text: 'Answer.' }] } as unknown as StudioPrompt;
	expect('reasoning switch: AI Studio thinking shown by default, left out when off', renderStudioTranscript(prompt, 'x.json').includes('Hmm, thinking.') && !renderStudioTranscript(prompt, 'x.json', false).includes('Hmm, thinking.') && renderStudioTranscript(prompt, 'x.json', false).includes('Answer.'));
	expect('reasoning switch: missing setting means on', normalizeSettings({}).settings.gemini[0]!.web.showReasoning !== false && normalizeSettings({}).settings.lumo[0]!.web.showReasoning !== false);
}

async function main() {
	// --- batchexecute framing --------------------------------------------------
	const list = [null, 'next-token', [['c_238ce75d1feb162e', 'Website review', null, null, null, at(1788451602)], ['c_421ec87547ddea3f', '', null, null, null, at(1788426966)]]];
	const payload = batchPayload(reply('MaZiqc', list), 'MaZiqc');
	expect('payload found in reply', JSON.stringify(payload) === JSON.stringify(list));
	throws('other rpc missing', () => batchPayload(reply('MaZiqc', list), 'hNvQHb'), ShapeError);
	throws('odd start refused', () => batchPayload('<html>', 'MaZiqc'), ShapeError);
	const err = `)]}'\n\n1\n${JSON.stringify([['wrb.fr', 'hNvQHb', null, null, null, [5, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1167, null, "Couldn't load conversation. (1167)"]]]], 'generic']])}\n`;
	try {
		batchPayload(err, 'hNvQHb');
		expect('error reply throws', false);
	} catch (e) {
		expect('error reply is a GeminiError with its code', e instanceof GeminiError && e.code === 1167);
	}

	// --- chat list ---------------------------------------------------------------
	const page = readListPage(payload, false);
	expect('list items', page.items.length === 2 && page.next === 'next-token');
	expect('list time from seconds', page.items[0]!.updated_at === new Date(1788451602153).toISOString());
	expect('empty title becomes Untitled', page.items[1]!.name === 'Untitled');
	expect('last page has no cursor', readListPage([null, null, []], true).next === null);
	throws('odd chat ID refused', () => readListPage([null, null, [['../x', 't', null, null, null, at(1)]]], false), ShapeError);

	// --- a chat -------------------------------------------------------------------
	const newestFirst = [turn('r_3', 300, 'third', 'C', { reasoning: 'thinking it over', drafts: 2 }), turn('r_2', 200, 'second', 'B'), turn('r_1', 100, 'first', 'A')];
	const chatPage = readChatPage([newestFirst, 'older']);
	expect('chat page', chatPage.turns.length === 3 && chatPage.next === 'older');
	const t = readTurn(newestFirst[0]!, 0);
	expect('turn fields', t.id === 'r_3' && t.prompt === 'third' && t.answer === 'C' && t.model === '3.6 Flash');
	expect('turn reasoning and drafts', t.reasoning === 'thinking it over' && t.otherDrafts === 2);
	throws('turn without prompt refused', () => readTurn([['c_1', 'r_1'], null, [[null]], [[]], at(1)], 0), ShapeError);
	const item = { ...page.items[1]!, pinned: true };
	const chat = buildChat(item, newestFirst);
	expect('chat oldest first', chat.turns.map((x) => x.prompt).join(',') === 'first,second,third');
	expect('chat created from first turn', chat.createdAt === new Date(100153).toISOString());
	expect('raw rows kept', chat.raw.length === 3);
	const md = renderGeminiTranscript(chat, 'x.json');
	expect('transcript front matter', md.includes('pinned: true') && md.includes('raw: "[[x.json]]"'));
	expect('transcript order', md.indexOf('first') < md.indexOf('second') && md.indexOf('second') < md.indexOf('third'));
	expect('transcript reasoning callout', md.includes('> [!note]- Reasoning') && md.includes('2 other drafts'));

	// --- pictures in answers ------------------------------------------------------------
	const pic: unknown[] = ['rc_aaa', ['See <Image alt="Tabs" caption="Tabs at the bottom" src="image_agent_tag_123"/> and <Image src="image_agent_tag_999"/>.']];
	pic[12] = [null, [[[['https://example.com/a.png'], null, 979, 667], [['https://example.com/page'], 'Title', 7, null, null, 'MageComp'], null, [['https://thumb']], null, null, null, ['http://googleusercontent.com/image_agent_tag_123']]]];
	const withPic = turn('r_9', 900, 'q', 'x');
	(withPic[3] as unknown[][])[0] = [pic];
	const pt = readTurn(withPic, 0);
	expect('picture read', pt.images?.length === 1 && pt.images[0]!.url === 'https://example.com/a.png' && pt.images[0]!.site === 'MageComp');
	const shown = imagesAsLinks(pt.answer, pt.images);
	expect('picture becomes a link', shown.includes('*(Image: Tabs at the bottom, [view](<https://example.com/a.png>), from [MageComp](<https://example.com/page>))*'), shown);
	expect('unknown picture marked not saved', shown.includes('*(Image: picture, not saved)*') && !shown.includes('<Image'));

	// --- pictures Gemini made (seen 2026-11-26) ------------------------------------------
	const P1 = 'http://googleusercontent.com/image_generation_content/0_1083';
	const LH3 = 'https://lh3.googleusercontent.com/gg/AAAA-generated';
	const made: unknown[] = ['rc_bbb', [`Here is the apple:\n\n${P1}\n\nand http://googleusercontent.com/image_generation_content/7\n`]];
	made[12] = [];
	(made[12] as unknown[])[7] = [[
		[[null, null, null, [null, 1, 'name.jpeg', LH3, null, 'x', null, null, null, [1, 2]]], [P1], null, [24]],
		[[null, null, null, [null, 1, 'bad', 'javascript:alert(1)']], ['http://googleusercontent.com/image_generation_content/9']],
		[[null], ['not a placeholder']],
	]];
	const withMade = turn('r_8', 800, 'draw', 'x');
	(withMade[3] as unknown[][])[0] = [made];
	const mt = readTurn(withMade, 0);
	expect('made picture read', mt.generated?.length === 2 && mt.generated[0]!.url === LH3 && mt.generated[1]!.url === undefined, JSON.stringify(mt.generated));
	const madeShown = generatedAsLinks(mt.answer, mt.generated);
	expect('made picture becomes a link', madeShown.includes(`*(Generated image, [view](<${LH3}>), opens while signed in to Google)*`) && !madeShown.includes(P1), madeShown);
	expect('made picture without address marked not saved', madeShown.includes('*(Generated image, not saved)*') && !madeShown.includes('image_generation_content'), madeShown);
	const madeMd = renderGeminiTranscript({ ...chat, turns: [mt] }, 'x.json');
	expect('transcript shows the made picture', madeMd.includes(`[view](<${LH3}>)`) && !madeMd.includes('image_generation_content'));

	// --- AI Studio ------------------------------------------------------------------
	const meta = ['AI Optimization for Agriland', null, ['Owner', 1, 'photo'], null, [['1788164186', 894000000], ['Owner', 1, 'photo']], [1, 1, 1]];
	const plist = readPromptList([[['prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK', null, null, null, meta]]]);
	expect('prompt list', plist.items.length === 1 && plist.next === null && plist.items[0]!.name === 'AI Optimization for Agriland');
	expect('prompt time', plist.items[0]!.updated_at === new Date(1788164186894).toISOString());
	expect('prompt file ID', promptFileId('prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK') === '18msBc92magVZWdNSZgB8qJA4JIS3ExgK');
	throws('odd prompt ID refused', () => promptFileId('prompts/../../x'), ShapeError);
	const chunk = (text: string, role: string, thought = false) => {
		const c: unknown[] = [text];
		c[8] = role;
		c[18] = 24;
		if (thought) c[19] = 1;
		c[32] = ['1788163821', 851000000];
		return c;
	};
	const p: unknown[] = ['prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK', null, null, [1, null, 'models/gemini-3-pro'], meta];
	p[12] = ['Be brief.'];
	p[13] = [[chunk('Question?', 'user'), chunk('Let me think', 'model', true), chunk('Answer.', 'model')]];
	const prompt = readPrompt([p], 'prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK');
	expect('prompt messages', prompt.messages.length === 3 && prompt.messages[1]!.thought === true && prompt.messages[2]!.text === 'Answer.');
	expect('prompt model and system', prompt.model === 'models/gemini-3-pro' && prompt.systemInstruction === 'Be brief.');
	throws('different prompt refused', () => readPrompt([p], 'prompts/otherotherother'), ShapeError);
	const smd = renderStudioTranscript(prompt, 'p.json');
	expect('studio transcript', smd.includes('> [!note]- System instructions') && smd.includes('> [!note]- Thinking') && smd.includes('## Model'));

	// --- settings ---------------------------------------------------------------------
	const fresh = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: { chatFolder: '30 Sources/AI Chats/Claude Desktop/Chat' } }] }).settings;
	expect('vault without Gemini gets it beside the others', fresh.gemini[0]!.web.folder === '30 Sources/AI Chats/Gemini/Chat' && fresh.gemini[0]!.studio.folder === '30 Sources/AI Chats/Gemini/AI Studio');
	const kept = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: {} }], gemini: [{ id: 'default', label: 'Main', web: { folder: 'G', index: { c_1: { updated_at: 'x', json: 'a', md: 'b', synced: 'y' } } } }] }).settings;
	expect('saved Gemini settings kept, AI Studio filled in', kept.gemini[0]!.web.folder === 'G' && !!kept.gemini[0]!.web.index.c_1 && kept.gemini[0]!.studio.enabled);

	// --- the same Google login under two accounts -------------------------------------
	{
		const two = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: {} }], gemini: [{ id: 'a', label: 'Private', web: { folder: 'G', userId: '123456789012345678901' } }, { id: 'b', label: 'Work', web: { folder: 'G' } }] }).settings.gemini;
		expect('same login: the Google account number is kept, anything else is not one', googleAccountId('123456789012345678901') === '123456789012345678901' && googleAccountId('me@example.com') === '' && googleAccountId(undefined) === '' && googleAccountId('12') === '');
		expect('same login: a second account on the same Google login is found', sameGoogleLogin(two, two[1]!, '123456789012345678901') === two[0]);
		expect('same login: the account itself, another login and an unknown login match nobody', !sameGoogleLogin(two, two[0]!, '123456789012345678901') && !sameGoogleLogin(two, two[1]!, '999999999999999999999') && !sameGoogleLogin(two, two[1]!, '') && !sameGoogleLogin(two, two[1]!, undefined));
		expect('same login: the stop message names the other account', SAME_GOOGLE_LOGIN('Private') === 'This login is the same Google account as "Private". Log in with a different account, or remove this one.');
	}

	// --- the save loop of Gemini and AI Studio, on a fake vault ---------------------------
	await saveLoop();
	await quickLists();
	reasoningSwitch();

	console.log(failures ? `\n${failures} FAILED` : '\nall passed');
	if (failures) process.exit(1);
}

void main();
