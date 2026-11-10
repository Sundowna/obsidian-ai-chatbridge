// Offline test: runs the pure logic on the saved DevTools samples. No network.
// Run: npm run test:offline

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { checkChat, checkListPage } from '../src/schema';
import { filterByProjects, pickTodo, projectFolderNames, projectSubfolder, targetFor } from '../src/select';
import { baseName, safeTitle } from '../src/naming';
import { activeBranch, renderTranscript } from '../src/transcript';
import { chatFiles, mergeFiles, numbered, safeFileName, visibleFiles } from '../src/files';
import { decodeMessage, encodeStrings } from '../src/proto';
import { followRename } from '../src/follow';
import { customProjectFolder, defaultProjectFolder, nothingSelected, NO_PROJECT, plainFolder } from '../src/select';
import { isSelected, markNew, onlySelected, pickerRows, rowsFromChats, rowsFromProjects, setRows } from '../src/project-catalog';
import type { IndexEntry } from '../src/types';

/** Settings with one account holding this index, for the rename tests. */
const oneAccount = (web: object, provider: 'claude' | 'chatgpt') => ({
	claude: provider === 'claude' ? [{ web, desktop: { index: {} } }] : [],
	chatgpt: provider === 'chatgpt' ? [{ web, desktop: { index: {} } }] : [],
	lumo: [],
	gemini: [],
} as unknown as Parameters<typeof followRename>[0]);
import { checkGptChat, checkGptFileInfo, checkGptList, checkGptOlderPage, checkGptSidebar } from '../src/chatgpt/schema';
import { joinParts, olderPartPath } from '../src/chatgpt/parts';
import { toListItems } from '../src/chatgpt/select';
import { gptChatFiles } from '../src/chatgpt/files';
import { cleanMarkers, renderGptTranscript } from '../src/chatgpt/transcript';
import { describePage, fallbackCookie, findAccessToken } from '../src/chatgpt/token';
import { cookiePairs, cookieText, googleCookies } from '../src/cookies';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

// --- list + filter -------------------------------------------------------
const list = checkListPage(JSON.parse(readFileSync('samples/list-trimmed.json', 'utf8')));
expect('list shape accepted', list.data.length === 3);
const brain = filterByProjects(list.data, ['2nd Brain']);
expect('filter "2nd Brain" keeps 1 of 3', brain.length === 1 && brain[0]!.name === 'Second brain setup - test run');
expect('filter by project uuid works', filterByProjects(list.data, ['01a1a5fa-40cf-731e-abcb-9e29e2c0e5ba']).length === 1);
expect('empty filter keeps all', filterByProjects(list.data, []).length === 3);

// Folder per project.
{
	const inBrain = { uuid: 'c1', name: 'Chat', created_at: '', updated_at: '', project: { uuid: 'p-1', name: '2nd Brain' } };
	const loose = { uuid: 'c2', name: 'Chat', created_at: '', updated_at: '', project: null };
	const other = { uuid: 'c3', name: 'Chat', created_at: '', updated_at: '', project: { uuid: 'p-2', name: 'Work' } };
	const on = { onlyProjects: true, customProjectFolders: true, projectFolders: { 'p-1': 'Projects/Brain/', [NO_PROJECT]: 'Inbox\\AI', 'work': 'Work chats' } };
	expect('project folder: by project ID, slashes tidied', customProjectFolder(inBrain, on) === 'Projects/Brain');
	expect('project folder: chats without a project', customProjectFolder(loose, on) === 'Inbox/AI');
	expect('project folder: an entry saved by name still matches', customProjectFolder(other, on) === 'Work chats');
	expect('project folder: unset project uses the default', customProjectFolder({ ...other, project: { uuid: 'p-3', name: 'Else' } }, on) === null);
	expect('project folder: ignored with the option off', customProjectFolder(inBrain, { ...on, customProjectFolders: false }) === null);
	expect('project folder: ignored without "only selected projects"', customProjectFolder(inBrain, { ...on, onlyProjects: false }) === null);
	expect('project folder: hidden folder refused', customProjectFolder(inBrain, { ...on, projectFolders: { 'p-1': 'Notes/.obsidian/x' } }) === null);
	expect('plain folder: empty refused', plainFolder('  / ') === null && plainFolder('a//b/ c ') === 'a/b/c');
	expect('default folder: project subfolder', defaultProjectFolder('AI Chats/Claude', true, '2nd: Brain') === 'AI Chats/Claude/2nd- Brain');
	expect('default folder: recent folder for no project', defaultProjectFolder('AI Chats/Claude', true, null, 'Loose') === 'AI Chats/Claude/Loose');
	expect('default folder: no subfolders', defaultProjectFolder('AI Chats/Claude', false, 'X') === 'AI Chats/Claude');
}

