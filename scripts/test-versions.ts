// Offline test of the one-note-per-chat rule (src/versions.ts) and of the shared save used by
// Gemini and AI Studio. Run: npm run test:versions

import { Platform, TFile, TFolder } from 'obsidian';
import { emptyResult, geminiFromRaw, saveChats, type Saved } from '../src/gemini/save';
import { followRename } from '../src/follow';
import { normalizeSettings } from '../src/migrate';
import { localStamp, modelProperty } from '../src/naming';
import { renderGptTranscript } from '../src/chatgpt/transcript';
import { renderTranscript } from '../src/transcript';
import { hermesRawMoves, googleRawMoves } from '../src/raw-move';
import { allEntries, refreshEntries } from '../src/reindex';
import type { IndexEntry, ListItem } from '../src/types';
import { addVersion, bodyOf, carryProperties, continues, withFlag, keepNoteAsVersion, keepVersion, noteHash, splitNote, versionPath, wasEdited, withVersionInfo, writeNote } from '../src/versions';
import { findFile, freeFileName } from '../src/vaultio';
import { readWrite } from './fake-vault';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

function fakeVault() {
	const files = new Map<string, string>();
	const mtimes = new Map<string, number>();
	const vault = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? Object.assign(new TFile(p, { size: files.get(p)!.length }), { stat: { size: files.get(p)!.length, mtime: mtimes.get(p) } }) : null),
		createFolder: async () => undefined,
		create: async (p: string, d: string) => {
			if (files.has(p)) throw new Error('exists ' + p);
			files.set(p, d);
		},
		...readWrite(files),
	};
	const app = { vault } as never;
	return { files, mtimes, app };
}

const note = (body: string, extra = '') => `---\nuuid: abc\nupdated: 2026-11-07T10:00:00Z\nraw: "[[x.json]]"\n${extra}unread: true\n---\n${body}`;

