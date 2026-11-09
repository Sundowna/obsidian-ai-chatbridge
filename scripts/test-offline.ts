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
import type { IndexEntry } from '../src/types';

/** Settings with one account holding this index, for the rename tests. */
const oneAccount = (web: object, provider: 'claude' | 'chatgpt') => ({
	claude: provider === 'claude' ? [{ web, desktop: { index: {} } }] : [],
	chatgpt: provider === 'chatgpt' ? [{ web, desktop: { index: {} } }] : [],
} as unknown as Parameters<typeof followRename>[0]);
import { checkGptChat, checkGptFileInfo, checkGptList, checkGptOlderPage, checkGptSidebar } from '../src/chatgpt/schema';
import { joinParts, olderPartPath } from '../src/chatgpt/parts';
import { toListItems } from '../src/chatgpt/select';
import { gptChatFiles } from '../src/chatgpt/files';
import { cleanMarkers, renderGptTranscript } from '../src/chatgpt/transcript';
import { describePage, findAccessToken } from '../src/chatgpt/token';

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
		expect('gpt real chat: links kept', gmd.includes('[Website](https://triliumnotes.org/)'));
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
		const gpt3 = { index: { c: { updated_at: '', synced: '', json: 'G/R/c.json', md: 'G/R/c.md', older: ['G/R/c (older 1).json'] } as IndexEntry }, fileIndex: {} };
		const s3 = oneAccount(gpt3, 'chatgpt');
		expect('rename: older parts follow too', followRename(s3, 'G/R', 'G/Q') === 3 && gpt3.index.c!.older![0] === 'G/Q/c (older 1).json');
	}

	const gpt2 = { index: { c: { updated_at: '', synced: '', json: 'G/Recent/c.json', md: 'G/Recent/c.md' } as IndexEntry }, fileIndex: { f: 'G/Recent/Artifacts/c/a.png' } as Record<string, string> };
	const s2 = oneAccount(gpt2, 'chatgpt');
	expect('rename: ChatGPT index follows too', followRename(s2, 'G/Recent', 'G/Old') === 3 && gpt2.fileIndex.f === 'G/Old/Artifacts/c/a.png');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