// Project picker.
{
	const chat = (uuid: string, project: { name: string; uuid: string } | null) => ({ uuid, name: uuid, created_at: '', updated_at: '', project });
	const alpha = { name: 'alpha', uuid: 'id-a' };
	const beta = { name: 'Beta', uuid: 'id-b' };
	const chats = [chat('1', beta), chat('2', alpha), chat('3', beta), chat('4', null)];
	const rows = rowsFromChats(chats);
	expect('picker: no-project row first, then sorted', rows.map((r) => r.id).join() === `${NO_PROJECT},id-a,id-b`);
	expect('picker: counts chats per project', rows[0]!.chats === 1 && rows[2]!.chats === 2);
	const withEmpty = rowsFromChats(chats, [alpha, { name: 'Empty', uuid: 'id-e' }]);
	expect('picker: a project with no chats is listed with 0', withEmpty.find((r) => r.id === 'id-e')?.chats === 0);
	expect('picker: a known project is not counted twice', withEmpty.filter((r) => r.id === 'id-a').length === 1 && withEmpty.find((r) => r.id === 'id-a')?.chats === 1);
	expect('picker: project list has no counts', rowsFromProjects([{ id: 'x', name: 'X' }])[1]!.chats === undefined);
	expect('picker: first fetch marks nothing new', !markNew(rows, undefined).some((r) => r.isNew));
	const later = markNew(rowsFromProjects([{ id: 'id-a', name: 'alpha' }, { id: 'id-c', name: 'C' }]), { fetchedAt: '', rows });
	expect('picker: only unseen projects are new', later.filter((r) => r.isNew).map((r) => r.id).join() === 'id-c');

	const catalog = { fetchedAt: '', rows };
	const kept = onlySelected({ fetchedAt: 't', rows: [{ ...rows[1]!, isNew: true }, rows[2]!], note: 'n' }, ['id-a'], 'Recent');
	expect('saved list holds only selected names', kept?.rows.length === 1 && kept.rows[0]!.name === 'alpha' && kept.rows[0]!.isNew === undefined);
	expect('saved list is dropped when nothing is selected', onlySelected(catalog, [], 'Recent') === undefined);
	expect('picker: typed names tick their rows', isSelected(rows[2]!, ['beta'], 'Recent') && isSelected(rows[0]!, ['Recent'], 'Recent'));
	const typed = pickerRows(catalog, ['Beta', 'Gone'], 'Recent');
	expect('picker: selected but unlisted stays visible', typed.length === 4 && typed[3]!.orphan === true && typed[3]!.name === 'Gone');
	expect('picker: before a fetch, selection shows without warning', pickerRows(undefined, ['Recent', 'Beta'], 'Recent').every((r) => !r.orphan));

	const next = setRows(['Beta', 'Gone'], typed, 'Recent', [NO_PROJECT], true);
	expect('picker: ticking turns names into IDs and keeps unlisted', next.join() === `id-b,Gone,${NO_PROJECT}`);
	expect('picker: unticking removes a row chosen by name', setRows(['Beta'], typed, 'Recent', ['id-b'], false).length === 0);
	expect('picker: unticking an unlisted entry removes it', setRows(['Gone'], typed, 'Recent', ['Gone'], false).length === 0);
	expect('filter: IDs and no-project entry select the right chats', filterByProjects(chats, next).map((c) => c.uuid).join() === '1,3,4');
	expect('filter: no-project survives renaming the folder', filterByProjects(chats, [NO_PROJECT], 'Loose').length === 1);

	expect('nothing selected only counts when the filter is on', nothingSelected({ onlyProjects: true, projects: [' '] }) && !nothingSelected({ onlyProjects: false, projects: [] }) && !nothingSelected({ onlyProjects: true, projects: ['x'] }));
}

const first = list.data[0]!;
expect('new chat is picked', pickTodo(list.data, {}).length === 3);
const idx = { [first.uuid]: { updated_at: first.updated_at, json: '', md: '', synced: '' } };
expect('unchanged chat is skipped', pickTodo(list.data, idx).length === 2);
const idx2 = { [first.uuid]: { updated_at: '2020-01-01T00:00:00Z', json: '', md: '', synced: '' } };
const t2 = pickTodo(list.data, idx2).find((t) => t.item.uuid === first.uuid);
expect('changed chat is picked as update', t2?.isUpdate === true);

expect('all sample chats go to Claude Chat folder', list.data.every((it) => targetFor(it) === 'chat'));
expect('missing platform -> Claude Chat', targetFor({ ...first, platform: undefined }) === 'chat');
expect('other platform -> Claude Code', targetFor({ ...first, platform: 'SOMETHING_ELSE' }) === 'code');

expect('project subfolder "2nd Brain"', projectSubfolder(first) === '2nd Brain');
expect('no project -> Recent folder', projectSubfolder(list.data[1]!) === 'Recent');
expect('Recent folder name configurable', projectSubfolder(list.data[1]!, 'Recents') === 'Recents');
expect('filter "Recent" keeps chats without a project', filterByProjects(list.data, ['Recent']).length === 1 && !filterByProjects(list.data, ['Recent'])[0]!.project);
expect('filter "2nd Brain" + "Recent" keeps 2', filterByProjects(list.data, ['2nd Brain', 'recent']).length === 2);
expect('project name made safe', projectSubfolder({ ...first, project: { name: 'A/B: test?', uuid: 'x' } }) === 'A-B- test-');
expect('project folders: one per project in scope', JSON.stringify(projectFolderNames(list.data)) === JSON.stringify(['2nd Brain', 'PC Life', 'Recent']));
expect('project folders follow the filter', JSON.stringify(projectFolderNames(brain)) === JSON.stringify(['2nd Brain']));

let bad = false;
try { checkListPage({ chats: [] }); } catch { bad = true; }
expect('unexpected list shape is rejected', bad);