// --- text ------------------------------------------------------------------------------------
{
	const parts = splitNote(note('## You\n\nHi\n'));
	expect('split: properties and body', parts?.fm.length === 4 && parts.body === '## You\n\nHi\n');
	expect('split: no properties -> null', splitNote('just text') === null && splitNote('---\nopen only') === null);
	expect('body: line ends and trailing space do not count', bodyOf(note('A\r\nB\n\n')) === 'A\nB' && noteHash(note('A\nB')) === noteHash(note('A\r\nB\n   \n')));
	expect('hash: properties do not count, text does', noteHash(note('A')) === noteHash(note('A', 'tags: [x]\n').replace('unread: true', 'unread: false')) && noteHash(note('A')) !== noteHash(note('B')));

	const old = note('old text', 'tags:\n  - mine\n  - keep\naliases: [Short]\nearlier_versions: 1\nearlier_raw:\n  - "[[gone.json]]"\n').replace('unread: true', 'unread: false');
	const carried = carryProperties(old, note('new text').replace('2026-11-07T10', '2026-11-08T09'));
	expect('carry: your properties stay, with their list lines', carried.includes('tags:\n  - mine\n  - keep\naliases: [Short]\n'), carried);
	expect('carry: the plugin\'s properties take the new value', carried.includes('updated: 2026-11-08T09:00:00Z') && carried.includes('unread: true') && carried.endsWith('---\nnew text'));
	expect('carry: old version info is not carried', !carried.includes('gone.json') && !carried.includes('earlier_versions'));
	expect('carry: "unread" kept when asked', carryProperties(old, note('new text'), ['unread']).includes('unread: false'));
	expect('carry: a note without properties is left to the new text', carryProperties('plain', note('x')) === note('x'));

	const v = [{ at: '2026-11-07T10:00:00Z', files: ['Raw/C/x (version 2026-11-07 1100).json'] }, { at: '2026-11-08T10:00:00Z', files: ['Raw/C/x (version 2026-11-08 1100).json', 'Raw/C/x (version 2026-11-08 1100) (older 1).json'] }];
	const info = withVersionInfo(note('t'), v, 'C');
	expect('info: count and one link per version, before "unread"', info.includes('earlier_versions: 2\nearlier_raw:\n  - "[[Raw/C/x (version 2026-11-07 1100).json]]"\n  - "[[Raw/C/x (version 2026-11-08 1100).json]]"\nunread: true\n---\nt'), info);
	expect('info: raw file next to the note is linked by name', withVersionInfo(note('t'), [{ at: 'x', files: ['C/x (version a).json'] }], 'C').includes('  - "[[x (version a).json]]"'));
	expect('info: none -> note unchanged', withVersionInfo(note('t'), [], 'C') === note('t') && withVersionInfo(note('t'), undefined, 'C') === note('t'));
	expect('info: written again, not twice', withVersionInfo(info, v.slice(0, 1), 'C').split('earlier_versions').length === 2 && withVersionInfo(info, v.slice(0, 1), 'C').includes('earlier_versions: 1\n'));

	const at = '2026-11-07T10:05:00Z';
	const s = localStamp(at);
	expect('path: main file', versionPath('Raw/C/2026-11-07 Title.json', '2026-11-07 Title', at) === `Raw/C/2026-11-07 Title (version ${s}).json`);
	expect('path: ChatGPT older part keeps its ending', versionPath('Raw/C/T (older 2).json', 'T', at) === `Raw/C/T (version ${s}) (older 2).json`);
	expect('path: desktop .jsonl, second of the same minute', versionPath('R/T.jsonl', 'T', at, 2) === `R/T (version ${s} 2).jsonl`);
	expect('path: a stamp that is no date is made file-safe', versionPath('R/T.json', 'T', '12:7') === 'R/T (version 12-7).json');

	expect('edited: by fingerprint', wasEdited(note('mine'), undefined, { lastHash: noteHash(note('theirs')) }) && !wasEdited(note('same', 'tags: [a]\n'), undefined, { lastHash: noteHash(note('same')) }));
	expect('edited: no fingerprint -> by time, two minutes of slack', wasEdited('x', Date.parse('2026-11-07T10:03:00Z'), { lastSynced: '2026-11-07T10:00:00Z' }) && !wasEdited('x', Date.parse('2026-11-07T10:01:00Z'), { lastSynced: '2026-11-07T10:00:00Z' }));
	const t1 = '## You · 10:00\n\nHi\n\n## Claude · 10:01\n\nHello\n';
	const t2 = `${t1}\n## You · 11:00\n\nMore\n`;
	const late = Date.parse('2026-11-08T08:00:00Z');
	const legacy = { lastSynced: '2026-11-07T10:00:00Z' };
	expect('continues: a chat that went on holds every old turn', continues(note(t1), note(t2)) && continues(note(`${t1}\n## Files\n\n📎 [[a.png]]\n`), note(t2)) && !continues(note(t2), note(t1)));
	expect('continues: a changed word in an old turn is noticed', !continues(note(t1.replace('Hello', 'Hello, my remark')), note(t2)));
	expect('edited, no fingerprint: file changed later but the text is all still there -> not edited', !wasEdited(note(t1), late, legacy, note(t2)));
	expect('edited, no fingerprint: file changed later and the text differs -> edited', wasEdited(note(t1.replace('Hello', 'Hello, my remark')), late, legacy, note(t2)));
	expect('edited, no fingerprint: text differs but the file was never touched -> not edited (rendered differently now)', !wasEdited(note(t1.replace('Hello', 'Hallo')), Date.parse('2026-11-07T10:01:00Z'), legacy, note(t2)));
	expect('edited: nothing known -> not edited', !wasEdited('x', undefined, {}) && !wasEdited('x', 9e15, { lastSynced: '2026-11-07T10:00:00Z', unedited: true }));
	expect('versions list: the same version is listed once', addVersion({ versions: v.slice(0, 1) }, v[0]!)!.length === 1 && addVersion({ versions: v.slice(0, 1) }, v[1]!)!.length === 2 && addVersion(undefined, null) === undefined);
}