// --- names ---------------------------------------------------------------
expect('safeTitle Windows chars', safeTitle('a/b:c*d?"e"<f>|g') === 'a-b-c-d--e--f--g', safeTitle('a/b:c*d?"e"<f>|g'));
expect('safeTitle Obsidian chars', safeTitle('x #1 [draft] ^y') === 'x -1 -draft- -y');
expect('safeTitle umlauts kept', safeTitle('Größte Podcaster Deutschlands') === 'Größte Podcaster Deutschlands');
expect('safeTitle empty -> Untitled', safeTitle('  ') === 'Untitled');
expect('safeTitle trailing dot removed', safeTitle('Agriland.com.na.') === 'Agriland.com.na');
expect('safeTitle reserved name', safeTitle('CON') === '_CON');
expect('baseName', baseName(first.created_at, first.name) === '2026-11-05 Second brain setup - test run', baseName(first.created_at, first.name));

// --- chat sample(s) ------------------------------------------------------
for (const f of ['samples/chat.json', 'samples/chat-in-project.json']) {
	if (!existsSync(f)) { console.log(`SKIP  ${f} not saved yet`); continue; }
	const raw = readFileSync(f, 'utf8');
	const json: unknown = JSON.parse(raw);
	const chat = checkChat(json, (json as { uuid: string }).uuid);
	const { messages, hasOtherBranches } = activeBranch(chat);
	expect(`${f}: shape accepted`, true, `${chat.chat_messages.length} messages, ${messages.length} on current branch${hasOtherBranches ? ', has other branches' : ''}`);
	const types = new Map<string, number>();
	for (const m of chat.chat_messages) for (const b of m.content ?? []) types.set(b.type, (types.get(b.type) ?? 0) + 1);
	console.log(`      content block types: ${[...types].map(([k, v]) => `${k}×${v}`).join(', ')}`);
	const stem = baseName(chat.created_at, chat.name);
	const md = renderTranscript(chat, { projectName: 'Test project', jsonFileName: `${stem}.json` });
	expect(`${f}: transcript has frontmatter`, md.startsWith('---\nuuid: ') && md.includes('unread: true'));
	mkdirSync('samples/out', { recursive: true });
	writeFileSync(`samples/out/${stem}.md`, md);
	console.log(`      wrote samples/out/${stem}.md (${md.length} chars)`);
}

// --- files in a chat -------------------------------------------------------
if (existsSync('samples/chat-with-files.json')) {
	const fc = JSON.parse(readFileSync('samples/chat-with-files.json', 'utf8')) as { uuid: string };
	const chat = checkChat(fc, fc.uuid);
	const files = chatFiles(chat);
	expect('scooter chat: 5 files found', files.length === 5, files.map((f) => f.name).join(', '));
	expect('scooter chat: all are artifacts (Claude made them)', files.every((f) => f.kind === 'artifact'));
	expect('scooter chat: generate_case.py size 17094', files.find((f) => f.name === 'generate_case.py')?.sizeBytes === 17094);
	expect('scooter chat: two check_fit.py with different IDs', files.filter((f) => f.name === 'check_fit.py').length === 2);
	const paths = new Map([[files[0]!.fileUuid, 'X/Artifacts/chat/generate_case.py']]);
	const md = renderTranscript(chat, { jsonFileName: 'chat.json', filePaths: paths });
	expect('transcript links a saved file', md.includes('📎 [[X/Artifacts/chat/generate_case.py|generate_case.py]]'));
	expect('transcript names an unsaved file', md.includes('*Attachment: render.py*'));
}
expect('safeFileName keeps extension', safeFileName('my: file?.py') === 'my- file-.py', safeFileName('my: file?.py'));
expect('safeFileName no extension', safeFileName('README') === 'README');
expect('numbered', numbered('check_fit.py', 2) === 'check_fit (2).py');

// --- chat-view files (ReadConversation) ---------------------------------------
if (existsSync('samples/read-conversation.json')) {
	const rc: unknown = JSON.parse(readFileSync('samples/read-conversation.json', 'utf8'));
	const vis = visibleFiles(rc);
	const names = vis.map((f) => f.name);
	expect('chat view: both ZIPs found', names.includes('subnado_case_spiral.zip') && names.includes('subnado_case_hex.zip'), names.join(', '));
	expect('chat view: 3 renders found as images', vis.filter((f) => f.isImage).length === 3);
	expect('chat view: render ID 215b5d75 present', vis.some((f) => f.fileUuid.startsWith('215b5d75')));
	expect('chat view: ZIP size from fileSize', vis.find((f) => f.name === 'subnado_case_spiral.zip')?.sizeBytes === 30721056);
	expect('chat view: Claude made them -> artifacts', vis.every((f) => f.kind === 'artifact'));
	if (existsSync('samples/chat-with-files.json')) {
		const fc = JSON.parse(readFileSync('samples/chat-with-files.json', 'utf8')) as { uuid: string };
		const all = mergeFiles(chatFiles(checkChat(fc, fc.uuid)), vis);
		expect('merged: 10 distinct files (5 chat data + 3 renders + 2 ZIPs)', all.length === 10, String(all.length));
	}
}
expect('chat view: odd answer gives no files', visibleFiles({ nope: 1 }).length === 0 && visibleFiles(null).length === 0);

// --- following renames/moves ---------------------------------------------------
{
	const web = {
		index: { a: { updated_at: '', synced: '', json: 'C/Recent/x.json', md: 'C/Recent/x.md' } as IndexEntry },
		fileIndex: { f1: 'C/Recent/Artifacts/x/a.zip', f2: 'skipped: not found (404)', f3: 'C/Recentish/y.png' } as Record<string, string>,
	};
	const s = oneAccount(web, 'claude');
	expect('rename file: one path updated', followRename(s, 'C/Recent/x.md', 'C/Recent/x2.md') === 1 && web.index.a!.md === 'C/Recent/x2.md');
	const n = followRename(s, 'C/Recent', 'C/Old chats');
	expect('rename folder: everything under it follows', n === 3 && web.index.a!.json === 'C/Old chats/x.json' && web.fileIndex.f1 === 'C/Old chats/Artifacts/x/a.zip', String(n));
	expect('rename folder: similar-named folder untouched', web.fileIndex.f3 === 'C/Recentish/y.png');
	expect('rename: skipped marks untouched', web.fileIndex.f2 === 'skipped: not found (404)');
}

// --- protobuf helpers --------------------------------------------------------
{
	const req = encodeStrings({ 1: '81396b25-0a1a-408a-80b9-b8c669dac3e3', 5: 'en' });
	expect('proto: request is 42 bytes (2 tags + 2 lengths + 36 + 2)', req.length === 42, String(req.length));
	const back = decodeMessage(req);
	expect('proto: decodes back to the same fields', back['1']?.[0] === '81396b25-0a1a-408a-80b9-b8c669dac3e3' && back['5']?.[0] === 'en');
	// nested: field 2 = message { field 1 = "x.zip", field 3 = 123 }
	const inner = [0x0a, 5, ...new TextEncoder().encode('x.zip'), 0x18, 123];
	const outer = new Uint8Array([0x12, inner.length, ...inner]);
	const t = decodeMessage(outer);
	const nested = t['2']?.[0] as Record<string, unknown[]>;
	expect('proto: nested message read', nested?.['1']?.[0] === 'x.zip' && nested?.['3']?.[0] === 123);
}