(async () => {
	// --- keeping the earlier raw file ---------------------------------------------------------
	{
		const { files, app } = fakeVault();
		const at = '2026-11-07T10:05:00Z';
		const s = localStamp(at);
		expect('keep: no file -> nothing', (await keepVersion(app, ['R/T.json'], at)) === null);
		files.set('R/T.json', 'v1');
		files.set('R/T (older 1).json', 'v1-older');
		const kept = await keepVersion(app, ['R/T.json', 'R/T (older 1).json', 'R/T (older 2).json'], at, 'v2');
		expect('keep: main and its parts copied, a missing part skipped', JSON.stringify(kept?.files) === JSON.stringify([`R/T (version ${s}).json`, `R/T (version ${s}) (older 1).json`]) && files.get(kept!.files[0]!) === 'v1' && files.get(kept!.files[1]!) === 'v1-older');
		expect('keep: the main file is not touched', files.get('R/T.json') === 'v1');
		const again = await keepVersion(app, ['R/T.json', 'R/T (older 1).json'], at, 'v2');
		expect('keep: run twice -> same copies, nothing new', JSON.stringify(again) === JSON.stringify(kept) && files.size === 4);
		files.set('R/T.json', 'v2'); // the run was stopped right after writing the new content
		const resumed = await keepVersion(app, ['R/T.json', 'R/T (older 1).json'], at, 'v2');
		expect('keep: stopped after the new content was written -> the copy from before is the version', resumed?.files[0] === kept!.files[0] && files.size === 4);
		files.set('R/U.json', 'same');
		expect('keep: the same content again -> no version', (await keepVersion(app, ['R/U.json'], at, 'same')) === null && files.size === 5);
		files.set(`R/U (version ${s}).json`, 'someone else');
		files.set('R/U.json', 'u1');
		const numbered = await keepVersion(app, ['R/U.json'], at, 'u2');
		expect('keep: name taken by other content -> numbered', numbered?.files[0] === `R/U (version ${s} 2).json` && files.get(`R/U (version ${s}).json`) === 'someone else');

		files.set('N/Old.md', note('hermes text'));
		const asJson = await keepNoteAsVersion(app, 'N/Old.md', 'R/N/Old.json', at);
		const parsed = JSON.parse(files.get(asJson!.files[0]!)!) as { format: string; markdown: string };
		expect('keep note: old note text wrapped as JSON where the raw versions go', asJson?.files[0] === `R/N/Old (version ${s}).json` && parsed.format === 'ai-chatbridge-note' && parsed.markdown === note('hermes text'));
		expect('keep note: twice -> one file', (await keepNoteAsVersion(app, 'N/Old.md', 'R/N/Old.json', at))?.files[0] === asJson!.files[0]);
	}

	// --- writing the note -------------------------------------------------------------------------
	{
		const { files, mtimes, app } = fakeVault();
		const now = new Date('2026-11-09T12:00:00Z');
		const first = await writeNote(app, 'C/T.md', note('v1'), { policy: 'copy' });
		expect('note: created', first.outcome === 'created' && first.hash === noteHash(note('v1')) && files.get('C/T.md') === note('v1'));
		const second = await writeNote(app, 'C/T.md', note('v2'), { policy: 'copy', lastHash: first.hash });
		expect('note: updated in place, no copy', second.outcome === 'updated' && !second.copy && files.get('C/T.md') === note('v2') && files.size === 1);

		files.set('C/T.md', note('v2 and my remark', 'tags: [mine]\n'));
		const third = await writeNote(app, 'C/T.md', note('v3'), { policy: 'copy', lastHash: second.hash, now });
		const copyName = `C/T (my edits ${localStamp(now.toISOString())}).md`;
		expect('edited, copy: your version saved first, then updated', third.copy === copyName && files.get(copyName) === note('v2 and my remark', 'tags: [mine]\n') && bodyOf(files.get('C/T.md')!) === 'v3' && files.get('C/T.md')!.includes('tags: [mine]'));

		files.set('C/T.md', note('v3 edited again'));
		const kept = await writeNote(app, 'C/T.md', note('v4'), { policy: 'keep', lastHash: third.hash, now });
		expect('edited, keep: note untouched, old fingerprint stays', kept.outcome === 'kept' && kept.hash === third.hash && files.get('C/T.md') === note('v3 edited again') && files.size === 2);
		const over = await writeNote(app, 'C/T.md', note('v4'), { policy: 'overwrite', lastHash: third.hash, now });
		expect('edited, overwrite: replaced, no copy', over.outcome === 'updated' && !over.copy && files.get('C/T.md') === note('v4') && files.size === 2);

		// Saved before fingerprints existed: the file's time decides.
		files.set('C/L.md', note('legacy'));
		mtimes.set('C/L.md', Date.parse('2026-11-07T10:00:30Z'));
		const clean = await writeNote(app, 'C/L.md', note('legacy 2'), { policy: 'copy', lastSynced: '2026-11-07T10:00:00Z', now });
		expect('legacy, untouched since its sync: updated, no copy', clean.outcome === 'updated' && !clean.copy);
		mtimes.set('C/L.md', Date.parse('2026-11-08T08:00:00Z'));
		const touched = await writeNote(app, 'C/L.md', note('legacy 3'), { policy: 'copy', lastSynced: '2026-11-07T10:00:00Z', now });
		expect('legacy, changed later and its text is not in the new one: your version kept as a copy', !!touched.copy && files.get(touched.copy!) === note('legacy 2'));
		files.set('C/M.md', note('## You\n\nHi\n').replace('unread: true', 'unread: false'));
		mtimes.set('C/M.md', Date.parse('2026-11-08T08:00:00Z'));
		const grown = await writeNote(app, 'C/M.md', note('## You\n\nHi\n\n## Claude\n\nHello\n'), { policy: 'copy', lastSynced: '2026-11-07T10:00:00Z', now });
		expect('legacy, changed later (unread ticked) but the chat only went on: updated, no copy', grown.outcome === 'updated' && !grown.copy && files.get('C/M.md')!.includes('Hello'));

		// The same text again (a recovery): nothing is an edit, "unread" can stay.
		files.set('C/S.md', note('same').replace('unread: true', 'unread: false'));
		const same = await writeNote(app, 'C/S.md', note('same'), { policy: 'copy', lastHash: 'something else', keep: ['unread'], now });
		expect('same text: no copy, your "unread" stays', same.outcome === 'updated' && !same.copy && files.get('C/S.md')!.includes('unread: false'));
	}

	// --- Claude's reasoning in the note: only with the account's switch on ---------------------------
	{
		const chat = { uuid: 'c1', name: 'T', created_at: '2026-11-06T09:00:00Z', updated_at: '2026-11-06T10:00:00Z', chat_messages: [
			{ uuid: 'm0', sender: 'human', text: 'Why?', content: [{ type: 'text', text: 'Why?' }], created_at: '2026-11-06T09:00:00Z' },
			{ uuid: 'm1', sender: 'assistant', text: '', created_at: '2026-11-06T09:00:05Z', content: [
				{ type: 'thinking', thinking: 'First line.\nSecond line.' }, { type: 'redacted_thinking', data: 'hidden-data' }, { type: 'thinking', thinking: '  ' }, { type: 'text', text: 'Because.' }] },
		] };
		const off = renderTranscript(chat as never, { jsonFileName: 'c.json' });
		const on = renderTranscript(chat as never, { jsonFileName: 'c.json', showReasoning: true });
		expect('reasoning: left out of the note by default', !off.includes('First line') && !off.includes('[!note]') && off.includes('Because.'));
		expect('reasoning: with the switch on it is folded above the answer', on.includes('> [!note]- Reasoning\n> First line.\n> Second line.\n\nBecause.'), on);
		expect('reasoning: hidden and empty reasoning is never shown', !on.includes('hidden-data') && on.split('[!note]').length === 2);
	}

	// --- a yes/no property flipped in place (pinned, starred) ---------------------------------------
	{
		const note = '---\nuuid: x\ntags:\n  - mine\nmodel: "m"\nraw: "[[x.json]]"\nunread: false\n---\nbody --- with dashes\n';
		const on = withFlag(note, 'pinned', true);
		expect('flag: set before model and raw, everything else untouched', on === '---\nuuid: x\ntags:\n  - mine\npinned: true\nmodel: "m"\nraw: "[[x.json]]"\nunread: false\n---\nbody --- with dashes\n', on);
		expect('flag: setting it twice changes nothing; removing it gives the note back', withFlag(on, 'pinned', true) === on && withFlag(on, 'pinned', false) === note && withFlag(note, 'pinned', false) === note);
		expect('flag: a note without properties is left alone', withFlag('just text', 'pinned', true) === 'just text');
	}

	// --- the model property of a chat note ---------------------------------------------------------
	{
		expect('model: none known gives no line', modelProperty([undefined, '', '  ', 5]).length === 0);
		expect('model: one model is a plain value', modelProperty(['gpt-6', 'gpt-6']).join('|') === 'model: "gpt-6"');
		expect('model: several are a list, each once, in the order used', modelProperty(['a', 'b', 'a']).join('|') === 'model:|  - "a"|  - "b"');
		const msg = (role: string, model?: string) => ({ id: role + String(model), author: { role }, create_time: 1795000000, content: { content_type: 'text', parts: ['Hi'] }, metadata: model ? { model_slug: model } : {} });
		const gpt = (messages: unknown[], extra: object = {}) => renderGptTranscript({ conversation_id: 'c1', title: 'T', create_time: 1795000000, update_time: 1795000000, gizmo_id: null, messages, ...extra } as never, { jsonFileName: 'c.json' }).split('---')[1]!;
		expect('model: a ChatGPT note names the models that answered', gpt([msg('user'), msg('assistant', 'gpt-6-thinking'), msg('user'), msg('assistant', 'gpt-6')]).includes('\nmodel:\n  - "gpt-6-thinking"\n  - "gpt-6"\nraw:'));
		expect('model: without one on the answers the chat default is used; without that, nothing', gpt([msg('user'), msg('assistant')], { default_model_slug: 'gpt-6' }).includes('\nmodel: "gpt-6"\n') && !gpt([msg('user'), msg('assistant')]).includes('model:'));
		const carried = carryProperties('---\nuuid: x\nmodel: "old"\ntags:\n  - mine\nunread: false\n---\nbody\n', '---\nuuid: x\nmodel:\n  - "a"\n  - "b"\nunread: true\n---\nbody\n');
		expect('model: a rewrite takes the new models and keeps your own properties', carried.includes('model:\n  - "a"\n  - "b"') && !carried.includes('"old"') && carried.includes('tags:\n  - mine'), carried);
	}

	// --- the shared save of Gemini and AI Studio: new, continued, recovered --------------------------
	{
		const { files, app } = fakeVault();
		const settings = normalizeSettings({ maxChatsPerRun: 0, logPath: 'log.md' }).settings;
		const plugin = { app, settings, saveSettings: async () => undefined } as never;
		const index: Record<string, IndexEntry> = {};
		let text = 'first answer';
		const item = (updated: string): ListItem => ({ uuid: 'c_1', name: 'Plan a trip', created_at: '2026-11-06T09:00:00Z', updated_at: updated });
		const read = async (it: ListItem): Promise<Saved> => ({
			createdAt: it.created_at,
			json: JSON.stringify({ id: it.uuid, text }),
			md: (link) => `---\nuuid: ${it.uuid}\nupdated: ${it.updated_at}\nraw: "[[${link}]]"\nunread: true\n---\n## Gemini\n\n${text}\n`,
		});
		const run = async (updated: string) => {
			const r = emptyResult();
			await saveChats(plugin, [item(updated)], index, 'AI/Gemini', 'Raw/AI/Gemini', read, () => undefined, r, { label: 'Gemini chats', fromRaw: geminiFromRaw('') });
			return r;
		};
		const md = 'AI/Gemini/2026-11-06 Plan a trip.md';
		const json = 'Raw/AI/Gemini/2026-11-06 Plan a trip.json';

		const r1 = await run('2026-11-06T09:30:00Z');
		expect('gemini: new chat -> note and raw file', r1.newCount === 1 && files.has(md) && files.has(json) && index.c_1!.md === md && !!index.c_1!.noteHash);

		text = 'first answer\n\nsecond answer';
		const r2 = await run('2026-11-07T11:00:00Z');
		const kept = `Raw/AI/Gemini/2026-11-06 Plan a trip (version ${localStamp('2026-11-06T09:30:00Z')}).json`;
		expect('gemini: continued chat -> the same note, rewritten', r2.changedCount === 1 && index.c_1!.md === md && [...files.keys()].filter((p) => p.endsWith('.md')).length === 1 && files.get(md)!.includes('second answer'));
		expect('gemini: no "(updated …)" file', ![...files.keys()].some((p) => p.includes('(updated')));
		expect('gemini: earlier version kept as raw JSON', files.get(kept) === JSON.stringify({ id: 'c_1', text: 'first answer' }) && files.get(json)!.includes('second answer') && index.c_1!.versions?.[0]?.files[0] === kept, [...files.keys()].join(' | '));
		expect('gemini: the note says when it was updated and how many earlier versions exist', files.get(md)!.includes('updated: 2026-11-07T11:00:00Z') && files.get(md)!.includes(`earlier_versions: 1\nearlier_raw:\n  - "[[${kept}]]"`));

		text += '\n\nthird answer';
		const r3 = await run('2026-11-08T12:00:00Z');
		expect('gemini: second update -> two earlier versions, still one note', r3.changedCount === 1 && index.c_1!.versions?.length === 2 && files.get(md)!.includes('earlier_versions: 2') && [...files.keys()].filter((p) => p.endsWith('.md')).length === 1);

		// Both files deleted from the vault: written again under the same names, no "(recovered)".
		files.delete(md);
		const r4 = await run('2026-11-08T12:00:00Z');
		expect('gemini: deleted note comes back under its name', r4.restored.length === 1 && files.has(md) && ![...files.keys()].some((p) => p.includes('(recovered)')) && index.c_1!.versions?.length === 2);

		// Renames and "Refresh index" know the earlier versions; the raw-file move takes them along.
		const moved = followRename({ ...settings, gemini: [{ ...settings.gemini[0]!, web: { ...settings.gemini[0]!.web, index } }] }, 'Raw/AI', 'Raw2/AI');
		expect('follow: earlier versions follow a folder move', moved === 3 && index.c_1!.versions![0]!.files[0]!.startsWith('Raw2/AI/') && index.c_1!.json.startsWith('Raw2/AI/'));
		followRename({ ...settings, gemini: [{ ...settings.gemini[0]!, web: { ...settings.gemini[0]!.web, index } }] }, 'Raw2/AI', 'Raw/AI');

		const s2 = structuredClone(settings);
		s2.gemini[0]!.web.index = structuredClone(index);
		s2.gemini[0]!.web.index.c_1!.versions![1]!.files[0] = 'Elsewhere/lost name.json';
		const second = s2.gemini[0]!.web.index.c_1!.versions![1]!;
		const res = refreshEntries(allEntries(s2), { exists: (p) => files.has(p), transcriptOf: () => null, rawLinkOf: () => null, uniqueByName: (n) => (n === 'lost name.json' ? 'Found/lost name.json' : null) });
		expect('reindex: a moved earlier version is found again by its name', res.relinked === 1 && second.files[0] === 'Found/lost name.json');

		const s3 = structuredClone(settings);
		s3.rawRootOn = false;
		s3.gemini[0]!.web.folder = 'AI/Gemini';
		s3.gemini[0]!.web.rawFolder = 'Json/Gemini';
		s3.gemini[0]!.web.index = structuredClone(index);
		const moves = googleRawMoves(app, s3.gemini[0]!, 'web');
		expect('raw move: the main file and both earlier versions are offered', moves.length === 3 && moves.every((m) => m.to.startsWith('Json/Gemini/')), JSON.stringify(moves));

		const s4 = structuredClone(settings);
		s4.hermes.folder = 'AI/Hermes';
		files.set('AI/Hermes/p/s.json', '{}');
		files.set('AI/Hermes/p/s.md', 'x');
		s4.hermes.profiles = [{ id: 'p', label: 'p', path: 'D:/p', enabled: true, index: { s: { rev: '1:1', updated: 'x', md: 'AI/Hermes/p/s.md', json: 'AI/Hermes/p/s.json', synced: 'x' } } }];
		expect('raw move: Hermes raw files follow the raw files folder', hermesRawMoves(app, s4, '80 Archive/raw')[0]?.to === '80 Archive/raw/AI/Hermes/p/s.json');
	}

	// --- file names the file system sees as the same (issue #25) ----------------------------------
	{
		const nfd = 'Caffè';
		const root = new TFolder('');
		const chats = new TFolder('Chats');
		const art = new TFolder('Chats/Artifacts');
		const png = new TFile('Chats/Artifacts/Guide to the characters.png', { size: 1 });
		const md = new TFile(`Chats/2026-01-01 ${nfd}.md`, { size: 1 });
		const named = (f: TFile | TFolder) => Object.assign(f, { name: f.path.split('/').pop() });
		root.children = [named(chats)];
		chats.children = [named(art), named(md)];
		art.children = [named(png)];
		const all = new Map<string, TFile | TFolder>([['Chats', chats], ['Chats/Artifacts', art], [png.path, png], [md.path, md]]);
		const app = { vault: { getAbstractFileByPath: (p: string) => all.get(p) ?? null, getRoot: () => root } } as never;
		const os = Platform as { isMacOS?: boolean; isWin?: boolean };
		const numbered = (n: string, i: number) => n.replace(/\.png$/, ` ${i}.png`);

		expect('find: NFC name finds the NFD file on any system', findFile(app, 'Chats/2026-01-01 Caffè.md') === md);
		expect('find: case differs, Linux -> not found', findFile(app, 'Chats/Artifacts/Guide to the Characters.png') === null);
		os.isMacOS = true;
		expect('find: case differs, macOS -> same file', findFile(app, 'Chats/Artifacts/Guide to the Characters.png') === png);
		expect('find: case differs in a folder too', findFile(app, 'chats/artifacts/GUIDE to the characters.png') === png);
		expect('find: a free name stays free', findFile(app, 'Chats/Artifacts/Other.png') === null && findFile(app, 'Nope/x.md') === null);
		expect('free name: a case-only rename gets a number', freeFileName(app, 'Chats/Artifacts', 'Guide to the Characters.png', numbered) === 'Guide to the Characters 2.png');
		os.isMacOS = false;
	}

	console.log(failures ? `\n${failures} FAILED` : '\nAll version tests passed.');
	process.exit(failures ? 1 : 0);
})().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