// --- ChatGPT -------------------------------------------------------------------
{
	const gl = checkGptList(JSON.parse(readFileSync('samples/gpt/list.json', 'utf8')));
	expect('gpt list: shape accepted, 20 items of 41', gl.items.length === 20 && gl.total === 41);
	const sb = checkGptSidebar(JSON.parse(readFileSync('samples/gpt/sidebar-trimmed.json', 'utf8')));
	expect('gpt sidebar: 5 projects, no more', sb.projects.length === 5 && !sb.more, sb.projects.map((p) => p.name).join(', '));
	const li = toListItems(gl.items, sb.projects);
	const windsor = li.find((x) => x.name === 'Check Windsor GSC Access');
	expect('gpt: project chat gets project name', windsor?.project?.name === 'Agriland Website');
	expect('gpt: project subfolder', projectSubfolder(windsor!) === 'Agriland Website');
	expect('gpt: chat without project -> Recent', projectSubfolder(li[0]!) === 'Recent');
	const unknownProject = 'g-p-6a2824c3b0ec8191ab8055ecfdbb9999';
	expect('gpt: unknown project -> its ID as name', toListItems([{ ...gl.items[0]!, gizmo_id: unknownProject }], [])[0]!.project?.name === unknownProject);
	expect('gpt: custom GPT (g-…, not g-p-…) is not a project -> Recent', toListItems([{ ...gl.items[0]!, gizmo_id: 'g-gFt1ghYJl' }], [])[0]!.project === null);
	expect('gpt: filter by project', filterByProjects(li, ['Agriland Website']).length === 1);
	expect('gpt: new/changed works on ChatGPT items', pickTodo(li, {}).length === 20);
	let badGpt = false;
	try { checkGptList({ data: [] }); } catch { badGpt = true; }
	expect('gpt: unexpected list shape is rejected', badGpt);

	const chatRaw: unknown = JSON.parse(readFileSync('samples/gpt/chat.json', 'utf8'));
	const chat = checkGptChat(chatRaw, '6aed92dc-1728-83ed-86f3-0ee0c60a5b78');
	expect('gpt chat: shape accepted', chat.messages.length === 10);
	let wrongId = false;
	try { checkGptChat(chatRaw, '00000000-0000-0000-0000-000000000000'); } catch { wrongId = true; }
	expect('gpt chat: wrong ID is rejected', wrongId);
	const gf = gptChatFiles(chat);
	expect('gpt files: 3 images', gf.length === 3, gf.map((f) => `${f.name} (${f.kind})`).join(', '));
	expect('gpt files: upload keeps its name, is an attachment', gf.some((f) => f.name === '1000243990.jpg' && f.kind === 'attachment' && f.sizeBytes === 406561));
	expect('gpt files: generated image named after its title', gf.some((f) => f.name === 'ChatBridge Lake Zürich Branding.png' && f.kind === 'artifact'));
	expect('gpt files: second generated image', gf.some((f) => f.name === 'Purple Document Download Icon.png' && f.fileUuid === 'file_00000000538c8210b6771a485ff5ac5b'));
	expect('gpt file info parsed', checkGptFileInfo(JSON.parse(readFileSync('samples/gpt/file.json', 'utf8'))).size === 2422699);
	const paths = new Map([['file_00000000b5f08210bff2738c39102dea', 'G/Recent/Artifacts/x/ChatBridge.png']]);
	const md = renderGptTranscript(chat, { jsonFileName: 'x.json', filePaths: paths });
	expect('gpt transcript: frontmatter with chatgpt url', md.startsWith('---\nuuid: 6aed92dc') && md.includes('url: https://chatgpt.com/c/6aed92dc') && md.includes('unread: true'));
	expect('gpt transcript: created as ISO date', md.includes('created: 2026-11-06T08:42:05.149Z'), /created: .*/.exec(md)?.[0]);
	expect('gpt transcript: image not downloaded is still shown', md.includes('*[image – not downloaded]*\n\n## You') === false && (md.match(/image – not downloaded/g) ?? []).length === 2);
	expect('gpt transcript: your text', md.includes('## You') && md.includes('Obsidian AI chat importer'));
	expect('gpt transcript: ChatGPT text', md.includes('## ChatGPT') && md.includes('My proposal: **Conversa**'));
	expect('gpt transcript: saved image embedded', md.includes('![[G/Recent/Artifacts/x/ChatBridge.png]]'));
	expect('gpt transcript: tool steps collapsed', md.includes('*(1 tool step)*'));
	expect('gpt transcript: hidden system messages left out', !md.includes('## system'));
	const turns = md.match(/^## (You|ChatGPT) · /gm) ?? [];
	expect('gpt transcript: 4 turns (you, ChatGPT, you, ChatGPT)', turns.length === 4, String(turns.length));
	expect('gpt transcript: last turn = 1 tool step + the image', /## ChatGPT · [^\n]*\n\n\*\(1 tool step\)\*\n\n\*\[image – not downloaded\]\*\n*$/.test(md));
	mkdirSync('samples/out', { recursive: true });
	writeFileSync('samples/out/gpt-chat.md', md);
	console.log('      wrote samples/out/gpt-chat.md');

	const fake = 'xx "accessToken":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLTEyMw" yy';
	expect('gpt token found in page', findAccessToken(fake) === 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLTEyMw');
	expect('gpt token: escaped JSON works too', findAccessToken(fake.replace(/"/g, '\\"')) !== null);
	expect('gpt token: none -> null', findAccessToken('<html>no key</html>') === null);
	const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLTEyMw';
	const farAway = `["accessToken","x"${' '.repeat(2000)},"${jwt}"]`;
	expect('gpt token: value stored away from the label -> the only key in the page', findAccessToken(farAway) === jwt);
	expect('gpt token: two different keys far away -> null (no guessing)', findAccessToken(`${farAway} "${jwt.replace('c2ln', 'ZZZZ')}"`) === null);
	const desc = describePage(`<title>ChatGPT</title> "accessToken":"${jwt}" sessionKey=abcdefghijklmnopqrstuvwxyz0123`);
	expect('gpt page description hides the key', !desc.includes(jwt) && !desc.includes('abcdefghijklmnopqrstuvwxyz') && desc.includes('[key]') && desc.includes('"ChatGPT"'), desc);

	const marked = 'A entity["software","TriliumNext Notes"] test.citeturn1search1turn1search7 See urlWebsitehttps://triliumnotes.org/.\nimage_group{"query":["x"]}';
	const cleaned = cleanMarkers(marked);
	expect('gpt markers: name kept, source dropped, link made, gallery dropped', cleaned === 'A TriliumNext Notes test. See [Website](https://triliumnotes.org/).\n', JSON.stringify(cleaned));
	const withLayout = { ...chat, messages: [{ id: 'x', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['<box>raw layout</box>'] }, metadata: { model_dil_v2: { fallbackMarkdown: 'Clean **answer**' } }, recipient: 'all', channel: 'final' }] } as unknown as typeof chat;
	const mdLayout = renderGptTranscript(withLayout, { jsonFileName: 'x.json' });
	expect('gpt transcript: clean version used instead of layout code', mdLayout.includes('Clean **answer**') && !mdLayout.includes('<box>'));

	if (existsSync('samples/gpt/chat-genui.json')) {
		const gj: unknown = JSON.parse(readFileSync('samples/gpt/chat-genui.json', 'utf8'));
		const gc = checkGptChat(gj, (gj as { conversation_id: string }).conversation_id);
		const gmd = renderGptTranscript(gc, { jsonFileName: 'x.json' });
		writeFileSync('samples/out/gpt-chat-genui.md', gmd);
		expect('gpt real chat: no layout code left', !/<box|<AsyncImage|<Entity|<Cite|\{#each/.test(gmd));
		expect('gpt real chat: no hidden marker characters left', !/[-]/.test(gmd));
		expect('gpt real chat: names kept', gmd.includes('TriliumNext Notes') && gmd.includes('Anytype'));
		expect('gpt real chat: links kept (Markdown, or HTML inside a card)', gmd.includes('[Website](https://triliumnotes.org/)') || gmd.includes('<a href="https://triliumnotes.org/">Website</a>'));
		expect('gpt real chat: table kept', gmd.includes('| Platform |'));
	}

	{
		const msg = (id: string) => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: [id] } });
		const main = { ...chat, messages: [msg('m5'), msg('m6')] } as unknown as typeof chat;
		const joined = joinParts(main, [{ messages: [msg('m3'), msg('m4')] }, { messages: [msg('m1'), msg('m2'), msg('m3')] }] as unknown as Parameters<typeof joinParts>[1]);
		expect('gpt long chat: parts joined oldest first, each message once', joined.messages.map((m) => m.id).join(',') === 'm1,m2,m3,m4,m5,m6', joined.messages.map((m) => m.id).join(','));
		expect('gpt long chat: part file names', olderPartPath('G/Recent', '2026-10-20 X', 2) === 'G/Recent/2026-10-20 X (older 2).json');
		let badPage = false;
		try { checkGptOlderPage({ messages: [] }); } catch { badPage = true; }
		expect('gpt long chat: older part without page_info is rejected', badPage);
		expect('gpt long chat: older part with messages + page_info accepted', checkGptOlderPage({ messages: [msg('a')], page_info: { has_previous_page: false } }).messages.length === 1);
		const run = (id: string, t: number) => ({ id, author: { role: 'assistant' }, create_time: t, content: { content_type: 'text', parts: [`check ${id}`] }, recipient: 'all', channel: 'final' });
		const scheduled = { ...chat, messages: [run('r1', 1793379722), run('r2', 1793383166), run('r3', 1793386859)] } as unknown as typeof chat;
		const smd = renderGptTranscript(scheduled, { jsonFileName: 'x.json' });
		expect('gpt scheduled task: each run gets its own heading', (smd.match(/^## ChatGPT · /gm) ?? []).length === 3);
		expect('gpt normal chat: still 4 turns', (renderGptTranscript(chat, { jsonFileName: 'x.json' }).match(/^## (You|ChatGPT) · /gm) ?? []).length === 4);
		// Voice chats: synthetic parts shaped like a live voice chat (2026-11-10).
		const pointer = { content_type: 'real_time_user_audio_video_asset_pointer', frames_asset_pointers: [], video_container_asset_pointer: null,
			audio_asset_pointer: { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000aaaa', metadata: { transcription: null } } };
		const said = (text: string, direction: 'in' | 'out') => ({ content_type: 'audio_transcription', text, direction, decoding_id: null });
		const spoke = (mid: string, role: string, parts: unknown[], t: number) => ({ id: mid, author: { role }, create_time: t, content: { content_type: 'multimodal_text', parts }, recipient: 'all', channel: role === 'assistant' ? 'final' : null });
		const voice = { ...chat, messages: [
			spoke('v1', 'user', [pointer, said('Knowledge can be provisional.', 'in')], 1793379722),
			spoke('v2', 'assistant', [said('Yes, mark it as provisional.', 'out'), { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000bbbb', metadata: {} }], 1793379730),
			spoke('v3', 'user', ['Typed first.', pointer, said('Then spoken.', 'in')], 1793379740),
			spoke('v4', 'user', [pointer], 1793379750),
		] } as unknown as typeof chat;
		const vmd = renderGptTranscript(voice, { jsonFileName: 'x.json' });
		const turns = vmd.split(/^## /m).slice(1);
		expect('gpt voice: user pointer + transcription shows the words in your turn',
			turns[0]!.startsWith('You') && turns[0]!.includes('Knowledge can be provisional.') && !turns[0]!.includes('see raw JSON'), turns[0]);
		expect('gpt voice: ChatGPT spoken answer shows its words', turns[1]!.startsWith('ChatGPT') && turns[1]!.includes('Yes, mark it as provisional.') && !turns[1]!.includes('see raw JSON'), turns[1]);
		expect('gpt voice: typed text and spoken words kept in order',
			turns[2]!.startsWith('You') && turns[2]!.indexOf('Typed first.') < turns[2]!.indexOf('Then spoken.') && turns[2]!.indexOf('Typed first.') >= 0 && !turns[2]!.includes('voice message'), turns[2]);
		expect('gpt voice: audio without a transcription stays clearly marked', turns[3]!.startsWith('You') && turns[3]!.includes('no transcription available'), turns[3]);
		expect('gpt voice: 4 turns, no generic placeholders', turns.length === 4 && !vmd.includes('see raw JSON'));
		const transcribedPointer = { ...pointer, audio_asset_pointer: { ...pointer.audio_asset_pointer, metadata: { transcription: 'From the pointer.' } } };
		const fromPointer = renderGptTranscript({ ...chat, messages: [spoke('v5', 'user', [transcribedPointer], 1793379760)] } as unknown as typeof chat, { jsonFileName: 'x.json' });
		expect('gpt voice: transcription stored on the pointer is used', fromPointer.includes('From the pointer.') && !fromPointer.includes('no transcription'));
		expect('gpt voice: same input renders the same note', renderGptTranscript(voice, { jsonFileName: 'x.json' }) === vmd);
		// Layout answers (2026-11-10): structure kept, sources resolved, flat version as safety net.
		const laid = (text: string, flat: string, extra: object = {}) => renderGptTranscript({ ...chat, messages: [{ id: 'l1', author: { role: 'assistant' }, create_time: 1793379722,
			content: { content_type: 'text', parts: [text] }, metadata: { model_dil_v2: { fallbackMarkdown: flat, appData: { opGenui: { componentResults: {
				c1: { status: 'resolved', state: { items: [
					{ ref_id: 'turn1search0', url: 'https://example.org/docs', source_label: 'Example Docs' },
					{ ref_id: 'turn1search1', url: 'https://example.net/guide', source_label: 'Guide' }] } } } } } }, ...extra }, recipient: 'all', channel: 'final' }] } as unknown as typeof chat, { jsonFileName: 'x.json' });
		const diagram = 'Intro text. <Cite refs={["turn1search0","turn1search1"]}/>\n\n## Plan\n\n<box border radius="lg" padding={3}>\n  <box background="surface-secondary">\n    **Top**\n    <text color="secondary">First layer</text>\n  </box>\n  <box align="center">\n    <icon name="arrow-up-down"/>\n  </box>\n  <grid columns={2}>\n    <grid-item><box>**Left**\n    <text>Left job</text></box></grid-item>\n    <grid-item><box>**Right**\n    <text>Right job</text></box></grid-item>\n  </grid>\n  <caption>Only a proposal.</caption>\n</box>\n\nDone.';
		const flatDiagram = 'Intro text. \uE200cite\uE202turn1search0\uE202turn1search1\uE201\n\n## Plan\n\n**Top**\n\nFirst layer\n\n**Left**\n\nLeft job\n\n**Right**\n\nRight job\n\nOnly a proposal.\n\nDone.';
		const dmd = laid(diagram, flatDiagram);
		// One HTML block per visual: no blank line inside, or Obsidian would end the block there.
		const blocks = (md: string) => md.split('\n\n').filter((b) => b.startsWith('<div class="ccs-gpt">'));
		expect('gpt layout: sources become named links', dmd.includes('Intro text. [Example Docs](<https://example.org/docs>), [Guide](<https://example.net/guide>)'), dmd);
		expect('gpt layout: one HTML block for the diagram', blocks(dmd).length === 1 && blocks(dmd)[0]!.endsWith('</div>'), dmd);
		expect('gpt layout: bordered card holds a filled card', dmd.includes('<div class="ccs-gpt-box ccs-gpt-border"><div class="ccs-gpt-box ccs-gpt-fill"><div class="ccs-gpt-p"><strong>Top</strong></div>'), dmd);
		expect('gpt layout: muted text and centred arrow icon', dmd.includes('<div class="ccs-gpt-text ccs-gpt-muted"><div class="ccs-gpt-p">First layer</div></div>') &&
			dmd.includes('<div class="ccs-gpt-box ccs-gpt-plain ccs-gpt-center"><div class="ccs-gpt-p"><span class="ccs-gpt-icon" data-icon="arrow-up-down">⇅</span></div></div>'), dmd);
		expect('gpt layout: grid keeps its columns', dmd.includes('<div class="ccs-gpt-grid ccs-gpt-cols-2"><div class="ccs-gpt-cell"><div class="ccs-gpt-box ccs-gpt-plain"><div class="ccs-gpt-p"><strong>Left</strong></div>'), dmd);
		expect('gpt layout: caption, text before and after in order', dmd.includes('<div class="ccs-gpt-caption"><div class="ccs-gpt-p">Only a proposal.</div></div>') && dmd.indexOf('## Plan') < dmd.indexOf('ccs-gpt-grid') && dmd.indexOf('ccs-gpt-grid') < dmd.indexOf('Done.'));
		expect('gpt layout: no markup left', !/<\/?(box|grid|text|icon|caption|Cite)\b/.test(dmd));
		const flatOnly = laid(diagram, 'Intro text. \uE200cite\uE202turn1search0\uE201\n\nWords the layout does not have at all here, so trust the flat version instead please.');
		expect('gpt layout: flat version used when the layout would lose words', flatOnly.includes('Words the layout does not have') && flatOnly.includes('[Example Docs](<https://example.org/docs>)') && !flatOnly.includes('ccs-gpt'), flatOnly);
		const loop = laid('<grid columns={2}>\n  {#each [{name:"Alpha",d:\'one\'},{name:"Beta",d:"two"}] as a}\n  <grid-item><box>**{a.name}**\n  <caption>{a.d}</caption></box></grid-item>\n  {/each}\n</grid>', '-');
		expect('gpt layout: template loop over literal data is filled in', loop.includes('<strong>Alpha</strong>') && loop.includes('<div class="ccs-gpt-p">two</div>') && blocks(loop).length === 1, loop);
		const code = laid('{@body const [n,setN] = DIL.useState(1)}\n<box>Total: **{n*2}** {alert(1)}</box>', '-');
		expect('gpt layout: state setup dropped, computed values not run', code.includes('Total: <strong>…</strong> …') && !code.includes('@body'), code);
		const row = laid('<row><box width="40px"><icon name="folder"/></box><box flex="1">**1. <Entity value="A & B <x>"/>** costs <badge color="success">2 < 3</badge></box></row>', '-');
		expect('gpt layout: Markdown around inline pieces stays intact, text escaped', row.includes('<strong>1. A &amp; B &lt;x&gt;</strong> costs <span class="ccs-gpt-badge ccs-gpt-success"><div') === false && row.includes('<strong>1. A &amp; B &lt;x&gt;</strong> costs <span class="ccs-gpt-badge ccs-gpt-success">2 &lt; 3</span>'), row);
		expect('gpt layout: fixed-width and growing boxes in a row', row.includes('class="ccs-gpt-box ccs-gpt-plain ccs-gpt-fixed" style="width:40px"') && row.includes('ccs-gpt-box ccs-gpt-plain ccs-gpt-grow'), row);
		const svg = laid('<box border><svg viewBox="0 0 100 50" width="100%">\n  {#each [{x:10,t:"A"},{x:60,t:"B"}] as n}\n  <rect x={n.x} y="5" width={30} height="20" fillOpacity=".2" strokeWidth={2}/>\n  <text x={n.x+15} y="40" textAnchor="middle">{n.t}</text>\n  {/each}\n</svg></box>', '-');
		expect('gpt layout: SVG drawn inline with SVG attribute names',
			svg.includes('<rect x="10" y="5" width="30" height="20" fill-opacity=".2" stroke-width="2"/>') && svg.includes('<text x="75" y="40" text-anchor="middle">B</text>') && svg.includes('viewBox="0 0 100 50"') && blocks(svg).length === 1, svg);
		const svgCode = laid('<svg viewBox="0 0 9 9">{Array.from({length:3}).map((_,i)=><circle cx={i}/>)}</svg>', '-');
		expect('gpt layout: SVG built by code stays marked', svgCode.includes('Diagram – see raw JSON'), svgCode);
		const svgLinks = laid('<svg viewBox="0 0 9 9"><defs><circle id="d" r="1"/></defs><use href="#d"/><use href="https://example.net/x.svg#d"/><use xlinkHref="//example.net/y.svg"/><circle onClick="x()" r="2"/></svg>', '-');
		expect('gpt layout: SVG keeps only links inside the drawing', svgLinks.includes('<use href="#d"/>') && !svgLinks.includes('example.net') && !/onclick/i.test(svgLinks), svgLinks);
		const chartMd = laid('<Chart content={{"chartType":"line","meta":{"footer":"Daily data"},"xKey":"date","series":[{"dataKey":"clicks","label":"Clicks"}],"data":[{"date":"10 Oct","clicks":42},{"date":"11 Oct","clicks":70}]}}/>', '-');
		expect('gpt layout: chart data becomes bars with values', chartMd.includes('<span class="ccs-gpt-bar-label">10 Oct</span><span class="ccs-gpt-bar-track"><span class="ccs-gpt-bar" style="width:60%"></span></span><span class="ccs-gpt-bar-value">42</span>') && chartMd.includes('Daily data'), chartMd);
		const flatCite = cleanMarkers('See \uE200cite\uE202turn1search1\uE201.', [], new Map([['turn1search1', { url: 'https://example.net/guide', label: 'Guide' }]]));
		expect('gpt flat version: source chip resolved by ref', flatCite === 'See [Guide](<https://example.net/guide>).', flatCite);
		const gpt3 = { index: { c: { updated_at: '', synced: '', json: 'G/R/c.json', md: 'G/R/c.md', older: ['G/R/c (older 1).json'] } as IndexEntry }, fileIndex: {} };
		const s3 = oneAccount(gpt3, 'chatgpt');
		expect('rename: older parts follow too', followRename(s3, 'G/R', 'G/Q') === 3 && gpt3.index.c!.older![0] === 'G/Q/c (older 1).json');
	}

	const gpt2 = { index: { c: { updated_at: '', synced: '', json: 'G/Recent/c.json', md: 'G/Recent/c.md' } as IndexEntry }, fileIndex: { f: 'G/Recent/Artifacts/c/a.png' } as Record<string, string> };
	const s2 = oneAccount(gpt2, 'chatgpt');
	expect('rename: ChatGPT index follows too', followRename(s2, 'G/Recent', 'G/Old') === 3 && gpt2.fileIndex.f === 'G/Old/Artifacts/c/a.png');
}

// --- pasted session fallbacks (made-up values) ----------------------------
{
	const S = '__Secure-next-auth.session-token';
	const v = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..abcDEF123_-xyz';
	expect('fallback: bare ChatGPT value gets the cookie name', fallbackCookie(v) === `${S}=${v}`);
	expect('fallback: surrounding spaces and newline trimmed', fallbackCookie(`  ${v}\n`) === `${S}=${v}`);
	expect('fallback: whole header with split .0/.1 kept', fallbackCookie(`Cookie: ${S}.0=aaa; ${S}.1=bbb; cf_clearance=ccc`) === `${S}.0=aaa; ${S}.1=bbb; cf_clearance=ccc`);
	expect('fallback: too short or empty refused', fallbackCookie('short') === null && fallbackCookie('') === null);
	expect('fallback: header without the session cookie refused', fallbackCookie('foo=bar; baz=qux') === null);
	expect('fallback: empty session value refused', fallbackCookie(`${S}=; other=1`) === null);
	expect('fallback: no extra header can be smuggled in', fallbackCookie(`${S}=a\r\nX-Evil: 1`) === null && fallbackCookie(`${S}=a b`) === null);

	const google = 'SID=s1; HSID=h1; SAPISID=sap/abc; __Secure-1PSID=p1; __Secure-1PSIDTS=ts1; NID=n1';
	expect('google: whole header accepted', googleCookies(google)?.length === 6);
	expect('google: "Cookie:" prefix accepted', googleCookies(`cookie: ${google}`)?.length === 6);
	expect('google: needs __Secure-1PSID', googleCookies('SID=s1; SAPISID=sap') === null);
	expect('google: needs SAPISID (AI Studio signs with it)', googleCookies('SID=s1; __Secure-1PSID=p1') === null);
	expect('google: a bare value refused', googleCookies('p1longvaluewithoutaname') === null);
	expect('google: malformed part refused', googleCookies(`${google}; =x`) === null && googleCookies(`${google};\nX: 1`) === null);
	expect('cookies: pairs round trip', cookieText(cookiePairs('a=1;  b=2 ;')!) === 'a=1; b=2');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
