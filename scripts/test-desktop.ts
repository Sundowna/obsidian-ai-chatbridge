// Desktop apps test: parsers, renderer, scanner and a full sync run on a fake vault
// and a fake file system. Synthetic data only. Run: npm run test:desktop
// Optional: DESKTOP_LIVE=1 also runs a sync of the real session files on this computer into an
// in-memory vault (read-only on disk) and prints where each session would be saved.

import { parseClaudeSession, cleanClaudePrompt } from '../src/desktop/claude-code';
import { codexTitles, parseCodexSession } from '../src/desktop/codex';
import { renderDesktopTranscript, sessionFolderName } from '../src/desktop/render';
import { codexHomes, listSessionFiles, sameOrUnder, type DesktopFs } from '../src/desktop/scan';
import { runDesktopSync } from '../src/desktop/sync';
import { claudeGroups, claudePlacement, codexProjectFor, normFolder, parseClaudeMeta, parseCodexState } from '../src/desktop/sections';
import { findLatestJson, lastJsonObject, snappyDecompress } from '../src/desktop/leveldb';
import { layoutMoves, layoutRoot, moveToAppLayout } from '../src/desktop/layout';
import { mergeDesktop, normalizeSettings } from '../src/migrate';
import { addAccount, nameProblem, removeAccount } from '../src/accounts';
import { desktopOwner } from '../src/desktop/sync';
import { claudeAuth } from '../src/claude-auth';
import { followRename } from '../src/follow';
import { type ChatgptAccount, type ClaudeAccount, type Settings } from '../src/settings';
import { FileSystemAdapter, TFile, TFolder } from 'obsidian';
import { newestFirst } from '../src/select';
import { tagAccount, untagAccount } from '../src/naming';
import { refreshEntries, type IndexedPaths } from '../src/reindex';
import { massMissing } from '../src/missing-guard';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
const jl = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join('\n') + '\n';

// --- Claude Code ---------------------------------------------------------
const SID = '11111111-2222-3333-4444-555555555555';
const claudeFile = jl(
	{ type: 'session-owner', sessionId: SID },
	{ type: 'user', isSidechain: false, cwd: 'D:\\BrainTest', sessionId: SID, timestamp: '2026-11-06T10:00:00.000Z', message: { role: 'user', content: 'Build the thing\n\n<linked_content path="01 Daily/x.md" />' } },
	{ type: 'user', isMeta: true, timestamp: '2026-11-06T10:00:01.000Z', message: { role: 'user', content: 'meta stuff' } },
	{ type: 'attachment', timestamp: '2026-11-06T10:00:01.000Z', attachment: { type: 'environment' } },
	{ type: 'assistant', timestamp: '2026-11-06T10:00:02.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'secret' }] } },
	{ type: 'assistant', timestamp: '2026-11-06T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] } },
	{ type: 'assistant', timestamp: '2026-11-06T10:00:04.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } },
	{ type: 'user', timestamp: '2026-11-06T10:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'file body' }] } },
	{ type: 'assistant', timestamp: '2026-11-06T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } },
	{ type: 'assistant', timestamp: '2026-11-06T10:00:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
	{ type: 'user', timestamp: '2026-11-06T10:05:00.000Z', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
	{ type: 'user', timestamp: '2026-11-06T10:06:00.000Z', message: { role: 'user', content: '<task-notification>bg done</task-notification>' } },
	{ type: 'user', timestamp: '2026-11-06T10:07:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Thanks <system-reminder>x</system-reminder>' }] } },
	{ type: 'ai-title', aiTitle: 'AI made title', sessionId: SID },
	{ type: 'custom-title', customTitle: 'My title', sessionId: SID },
) + '{"type":"user","trunc';
const cs = parseClaudeSession(claudeFile, SID)!;
expect('claude: parsed', !!cs);
expect('claude: id from file name', cs.id === SID && parseClaudeSession(claudeFile, 'fork-file')!.id === 'fork-file');
expect('claude: custom title wins', cs.title === 'My title');
expect('claude: cwd and model', cs.cwd === 'D:\\BrainTest' && cs.model === 'claude-opus-5-5');
expect('claude: 4 turns (You, Claude, You, …)', cs.turns.length === 3 && cs.turns.map((t) => t.role).join() === 'user,assistant,user', cs.turns.map((t) => t.role).join());
const asst = cs.turns[1]!.parts;
expect('claude: tool steps merged across tool results', JSON.stringify(asst) === JSON.stringify([{ text: 'Looking.' }, { tools: 2 }, { text: 'Done.' }]), JSON.stringify(asst));
expect('claude: system reminders stripped', cs.turns[2]!.parts[0]!.toString() !== '' && (cs.turns[2]!.parts[0] as { text: string }).text === 'Thanks');
expect('claude: linked file shown', (cs.turns[0]!.parts[0] as { text: string }).text.includes('📎 01 Daily/x.md'));
expect('claude: thinking left out', !JSON.stringify(cs.turns).includes('secret'));
expect('claude: dates', cs.created === '2026-11-06T10:00:00.000Z' && cs.updated === '2026-11-06T10:07:00.000Z');
expect('claude: slash command', cleanClaudePrompt('<command-name>/compact</command-name><command-args>now</command-args>') === '`/compact now`');
expect('claude: pasted text quoted', cleanClaudePrompt('<pasted_content id="a">\nhello\n</pasted_content>').startsWith('> [!quote] Pasted\n> hello'));
expect('claude: empty session is null', parseClaudeSession(jl({ type: 'session-owner' }), 'x') === null);
const side = parseClaudeSession(jl({ type: 'user', isSidechain: true, timestamp: '2026-11-06T10:00:00Z', message: { role: 'user', content: 'sub task' } }), 'x')!;
expect('claude: sidechain marked as subagent', side.isSubagent === true);

// --- Codex ---------------------------------------------------------------
const TID = '01a1b0b2-fd16-78b1-9634-c3fc1d130825';
const item = (time: string, it: unknown) => ({ timestamp: time, type: 'event_msg', payload: { type: 'item_completed', item: it } });
const codexFile = jl(
	{ timestamp: '2026-11-06T11:51:22.000Z', type: 'session_meta', payload: { id: TID, timestamp: '2026-11-06T11:51:22.000Z', cwd: 'D:\\BrainTest\\SecondBrain\\Open', source: 'vscode', thread_source: 'user', forked_from_id: 'parent-1' } },
	{ timestamp: '2026-11-06T11:51:23.000Z', type: 'turn_context', payload: { model: 'gpt-6' } },
	{ timestamp: '2026-11-06T11:51:23.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
	item('2026-11-06T11:53:00.000Z', { type: 'UserMessage', content: [{ type: 'text', text: 'Fix the sync' }] }),
	item('2026-11-06T11:53:05.000Z', { type: 'Reasoning', summary_text: ['hmm'] }),
	item('2026-11-06T11:53:06.000Z', { type: 'AgentMessage', content: [{ type: 'Text', text: 'Checking.' }], phase: 'commentary' }),
	item('2026-11-06T11:53:07.000Z', { type: 'CommandExecution', command: ['ls'] }),
	item('2026-11-06T11:53:08.000Z', { type: 'FileChange', changes: {} }),
	item('2026-11-06T11:53:09.000Z', { type: 'AgentMessage', content: [{ type: 'Text', text: 'Fixed.' }], phase: 'final_answer' }),
	item('2026-11-06T11:54:00.000Z', { type: 'UserMessage', content: [{ type: 'text', text: 'Thanks' }, { type: 'image' }] }),
);
const titles = codexTitles(jl({ id: TID, thread_name: 'Old name' }, { id: TID, thread_name: 'Fix ChatBridge sync' }));
const cx = parseCodexSession(codexFile, titles)!;
expect('codex: parsed', !!cx && cx.id === TID);
expect('codex: latest title from session index', cx.title === 'Fix ChatBridge sync');
expect('codex: injected context ignored', cx.turns[0]?.role === 'user' && (cx.turns[0].parts[0] as { text: string }).text === 'Fix the sync');
expect('codex: turns and tool steps', JSON.stringify(cx.turns.map((t) => t.parts)) === JSON.stringify([[{ text: 'Fix the sync' }], [{ text: 'Checking.' }, { tools: 2 }, { text: 'Fixed.' }], [{ text: 'Thanks\n\n*[image]*' }]]), JSON.stringify(cx.turns.map((t) => t.parts)));
expect('codex: model, fork, not subagent', cx.model === 'gpt-6' && cx.forkedFrom === 'parent-1' && !cx.isSubagent);
expect('codex: title falls back to first prompt', parseCodexSession(codexFile)!.title === 'Fix the sync');
const guardian = parseCodexSession(jl(
	{ timestamp: '2026-11-07T08:00:00Z', type: 'session_meta', payload: { id: 'g1', parent_thread_id: 'p', source: { subagent: { other: 'guardian' } } } },
	{ timestamp: '2026-11-07T08:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Judge this action' }] } },
))!;
expect('codex: guardian review marked as subagent (fallback format)', guardian.isSubagent && guardian.turns[0]?.role === 'user');
const legacy = parseCodexSession(jl(
	{ timestamp: '2025-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'L1' } },
	{ timestamp: '2025-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
	{ timestamp: '2025-01-01T00:00:02Z', type: 'response_item', payload: { type: 'function_call' } },
	{ timestamp: '2025-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } },
))!;
expect('codex: older event_msg format', JSON.stringify(legacy.turns.map((t) => t.parts)) === JSON.stringify([[{ text: 'hello' }], [{ tools: 1 }, { text: 'hi' }]]));

// --- render --------------------------------------------------------------
expect('folder: last part of cwd', sessionFolderName('D:\\BrainTest\\SecondBrain\\Open', 'Other') === 'Open');
expect('folder: scratch workspace', sessionFolderName('C:\\Users\\W\\AppData\\Local\\Claude\\Data\\x\\scratch\\workspaces\\abc', 'Other') === 'Scratch');
expect('folder: codex scratch thread', sessionFolderName('C:/Users/W/Documents/Codex/2026-11-03/find-the-gpu', 'Other') === 'Scratch');
expect('claude: app title wins', parseClaudeSession(claudeFile, SID, new Map([[SID, 'From app']]))!.title === 'From app');
// --- sections ------------------------------------------------------------
const metaA = parseClaudeMeta(JSON.stringify({ sessionId: 'local_a', cliSessionId: 'cli-a', priorCliSessionIds: ['cli-a0'], title: 'Parent' }))!;
const metaB = parseClaudeMeta(JSON.stringify({ sessionId: 'local_b', cliSessionId: 'cli-b', title: 'Fork', forkedFromSessionId: 'local_a' }))!;
const metaC = parseClaudeMeta(JSON.stringify({ sessionId: 'local_c', cliSessionId: 'cli-c', title: 'Side', spawnedFrom: { sessionId: 'local_b' } }))!;
expect('meta: ids, prior ids, title', metaA.localId === 'local_a' && metaA.cliIds.join() === 'cli-a,cli-a0' && metaA.title === 'Parent');
expect('meta: parent from fork or spawn', metaB.parentLocalId === 'local_a' && metaC.parentLocalId === 'local_b' && parseClaudeMeta('{}') === null);
const groupsValue = { 'acc/org': { groups: [{ id: 'g1', name: 'Obsidian', mode: 'code' }], assignments: { 'code:local_a': 'g1', 'code:local_x': 'gone' }, order: {} } };
const groups = claudeGroups(groupsValue);
expect('groups: assignment -> name, unknown group ignored', groups.get('local_a') === 'Obsidian' && groups.size === 1);
const metas = new Map([metaA, metaB, metaC].map((m) => [m.localId, m]));
expect('placement: own group, no parent', JSON.stringify(claudePlacement('local_a', metas, groups)) === JSON.stringify({ group: 'Obsidian' }));
const pc = claudePlacement('local_c', metas, groups);
expect('placement: grandchild inherits group, nested under its parent', pc.group === 'Obsidian' && pc.parentTitle === 'Fork');
expect('placement: no group', claudePlacement('local_z', metas, groups).group === undefined);
const codexState = parseCodexState(JSON.stringify({
	'local-projects': { p1: { name: '2nd Brain', rootPaths: ['D:\\BrainTest\\SecondBrain\\Open'] }, p2: { name: 'Sub', rootPaths: ['D:\\BrainTest\\SecondBrain\\Open\\Sub'] } },
	'thread-project-assignments': { t9: { projectKind: 'local', projectId: 'p2' } },
}));
expect('codex: project by folder (\\\\?\\ prefix, case)', codexProjectFor(codexState, 't1', String.raw`\\?\d:\braintest\secondbrain\open`) === '2nd Brain');
expect('codex: deepest project folder wins', codexProjectFor(codexState, 't1', 'D:/BrainTest/SecondBrain/Open/Sub/x') === 'Sub');
expect('codex: assignment wins over folder', codexProjectFor(codexState, 't9', 'C:/elsewhere') === 'Sub');
expect('codex: no project', codexProjectFor(codexState, 't1', 'C:/Users/W/Documents/Codex/2026-11-03/x') === undefined && normFolder('C:\\A\\') === 'c:/a');

// --- leveldb -------------------------------------------------------------
const lit = (s: string) => new TextEncoder().encode(s);
// Snappy: literal "abcd" then a copy of 4 bytes from offset 4 -> "abcdabcd".
expect('snappy: literal + copy', new TextDecoder().decode(snappyDecompress(new Uint8Array([8, 3 << 2, 97, 98, 99, 100, 0x01, 4]))) === 'abcdabcd');
expect('json: last parseable copy wins', JSON.stringify(lastJsonObject('x"k":{"a":1}y"k":{"a":2,"s":"}"}z"k":{broken', 'k')) === '{"a":2,"s":"}"}');
const logA = lit(`junk "customGroupsByScope":${JSON.stringify({ old: { groups: [], assignments: {} } })}`);
const logB = lit(`\u0001"customGroupsByScope":${JSON.stringify(groupsValue)} tail`);
expect('leveldb: newest file wins', claudeGroups(findLatestJson([['000005.log', logA], ['000158.log', logB]], 'customGroupsByScope')).get('local_a') === 'Obsidian');
const utf16 = new Uint8Array(Array.from(`"customGroupsByScope":${JSON.stringify(groupsValue)}`).flatMap((c) => [c.charCodeAt(0), 0]));
expect('leveldb: UTF-16 value', claudeGroups(findLatestJson([['000009.log', utf16]], 'customGroupsByScope')).size === 1);
expect('folder: drive root and missing', sessionFolderName('D:\\', 'Other') === 'Other' && sessionFolderName(undefined, 'Other') === 'Other');
const md = renderDesktopTranscript(cs, { source: 'C:\\Users\\W\\.claude\\projects\\D--BrainTest\\x.jsonl', rawFileName: 'x.jsonl' });
expect('render: frontmatter', md.startsWith('---\napp: "Claude desktop"\nsession: ' + SID) && md.includes('source: "C:/Users/W/.claude/projects/D--BrainTest/x.jsonl"') && md.includes('raw: "[[x.jsonl]]"') && md.includes('unread: true'));
expect('render: speakers and tool line', md.includes('## You · ') && md.includes('## Claude · ') && md.includes('*(2 tool steps)*'));

// --- fake file system + vault -------------------------------------------
class FakeFs implements DesktopFs {
	home = 'C:/Users/W';
	files = new Map<string, { text: string; mtime: number }>();
	env = (n: string) => (n === 'LOCALAPPDATA' ? 'C:/Users/W/AppData/Local' : undefined);
	put(path: string, text: string, mtime: number) {
		this.files.set(path, { text, mtime });
	}
	async readDir(dir: string) {
		const pre = dir.replace(/\/$/, '') + '/';
		const out = new Map<string, boolean>();
		for (const p of this.files.keys()) {
			if (!p.startsWith(pre)) continue;
			const rest = p.slice(pre.length).split('/');
			out.set(rest[0]!, rest.length > 1);
		}
		return [...out].map(([name, dir]) => ({ name, dir }));
	}
	async stat(p: string) {
		const f = this.files.get(p);
		return f ? { size: f.text.length, mtimeMs: f.mtime } : null;
	}
	async readText(p: string) {
		return this.files.get(p)?.text ?? null;
	}
	async readBytes(p: string) {
		const f = this.files.get(p);
		return f ? new TextEncoder().encode(f.text) : null;
	}
}

const vaultFiles = new Map<string, string>();
const vaultFolders = new Set<string>();
const vault = {
	getAbstractFileByPath: (p: string) => (vaultFiles.has(p) ? Object.assign(new TFile(), { path: p }) : vaultFolders.has(p) ? {} : null),
	createFolder: async (p: string) => void vaultFolders.add(p),
	create: async (p: string, d: string) => {
		if (vaultFiles.has(p)) throw new Error('exists ' + p);
		vaultFiles.set(p, d);
	},
	process: async () => undefined,
};
const settings: Settings = normalizeSettings({ maxChatsPerRun: 0, chatFolder: '30 Sources/AI Chats/Claude Chat', logPath: 'log.md' }).settings;
expect('settings: layout next to Claude Chat', settings.claude[0]!.desktop.folder === '30 Sources/AI Chats/Claude/Code-Local/This computer' && settings.chatgpt[0]!.desktop.folder === '30 Sources/AI Chats/ChatGPT/Codex-Local/This computer');
{
	const catalog = { fetchedAt: 't', rows: [{ id: 'a', name: 'Ticked' }, { id: 'b', name: 'Private' }] };
	const lumoWeb = (projects: string[]) => normalizeSettings({ claude: [{}], chatgpt: [{}], lumo: [{ web: { projects, projectCatalog: catalog } }] }).settings.lumo[0]!.web;
	expect('settings: unticked Lumo names are dropped on load', lumoWeb(['a']).projectCatalog?.rows.map((r) => r.name).join() === 'Ticked');
	expect('settings: no Lumo names kept when nothing is ticked', lumoWeb([]).projectCatalog === undefined);
	const chatgpt = normalizeSettings({ claude: [{}], chatgpt: [{ web: { projects: [], projectCatalog: catalog } }] }).settings.chatgpt[0]!.web;
	expect('settings: other providers keep their list', chatgpt.projectCatalog?.rows.length === 2);
}
expect('settings: saved values win', mergeDesktop({ claude: { enabled: false, folder: 'X', extraFolders: [], index: {} } } as never, 'A/B').claude.folder === 'X');
const from016 = mergeDesktop({ claude: { enabled: true, folder: 'S/Claude Desktop', extraFolders: [], index: {} }, codex: { enabled: true, folder: 'S/Codex', extraFolders: [], index: {} } } as never, 'S/Claude Chat');
expect('settings: unused 0.16.0 folders move to the layout', from016.claude.folder === 'S/Claude/Code-Local/This computer' && from016.codex.folder === 'S/ChatGPT/Codex-Local/This computer');
const used016 = mergeDesktop({ codex: { enabled: true, folder: 'S/Codex', extraFolders: [], index: { t: {} } } } as never, 'S/Claude Chat');
expect('settings: used 0.16.0 folder is kept', used016.codex.folder === 'S/Codex');
expect('layout: root next to or above the chat folder', layoutRoot('S/Claude Chat') === 'S' && layoutRoot('S/Claude Desktop/Chat') === 'S' && layoutRoot('S/Claude/Chat') === 'S' && layoutRoot('Claude Chat') === '');

// Sync order: newest change first, also for chats being repaired.
{
	const job = (id: string, at: string) => ({ item: { uuid: id, updated_at: at } });
	const order = newestFirst([job('old', '2026-01-01T00:00:00Z'), job('new', '2026-11-10T00:00:00Z'), job('mid', '2026-06-01T00:00:00Z')]).map((j) => j.item.uuid).join();
	expect('order: newest first', order === 'new,mid,old', order);
}

// account: in the front matter.
{
	const md = '---\nuuid: x\nunread: true\n---\n\nHi';
	const tagged = tagAccount(md, 'B - Yearly');
	expect('account: right after the opening line, quoted', tagged === '---\naccount: "B - Yearly"\nuuid: x\nunread: true\n---\n\nHi', tagged);
	expect('account: left out for comparing', untagAccount(tagged) === md && untagAccount(md) === md);
	expect('account: nothing added without front matter', tagAccount('Hi', 'A') === 'Hi');
}

// Refresh index: finds moved notes by chat ID, raw files by link or unique name.
{
	const files = new Set(['New/a.md', 'New/b.md', 'New/c.md', 'Raw/a.json', 'Other/b.json', 'Twice/c.json', 'Again/c.json']);
	const entry = (id: string, md: string, raws: string[]) => {
		const e = { id, md, raws: [...raws] } as IndexedPaths;
		e.setMd = (p) => (e.md = p);
		e.setRaw = (k, p) => (e.raws[k] = p);
		return e;
	};
	const moved = entry('a', 'Old/a.md', ['Old/a.json']);
	const rawOnly = entry('b', 'New/b.md', ['Gone/b.json']);
	const ambiguous = entry('c', 'New/c.md', ['Gone/c.json']);
	const lost = entry('d', 'Old/d.md', ['Old/d.json']);
	const r = refreshEntries([moved, rawOnly, ambiguous, lost], {
		exists: (p) => files.has(p),
		transcriptOf: (id) => (id === 'a' ? 'New/a.md' : null),
		rawLinkOf: (md) => (md === 'New/a.md' ? 'Raw/a.json' : null),
		uniqueByName: (name) => ({ 'b.json': 'Other/b.json' } as Record<string, string>)[name] ?? null,
	});
	expect('reindex: moved transcript found by chat ID', moved.md === 'New/a.md' && moved.raws[0] === 'Raw/a.json');
	expect('reindex: raw file found by unique name', rawOnly.raws[0] === 'Other/b.json');
	expect('reindex: a name found twice is not guessed', ambiguous.raws[0] === 'Gone/c.json');
	expect('reindex: counts', r.checked === 4 && r.relinked === 3 && r.missing === 1 && lost.md === 'Old/d.md', JSON.stringify(r));
}
const plugin = { app: { vault, fileManager: { processFrontMatter: async () => undefined } }, settings, saveSettings: async () => undefined } as never;

(async () => {
	const fs = new FakeFs();
	const NOW = Date.parse('2026-11-07T12:00:00Z');
	const old = NOW - 3600_000;
	const cPath = `C:/Users/W/.claude/projects/D--BrainTest/${SID}.jsonl`;
	fs.put(cPath, claudeFile, old);
	fs.put(`C:/Users/W/.claude/projects/D--BrainTest/${SID}/subagents/agent-1.jsonl`, claudeFile, old);
	fs.put('C:/Users/W/.claude/projects/D--BrainTest/active.jsonl', claudeFile.replace(SID, 'aaaa'), NOW - 60_000);
	fs.put('C:/Users/W/.claude/projects/D--BrainTest/empty.jsonl', jl({ type: 'session-owner' }), old);
	fs.put('C:/Users/W/.codex/sessions/2026/11/06/rollout-a.jsonl', codexFile, old);
	fs.put('C:/Users/W/.codex/sessions/2026/11/07/rollout-g.jsonl', jl({ timestamp: '2026-11-07T08:00:00Z', type: 'session_meta', payload: { id: 'g1', source: { subagent: 'x' } } }, { timestamp: '2026-11-07T08:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Judge' }] } }), old);
	fs.put('C:/Users/W/.codex/session_index.jsonl', jl({ id: TID, thread_name: 'Fix ChatBridge sync' }), old);
	const appData = 'C:/Users/W/AppData/Local/Claude-Data/claude_x';
	fs.put(`${appData}/claude-code-sessions/acc/org/local_abc.json`, JSON.stringify({ sessionId: 'local_abc', cliSessionId: SID, title: 'Sidebar title', titleSource: 'user' }), old);
	fs.put(`${appData}/claude-code-sessions/acc/org/local_fork.json`, JSON.stringify({ sessionId: 'local_fork', cliSessionId: 'fork-1', title: 'Sidebar title (fork)', forkedFromSessionId: 'local_abc' }), old);
	fs.put(`${appData}/Local Storage/leveldb/000003.log`, `"customGroupsByScope":${JSON.stringify({ 'acc/org': { groups: [{ id: 'g1', name: 'Obsidian' }], assignments: { 'code:local_abc': 'g1' } } })}`, old);
	fs.put('C:/Users/W/.claude/projects/D--BrainTest/fork-1.jsonl', claudeFile.replace(new RegExp(SID, 'g'), 'fork-1'), old);
	fs.put('C:/Users/W/.codex/.codex-global-state.json', JSON.stringify({ 'local-projects': { p: { name: '2nd Brain', rootPaths: ['D:\\BrainTest\\SecondBrain\\Open'] } } }), old);
	fs.put('E:/Cowork/s1.jsonl', claudeFile.replace(new RegExp(SID, 'g'), 'cowork-1'), old);

	const listed = await listSessionFiles(fs, 'claude', []);
	expect('scan: subagents folder skipped', listed.length === 4 && !listed.some((f) => f.path.includes('subagents')), listed.map((f) => f.path).join());
	expect('scan: codex index file is not a session', (await listSessionFiles(fs, 'codex', [])).length === 2);

	settings.claude[0]!.desktop.extraFolders = ['E:\\Cowork'];
	const r1 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 1: no stop', !r1.stopped, r1.stopped);
	expect('sync 1: 4 new (claude, fork, codex, extra folder)', r1.newCount === 4, JSON.stringify(r1));
	expect('sync 1: active session waits', r1.active === 1);
	expect('sync 1: empty + guardian skipped', r1.empty === 2);
	const code = '30 Sources/AI Chats/Claude/Code-Local/This computer';
	const claudeMd = `${code}/Obsidian/2026-11-06 Sidebar title.md`;
	expect('sync 1: claude session in its sidebar group', vaultFiles.has(claudeMd), [...vaultFiles.keys()].join(' | '));
	expect('sync 1: fork nested under its parent in the same group', vaultFiles.has(`${code}/Obsidian/Sidebar title/2026-11-06 Sidebar title (fork).md`));
	expect('sync 1: session outside a group by working folder', vaultFiles.has(`${code}/BrainTest/2026-11-06 My title.md`));
	expect('sync 1: codex thread in its project', vaultFiles.has('30 Sources/AI Chats/ChatGPT/Codex-Local/This computer/2nd Brain/2026-11-06 Fix ChatBridge sync.md'));
	expect('sync 1: section in frontmatter', vaultFiles.get(claudeMd)!.includes('section: "Obsidian"'));
	expect('sync 1: no raw copy by default', ![...vaultFiles.keys()].some((p) => p.endsWith('.jsonl')));

	const r2 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 2: nothing new, unchanged counted', r2.newCount === 0 && r2.changedCount === 0 && r2.unchanged === 4, JSON.stringify(r2));
	expect('sync 2: groups cached for when the app storage is unreadable', settings.claude[0]!.desktop.groupCache?.local_abc === 'Obsidian');

	// Session continues: new transcript as "(updated …)", old one kept.
	fs.put(cPath, claudeFile + '\n' + jl({ type: 'user', timestamp: '2026-11-07T09:00:00.000Z', message: { role: 'user', content: 'One more thing' } }), old + 1000);
	settings.desktop.keepRaw = true;
	const r3 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 3: changed session written as update', r3.changedCount === 1 && /\(updated 2026-11-07 \d{4}\)$/.test(r3.written[0] ?? ''), JSON.stringify(r3.written));
	expect('sync 3: raw copy next to it', [...vaultFiles.keys()].some((p) => p.endsWith('(updated 2026-11-07 ' + r3.written[0]!.slice(-5, -1) + ').jsonl')));
	expect('sync 3: old transcript untouched', vaultFiles.has(claudeMd));

	// Raw session folder: the next update's .jsonl goes there, mirrored, linked by path.
	settings.rawRootOn = false; // own raw session folder: only with the raw files folder off
	settings.claude[0]!.desktop.rawFolder = 'Raw/Claude Code';
	fs.put(cPath, claudeFile + '\n' + jl({ type: 'user', timestamp: '2026-11-07T10:00:00.000Z', message: { role: 'user', content: 'And another' } }), old + 2000);
	const r3b = await runDesktopSync(plugin, undefined, fs, NOW);
	const e3b = settings.claude[0]!.desktop.index[SID]!;
	expect('raw folder: .jsonl mirrored into the raw session folder', r3b.changedCount === 1 && !!e3b.raw?.startsWith('Raw/Claude Code/Obsidian/') && vaultFiles.has(e3b.raw!), e3b.raw);
	expect('raw folder: transcript stays in the code folder', e3b.md.startsWith(`${code}/Obsidian/`));
	expect('raw folder: transcript links the raw copy by path', (vaultFiles.get(e3b.md) ?? '').includes(`raw: "[[${e3b.raw}]]"`));
	delete settings.claude[0]!.desktop.rawFolder;

	// Master raw folder (General): the next update's .jsonl goes to it, at the transcript's path.
	settings.rawRootOn = true;
	settings.claude[0]!.desktop.rawFolder = 'Raw/Claude Code'; // hidden and ignored while on
	settings.rawRoot = '80 Archive/raw';
	fs.put(cPath, claudeFile + '\n' + jl({ type: 'user', timestamp: '2026-11-07T10:00:00.000Z', message: { role: 'user', content: 'And another' } }) + '\n' + jl({ type: 'user', timestamp: '2026-11-07T10:01:00.000Z', message: { role: 'user', content: 'One more' } }), old + 3000);
	const r3c = await runDesktopSync(plugin, undefined, fs, NOW);
	const e3c = settings.claude[0]!.desktop.index[SID]!;
	const mdDir = e3c.md.split('/').slice(0, -1).join('/');
	expect('master raw: .jsonl under the master folder at the transcript path', r3c.changedCount === 1 && e3c.raw === `80 Archive/raw/${mdDir}/${e3c.md.split('/').pop()!.replace(/\.md$/, '.jsonl')}` && vaultFiles.has(e3c.raw!), e3c.raw);
	expect('master raw: transcript links it by path', (vaultFiles.get(e3c.md) ?? '').includes(`raw: "[[${e3c.raw}]]"`));
	delete settings.claude[0]!.desktop.rawFolder;

	// Codex archives a thread: file moves, content same -> no new transcript.
	const t = fs.files.get('C:/Users/W/.codex/sessions/2026/11/06/rollout-a.jsonl')!;
	fs.files.delete('C:/Users/W/.codex/sessions/2026/11/06/rollout-a.jsonl');
	fs.put('C:/Users/W/.codex/archived_sessions/rollout-a.jsonl', t.text, t.mtime);
	const r4 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 4: moved file is not new', r4.newCount === 0 && r4.changedCount === 0, JSON.stringify(r4));
	expect('sync 4: index follows the move', settings.chatgpt[0]!.desktop.index[TID]!.source.includes('archived_sessions'));

	// Deleted transcript is written again under the same name.
	const codexMd = settings.chatgpt[0]!.desktop.index[TID]!.md;
	vaultFiles.delete(codexMd);
	const r5 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 5: deleted transcript restored', r5.restored.length === 1 && vaultFiles.has(codexMd));

	// Moving the folder in Obsidian updates the desktop index.
	const n = followRename(settings, '30 Sources/AI Chats/ChatGPT/Codex-Local/This computer', '30 Sources/AI Chats/OpenAI Codex');
	expect('rename: desktop index follows', n === 1 && settings.chatgpt[0]!.desktop.index[TID]!.md.startsWith('30 Sources/AI Chats/OpenAI Codex/'));

	settings.claude[0]!.desktop.enabled = false;
	settings.chatgpt[0]!.desktop.enabled = false;
	const r6 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('disabled: nothing read', r6.listed === 0);

	await accountsTest();
	await layoutTest(false);
	await layoutTest(true);
	await filesTest();
	await codexFilesTest();
	await guardTest();
	if (process.env.DESKTOP_LIVE) await live();
	console.log(failures ? `\n${failures} FAILED` : '\nAll desktop tests passed.');
	process.exit(failures ? 1 : 0);
})();

/** Several accounts: migration, naming, and which account a desktop session goes to. */
async function accountsTest() {
	const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
	const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
	const legacy = { orgId: ORG_A, chatFolder: 'S/Claude Chat', codeFolder: 'S/Code', maxChatsPerRun: 7, projects: ['P'], index: { c1: { updated_at: 'u', json: 'j', md: 'm', synced: 's' } }, fileIndex: { f1: 'p' }, gpt: { folder: 'S/GPT', index: { g1: { updated_at: 'u', json: 'j', md: 'm', synced: 's' } }, cooldownUntil: 42 }, desktop: { keepRaw: true, claude: { enabled: false, folder: 'S/DC', extraFolders: ['X'], index: { d1: {} } }, codex: { enabled: true, folder: 'S/DX', extraFolders: [], index: {} } } };
	const moved = normalizeSettings(structuredClone(legacy));
	expect('migrate: flat settings detected', moved.migrated && !normalizeSettings(null).migrated && !normalizeSettings(moved.settings).migrated);
	const c = moved.settings.claude[0]!;
	const g = moved.settings.chatgpt[0]!;
	expect('migrate: first account keeps the existing login storage', c.id === 'default' && g.id === 'default');
	expect('migrate: claude.ai data carried over', c.web.orgId === ORG_A && c.web.chatFolder === 'S/Claude Chat' && c.web.projects[0] === 'P' && !!c.web.index.c1 && c.web.fileIndex.f1 === 'p');
	expect('migrate: ChatGPT data carried over', g.web.folder === 'S/GPT' && !!g.web.index.g1 && g.web.cooldownUntil === 42);
	expect('migrate: desktop per account, shared options stay shared', c.desktop.folder === 'S/DC' && !c.desktop.enabled && c.desktop.extraFolders[0] === 'X' && g.desktop.folder === 'S/DX' && moved.settings.desktop.keepRaw === true);
	expect('migrate: shared numbers', moved.settings.maxChatsPerRun === 7);
	const again = normalizeSettings(structuredClone(moved.settings)).settings;
	expect('migrate: reloading changes nothing', JSON.stringify(again) === JSON.stringify(moved.settings));
	expect('migrate: fresh install does not share the defaults', normalizeSettings(null).settings.claude[0]!.web.index !== normalizeSettings(null).settings.claude[0]!.web.index);

	const s = normalizeSettings({ orgId: ORG_A, chatFolder: 'S/Claude Desktop/Chat', maxChatsPerRun: 0, logPath: 'log2.md', desktop: { quietMinutes: 0 } }).settings;
	expect('name: rejected when empty, duplicate or unsafe', !!nameProblem(s.claude, ' ') && !!nameProblem(s.claude, 'main') && !!nameProblem(s.claude, 'a/b') && !nameProblem(s.claude, 'Work'));
	expect('name: keeping your own name is fine', !nameProblem(s.claude, 'Main', s.claude[0]));
	const work = addAccount(s, 'claude', 'Work') as ClaudeAccount;
	const gptWork = addAccount(s, 'chatgpt', 'Work') as ChatgptAccount;
	const [c0, g0] = [s.claude[0]!, s.chatgpt[0]!];
	expect('add: shares the first account\'s folders', work.web.chatFolder === c0.web.chatFolder && work.web.codeFolder === c0.web.codeFolder && work.desktop.folder === c0.desktop.folder && gptWork.web.folder === g0.web.folder && gptWork.desktop.folder === g0.desktop.folder);
	expect('add: own login storage and own history', work.id !== 'default' && work.web.index !== s.claude[0]!.web.index);
	work.web.orgId = ORG_B;
	gptWork.web.workspaceId = 'ws-work';

	expect('owner: login decides', desktopOwner(s.claude, 'claude', 'C:/x/1.jsonl', ORG_B) === work);
	expect('owner: unknown goes to the first account', desktopOwner(s.claude, 'claude', 'C:/x/1.jsonl', 'nobody') === s.claude[0] && desktopOwner(s.claude, 'claude', 'C:/x/1.jsonl', undefined) === s.claude[0]);
	expect('owner: workspace decides for Codex', desktopOwner(s.chatgpt, 'codex', 'C:/x/1.jsonl', 'ws-work') === gptWork);
	const claudeSide = addAccount(s, 'claude', 'Side');
	expect('owner: waits while an added account has not logged in', desktopOwner(s.claude, 'claude', 'C:/x/1.jsonl', 'nobody') === null);
	expect('owner: a session with no login recorded still goes to the first account', desktopOwner(s.claude, 'claude', 'C:/x/1.jsonl', undefined) === s.claude[0]);
	removeAccount(s, 'claude', claudeSide);
	expect('layout: an added account\'s folder is inside the same root', layoutRoot('S/Claude Desktop (Work)/Chat') === 'S');
	gptWork.desktop.extraFolders = ['C:\\Users\\W\\.codex-work\\sessions'];
	expect('owner: an account\'s own folder wins', desktopOwner(s.chatgpt, 'codex', 'C:/Users/W/.codex-work/sessions/2026/a.jsonl', 'something-else') === gptWork);
	expect('scan: folder matching ignores slashes and case, not name prefixes', sameOrUnder('C:/A/b/c.jsonl', 'c:\\a\\B\\') && !sameOrUnder('C:/A/bc/c.jsonl', 'C:/A/b'));

	const fs = new FakeFs();
	expect('scan: second Codex home found from its sessions folder', codexHomes(fs, ['C:\\Users\\W\\.codex-work\\sessions', 'E:/other']).join() === 'C:/Users/W/.codex,C:/Users/W/.codex-work');
	const NOW = Date.parse('2026-11-08T12:00:00Z');
	const old = NOW - 3600_000;
	const session = (id: string) => jl({ type: 'user', timestamp: '2026-11-06T10:00:00.000Z', message: { role: 'user', content: 'Hello ' + id } });
	const codexThread = (id: string, owner: string) => jl({ timestamp: '2026-11-06T11:00:00.000Z', type: 'session_meta', payload: { id, creator_account_id: owner } }, { timestamp: '2026-11-06T11:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Hi ' + id } });
	const P = 'C:/Users/W/.claude/projects/D--X';
	for (const id of ['mine', 'theirs', 'cli-only']) fs.put(`${P}/${id}.jsonl`, session(id), old);
	const META = 'C:/Users/W/AppData/Local/Claude-Data/claude_x/claude-code-sessions';
	fs.put(`${META}/acct1/${ORG_A}/local_1.json`, JSON.stringify({ sessionId: 'local_1', cliSessionId: 'mine', title: 'Mine' }), old);
	fs.put(`${META}/acct2/${ORG_B}/local_2.json`, JSON.stringify({ sessionId: 'local_2', cliSessionId: 'theirs', title: 'Theirs' }), old);
	fs.put('C:/Users/W/.codex/sessions/a.jsonl', codexThread('t-main', 'ws-main'), old);
	fs.put('C:/Users/W/.codex/sessions/b.jsonl', codexThread('t-work', 'ws-work'), old);
	fs.put('C:/Users/W/.codex-work/sessions/c.jsonl', codexThread('t-home', 'ws-unknown'), old);
	fs.put('C:/Users/W/.codex-work/session_index.jsonl', jl({ id: 't-home', thread_name: 'From second home' }), old);
	gptWork.desktop.extraFolders = ['C:/Users/W/.codex-work/sessions'];
	const written = new Map<string, string>();
	const memVault = { getAbstractFileByPath: (p: string) => (written.has(p) ? Object.assign(new TFile(p, { size: 0 }), { path: p }) : null), createFolder: async () => undefined, create: async (p: string, d: string) => void written.set(p, d), process: async () => undefined };
	const p = { app: { vault: memVault, fileManager: { processFrontMatter: async () => undefined } }, settings: s, saveSettings: async () => undefined } as never;

	work.desktop.enabled = false;
	const r0 = await runDesktopSync(p, undefined, fs, NOW);
	expect('sync: a turned-off account\'s sessions are not handed to another', r0.newCount === 5 && !Object.keys(s.claude[0]!.desktop.index).includes('theirs'), JSON.stringify(Object.keys(s.claude[0]!.desktop.index)));
	work.desktop.enabled = true;
	const r1 = await runDesktopSync(p, undefined, fs, NOW, { provider: 'claude', id: work.id });
	expect('sync: one account\'s button only saves that account', r1.newCount === 1 && !!work.desktop.index.theirs, JSON.stringify(r1));
	const notesOf = (label: string) => [...written.entries()].filter(([k, v]) => k.endsWith('.md') && v.startsWith(`---\naccount: "${label}"\n`));
	expect('sync: both accounts share one folder, each note names its account', notesOf('Work').length > 0 && notesOf('Main').length > 0 && [...written.keys()].filter((k) => k.startsWith('S/') && k.endsWith('.md')).every((k) => k.startsWith(`${c0.desktop.folder}/`) || k.startsWith(`${g0.desktop.folder}/`)), [...written.keys()].join(' | '));
	expect('sync: unmatched CLI session goes to the first account', !!s.claude[0]!.desktop.index['cli-only'] && !!s.claude[0]!.desktop.index.mine);
	expect('sync: Codex split by workspace and by folder', !!s.chatgpt[0]!.desktop.index['t-main'] && !!gptWork.desktop.index['t-work'] && !!gptWork.desktop.index['t-home']);
	expect('sync: titles read from the second Codex home', [...written.keys()].some((k) => k.includes('From second home')));
	const before = written.size;
	const r2 = await runDesktopSync(p, undefined, fs, NOW);
	expect('sync: nothing saved twice across accounts', r2.newCount === 0 && r2.changedCount === 0 && written.size === before, JSON.stringify(r2));

	// A session already saved stays with its account even if it would now match another.
	s.claude[0]!.web.orgId = 'cccccccc-0000-4000-8000-000000000003';
	work.web.orgId = ORG_A;
	fs.put(`${P}/mine.jsonl`, session('mine') + jl({ type: 'user', timestamp: '2026-11-07T10:00:00.000Z', message: { role: 'user', content: 'More' } }), old + 1);
	const r3 = await runDesktopSync(p, undefined, fs, NOW);
	expect('sync: an update stays with the account that saved it', r3.changedCount === 1 && !work.desktop.index.mine && !!s.claude[0]!.desktop.index.mine, JSON.stringify(r3));

	// A login window whose organization cookie we control.
	const ORG_C = 'dddddddd-0000-4000-8000-000000000004';
	let cookieOrg: string | null = ORG_A;
	const realWindow = (globalThis as { window?: unknown }).window;
	Object.assign(globalThis, { window: { electron: { remote: { BrowserWindow: class {}, session: { fromPartition: () => ({ cookies: { get: async () => [{ name: 'sessionKey', value: 'k' }, ...(cookieOrg ? [{ name: 'lastActiveOrg', value: cookieOrg }] : [])] } }) } } } } });
	const authPlugin = { app: { secretStorage: { getSecret: () => null } }, saveSettings: async () => undefined } as never;
	const slot = normalizeSettings({ orgId: '' }).settings.claude[0]!;
	expect('org: empty ID filled from the login', (await claudeAuth(authPlugin, slot)).orgId === ORG_A && slot.web.orgId === ORG_A);
	expect('org: logging back in to the same account changes nothing', (await claudeAuth(authPlugin, slot)).orgId === ORG_A);
	cookieOrg = null;
	expect('org: cookie not there yet keeps the saved ID', (await claudeAuth(authPlugin, slot)).orgId === ORG_A);
	cookieOrg = ORG_C;
	expect('org: a different login replaces the saved ID', (await claudeAuth(authPlugin, slot)).orgId === ORG_C && slot.web.orgId === ORG_C);
	const typed = normalizeSettings({ orgId: ORG_B }).settings.claude[0]!;
	cookieOrg = ORG_A;
	expect('org: an ID typed by hand survives upgrades and syncs', (await claudeAuth(authPlugin, typed)).orgId === ORG_B && (await claudeAuth(authPlugin, typed)).orgId === ORG_B);
	Object.assign(globalThis, { window: realWindow });

	const n = followRename(s, 'S/Claude/Code-Local/This computer', 'S/Moved');
	expect('rename: every account\'s index follows', n >= 1 && work.desktop.index.theirs!.md.startsWith('S/Moved/') && s.claude[0]!.desktop.index.mine!.md.startsWith('S/Moved/'));
	expect('remove: keeps at least one account', removeAccount(s, 'claude', work) && s.claude.length === 1 && !removeAccount(s, 'claude', s.claude[0]!));
}

/** Moving an existing vault into the app layout, on a small in-memory folder tree. */
async function layoutTest(handEdited: boolean) {
	const tag = handEdited ? 'layout (settings already changed by hand)' : 'layout';
	type Node = (TFile | TFolder) & { name: string; parent?: TFolder };
	const nodes = new Map<string, Node>();
	const named = <T extends TFile | TFolder>(n: T, path: string) => Object.assign(n, { path, name: path.split('/').pop()! }) as T & Node;
	const parentPath = (p: string) => p.split('/').slice(0, -1).join('/');
	const add = (path: string, folder: boolean): Node => {
		const existing = nodes.get(path);
		if (existing) return existing;
		const pp = parentPath(path);
		const parent = pp ? (add(pp, true) as TFolder & Node) : undefined;
		const n = folder ? named(new TFolder(path), path) : named(new TFile(path, { size: 1 }), path);
		n.parent = parent;
		parent?.children.push(n);
		nodes.set(path, n);
		return n;
	};
	const renamed: [string, string][] = [];
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => nodes.get(p) ?? null,
			createFolder: async (p: string) => void add(p, true),
		},
		fileManager: {
			renameFile: async (n: Node, to: string) => {
				if (nodes.has(to)) throw new Error('exists ' + to);
				const from = n.path;
				renamed.push([from, to]);
				const parent = add(parentPath(to), true) as TFolder & Node;
				n.parent!.children.splice(n.parent!.children.indexOf(n), 1);
				parent.children.push(n);
				n.parent = parent;
				for (const [p, x] of [...nodes]) {
					if (p !== from && !p.startsWith(`${from}/`)) continue;
					nodes.delete(p);
					const np = to + p.slice(from.length);
					named(x, np);
					nodes.set(np, x);
				}
			},
			trashFile: async (n: Node) => {
				n.parent!.children.splice(n.parent!.children.indexOf(n), 1);
				nodes.delete(n.path);
			},
		},
	};
	const R = '30 Sources/AI Chats';
	const PC = 'This computer';
	// A vault in the 0.17-0.24 layout, with a second account, a leftover flat folder and a hand-picked folder.
	add(`${R}/Claude Desktop/Chat/2nd Brain/2026-11-05 a.md`, false);
	add(`${R}/Claude Desktop/Code/Obsidian/2026-11-06 s.md`, false);
	add(`${R}/Claude Desktop (B)/Chat/2nd Brain/2026-11-07 w.md`, false);
	add(`${R}/Claude Desktop (B)/Chat/2nd Brain/2026-11-05 a.md`, false);
	add(`${R}/ChatGPT Desktop/Chat/Recent/Artifacts/2026-10-01 c/img.png`, false);
	add(`${R}/ChatGPT Desktop/Chat/Recent/2026-10-01 c.md`, false);
	add(`${R}/ChatGPT Desktop/Codex/Recent/2026-10-02 t.md`, false);
	add(`${R}/ChatGPT Chat/Recent/2026-09-01 old.md`, false);
	add(`${R}/Lumo/Chat/2026-09-02 l.md`, false);
	add('10 Projects/Code/keep.md', false);
	const claudeA = { id: 'default', label: 'A', web: { chatFolder: `${R}/Claude Desktop/Chat`, codeFolder: `${R}/Claude Desktop/Code`, index: { y: { updated_at: '', json: '', md: `${R}/Claude Desktop/Chat/2nd Brain/2026-11-05 a.md`, synced: '' } } }, desktop: { enabled: true, folder: `${R}/Claude Desktop/Code`, extraFolders: [], index: { s1: { updated: '', size: 0, mtime: 0, source: '', md: `${R}/Claude Desktop/Code/Obsidian/2026-11-06 s.md`, synced: '' } } } };
	const claudeB = { id: 'b', label: 'B', web: { chatFolder: `${R}/Claude Desktop (B)/Chat`, codeFolder: '10 Projects/Code', index: {} }, desktop: { enabled: true, folder: `${R}/Claude Desktop (B)/Code`, extraFolders: [], index: {} } };
	const gpt = { id: 'default', label: 'Main', web: { folder: `${R}/ChatGPT Desktop/Chat`, index: { x: { updated_at: '', json: '', md: `${R}/ChatGPT Desktop/Chat/Recent/2026-10-01 c.md`, synced: '' } }, fileIndex: { f: `${R}/ChatGPT Desktop/Chat/Recent/Artifacts/2026-10-01 c/img.png` } }, desktop: { enabled: true, folder: `${R}/ChatGPT Desktop/Codex`, extraFolders: [], index: {} } };
	const s = normalizeSettings({ claude: [claudeA, claudeB], chatgpt: [gpt], lumo: [{ id: 'default', label: 'Main', web: { folder: `${R}/Lumo/Chat`, index: {} } }] } as never).settings;
	const [a, b] = [s.claude[0]!, s.claude[1]!];
	const g = s.chatgpt[0]!;
	if (handEdited) {
		// The folder fields were switched to the new folders by hand; the chats are still in the old ones.
		a.web.chatFolder = `${R}/Claude/Chat`;
		g.web.folder = `${R}/ChatGPT/Chat`;
	}
	const isFolder = (p: string) => nodes.get(p) instanceof TFolder;
	const moves = layoutMoves(s, isFolder, PC);
	const plan = moves.map((m) => `${m.from} -> ${m.to}`);
	expect(`${tag}: planned moves`, plan.includes(`${R}/Claude Desktop/Chat -> ${R}/Claude/Chat`) && plan.includes(`${R}/Claude Desktop/Code -> ${R}/Claude/Code-Local/${PC}`)
		&& plan.includes(`${R}/Claude Desktop (B)/Chat -> ${R}/Claude/Chat`) && plan.includes(`${R}/ChatGPT Chat -> ${R}/ChatGPT/Chat`)
		&& !plan.some((m) => m.startsWith('10 Projects') || m.startsWith(`${R}/Lumo/`)), plan.join(' | '));
	const r = await moveToAppLayout(app as never, s, async () => undefined, PC);
	expect(`${tag}: both accounts' chats in one project folder`, nodes.has(`${R}/Claude/Chat/2nd Brain/2026-11-05 a.md`) && nodes.has(`${R}/Claude/Chat/2nd Brain/2026-11-07 w.md`));
	expect(`${tag}: a same-name file stays where it was`, r.conflicts.length === 1 && nodes.has(`${R}/Claude Desktop (B)/Chat/2nd Brain/2026-11-05 a.md`), JSON.stringify(r.conflicts));
	expect(`${tag}: local sessions under this computer`, nodes.has(`${R}/Claude/Code-Local/${PC}/Obsidian/2026-11-06 s.md`) && nodes.has(`${R}/ChatGPT/Codex-Local/${PC}/Recent/2026-10-02 t.md`));
	expect(`${tag}: ChatGPT chats, their files and the old flat folder`, nodes.has(`${R}/ChatGPT/Chat/Recent/Artifacts/2026-10-01 c/img.png`) && nodes.has(`${R}/ChatGPT/Chat/Recent/2026-09-01 old.md`));
	expect(`${tag}: emptied old folders removed`, !nodes.has(`${R}/Claude Desktop`) && !nodes.has(`${R}/ChatGPT Desktop`) && !nodes.has(`${R}/ChatGPT Chat`), [...nodes.keys()].filter((k) => k.split('/').length === 3).join(' | '));
	expect(`${tag}: folders chosen by hand stay`, nodes.has('10 Projects/Code/keep.md') && b.web.codeFolder === '10 Projects/Code' && nodes.has(`${R}/Lumo/Chat/2026-09-02 l.md`));
	expect(`${tag}: settings point at the new folders`, a.web.chatFolder === `${R}/Claude/Chat` && a.web.codeFolder === `${R}/Claude/Code-Cloud` && a.desktop.folder === `${R}/Claude/Code-Local/${PC}`
		&& b.web.chatFolder === `${R}/Claude/Chat` && b.desktop.folder === `${R}/Claude/Code-Local/${PC}` && g.web.folder === `${R}/ChatGPT/Chat` && g.desktop.folder === `${R}/ChatGPT/Codex-Local/${PC}`);
	expect(`${tag}: indexes follow the move`, a.web.index.y!.md === `${R}/Claude/Chat/2nd Brain/2026-11-05 a.md` && a.desktop.index.s1!.md.startsWith(`${R}/Claude/Code-Local/${PC}/`)
		&& g.web.index.x!.md.startsWith(`${R}/ChatGPT/Chat/`) && g.web.fileIndex.f!.startsWith(`${R}/ChatGPT/Chat/Recent/Artifacts/`));
	expect(`${tag}: nothing left to move`, layoutMoves(s, isFolder, PC).length === 0, layoutMoves(s, isFolder, PC).map((m) => `${m.from} -> ${m.to}`).join(' | '));
}

/** Claude Code files: pasted images, files Claude wrote or sent, published artifacts. */
async function filesTest() {
	const SID2 = '99999999-2222-3333-4444-555555555555';
	const NOW = Date.parse('2026-11-12T12:00:00Z');
	const PNG = 'iVBORw0KGgo=';
	const T = (s: number) => `2026-11-12T10:00:${String(s).padStart(2, '0')}.000Z`;
	const cwd = 'C:\\Work\\Proj';
	const tu = (id: string, name: string, input: unknown) => ({ type: 'assistant', cwd, timestamp: T(5), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
	const tr = (id: string, content: unknown) => ({ type: 'user', timestamp: T(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
	const session = jl(
		{ type: 'user', uuid: 'u1', cwd, timestamp: T(1), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: '[Image: source: C:\\Temp\\images\\1.png]\nFix this' }] } },
		tu('a', 'Write', { file_path: 'C:\\Work\\Proj\\Report.md', content: '# Old' }),
		tu('b', 'Write', { file_path: 'notes/Gone.md', content: 'Hello world' }),
		tu('c', 'Edit', { file_path: 'C:\\Work\\Proj\\notes\\Gone.md', old_string: 'world', new_string: 'vault' }),
		tu('d', 'Write', { file_path: 'C:\\Work\\Proj\\src\\main.ts', content: 'code' }),
		tu('e', 'SendUserFile', { files: ['out/data.zip'] }),
		tu('f', 'Write', { file_path: 'C:\\Users\\W\\.claude\\projects\\x\\memory\\m.md', content: 'memory' }),
		tu('g', 'Write', { file_path: 'D:\\Vault\\Notes\\In vault.md', content: 'x' }),
		tu('h', 'Artifact', { action: 'publish', type_url: 'https://claude.ai/artifact/TYPE1', title: 'My page' }),
		tr('h', 'Created a new Artifact at https://claude.ai/artifact/NEW1 (version 1) from the Artifact type https://claude.ai/artifact/TYPE1'),
		tu('i', 'mcp__1a59__batch', { container: { kind: 'project', create: { name: 'Plan doc' } } }),
		tr('i', [{ type: 'text', text: 'Doc ready: https://claude.ai/artifact/DOC1' }]),
		{ type: 'assistant', timestamp: T(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
	);
	const parsed = parseClaudeSession(session, SID2)!;
	const names = (parsed.files ?? []).map((f) => f.name).join();
	expect('files: found image, docs and sent file, not code', names === 'Image 1.png,Report.md,Gone.md,data.zip,m.md,In vault.md', names);
	expect('files: edit followed in the written text', parsed.files!.find((f) => f.name === 'Gone.md')!.text === 'Hello vault');
	expect('files: image note removed from prompt', !JSON.stringify(parsed.turns[0]).includes('Image: source'));
	expect('files: artifact and doc links (not the type)', JSON.stringify(parsed.links) === JSON.stringify([{ url: 'https://claude.ai/artifact/NEW1', title: 'My page', kind: 'artifact' }, { url: 'https://claude.ai/artifact/DOC1', title: 'Plan doc', kind: 'doc' }]), JSON.stringify(parsed.links));

	const fs = new FakeFs();
	fs.put(`C:/Users/W/.claude/projects/C--Work-Proj/${SID2}.jsonl`, session, NOW - 3600_000);
	fs.put('C:/Work/Proj/Report.md', '# Final report', 1);
	fs.put('C:/Work/Proj/out/data.zip', 'ZIPDATA', 1);
	fs.put('C:/Work/Proj/src/main.ts', 'code', 1);
	const files = new Map<string, ArrayBuffer | string>();
	const folders = new Set<string>();
	const bin = (d: ArrayBuffer | string) => (typeof d === 'string' ? new TextEncoder().encode(d).buffer : d);
	const fileObj = (p: string) => Object.assign(new TFile(), { path: p, stat: { size: bin(files.get(p)!).byteLength } });
	const v = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? fileObj(p) : folders.has(p) ? {} : null),
		getFiles: () => [...files.keys()].map(fileObj),
		createFolder: async (p: string) => void folders.add(p),
		create: async (p: string, d: string) => void files.set(p, d),
		createBinary: async (p: string, d: ArrayBuffer) => void files.set(p, d),
		readBinary: async (f: { path: string }) => bin(files.get(f.path)!),
		process: async () => undefined,
		adapter: Object.assign(Object.create(FileSystemAdapter.prototype) as object, { getBasePath: () => 'D:\\Vault' }),
	};
	files.set('Notes/In vault.md', 'x');
	const s = normalizeSettings({ maxChatsPerRun: 0, chatFolder: 'AI/Claude Chat', logPath: 'log.md', desktop: { quietMinutes: 0 } }).settings;
	const p = { app: { vault: v, fileManager: { processFrontMatter: async () => undefined } }, settings: s, saveSettings: async () => undefined } as never;
	const r = await runDesktopSync(p, undefined, fs, NOW);
	const text = (x: string) => {
		const d = files.get(x);
		return typeof d === 'string' ? d : new TextDecoder().decode(d);
	};
	const saved = [...files.keys()].filter((x) => x.includes('/Artifacts/') || x.includes('/Attachments/')).sort();
	expect('files: sync ran', !r.stopped && r.newCount === 1, JSON.stringify(r));
	expect('files: 4 copied (image, report, rebuilt note, zip)', r.filesSaved === 4 && saved.length === 4, saved.join(' | '));
	expect('files: latest version from disk', saved.some((x) => x.endsWith('/Artifacts/2026-11-12 Fix this/Report.md') && text(x) === '# Final report'), saved.join(' | '));
	expect('files: file gone from disk rebuilt from the session', saved.some((x) => x.endsWith('/Gone.md') && text(x) === 'Hello vault'));
	expect('files: image in Attachments', saved.some((x) => x.endsWith('/Attachments/2026-11-12 Fix this/Image 1.png')));
	const md = [...files.keys()].find((x) => x.endsWith('Fix this.md'))!;
	const t = text(md);
	expect('files: image shown in your message', /## You[^\n]*\n\n!\[\[[^\]]*Image 1\.png\]\]\n\nFix this/.test(t), t.slice(0, 700));
	expect('files: vault note linked in place, not copied', t.includes('[[Notes/In vault.md|In vault.md]]'), t.slice(t.indexOf('## Files')));
	expect('files: online links listed', t.includes('[My page](https://claude.ai/artifact/NEW1)') && t.includes('[Plan doc](https://claude.ai/artifact/DOC1) (Claude Doc)'));
	expect('files: memory file not saved', !t.includes('m.md'));

	// Synced before this feature: files are added once, the transcript is left alone.
	const entry = s.claude[0]!.desktop.index[SID2]!;
	delete entry.files;
	delete entry.filesChecked;
	for (const x of saved) files.delete(x);
	const before = text(md);
	const r2 = await runDesktopSync(p, undefined, fs, NOW);
	expect('files: backfilled for an older sync', r2.filesSaved === 4 && r2.filesBackfilled === 1 && text(md) === before, JSON.stringify(r2));
	const r3 = await runDesktopSync(p, undefined, fs, NOW);
	expect('files: only once', r3.filesSaved === 0 && r3.unchanged === 1, JSON.stringify(r3));
}

/** Codex files: attached images and files, files Codex added or changed. */
async function codexFilesTest() {
	const NOW = Date.parse('2026-11-12T12:00:00Z');
	const TID2 = '01a1b0b2-fd16-78b1-9634-c3fc1d130825';
	const PNG = 'iVBORw0KGgo=';
	const T = (s: number) => `2026-11-12T10:00:${String(s).padStart(2, '0')}.000Z`;
	const item = (s: number, it: unknown) => ({ timestamp: T(s), type: 'event_msg', payload: { type: 'item_completed', item: it } });
	const mentioned = '\n# Files mentioned by the user:\n\n## shot.png: C:/Temp/codex-clipboard-1.png\nImage attachment: true\n\n## notes.ahk: C:/Work/notes.ahk\n\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\nExtend the script\n';
	const thread = jl(
		{ timestamp: T(0), type: 'session_meta', payload: { id: TID2, timestamp: T(0), cwd: 'C:\\Work' } },
		{ timestamp: T(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: mentioned }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] } },
		item(1, { type: 'UserMessage', content: [{ type: 'text', text: mentioned }, { type: 'local_image', path: 'C:\\Temp\\codex-clipboard-1.png' }] }),
		item(2, { type: 'FileChange', changes: { 'C:\\Work\\Plan.md': { type: 'add', content: '# Plan' }, 'C:\\Work\\app.ts': { type: 'add', content: 'code' }, 'C:\\Work\\tmp.md': { type: 'add', content: 'x' } } }),
		item(3, { type: 'FileChange', changes: { 'C:\\Work\\Plan.md': { type: 'update', unified_diff: '@@' }, 'C:\\Work\\Notes.md': { type: 'add', content: 'Kept' }, 'C:\\Work\\tmp.md': { type: 'delete' } } }),
		item(4, { type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }] }),
	);
	const parsed = parseCodexSession(thread)!;
	const names = (parsed.files ?? []).map((f) => f.name).join();
	expect('codex files: attachments and docs found, code and deleted file not', names === 'notes.ahk,Image 1.png,Plan.md,Notes.md', names);
	expect('codex files: attachment block replaced by links', JSON.stringify(parsed.turns[0]).includes('Extend the script') && !JSON.stringify(parsed.turns[0]).includes('Files mentioned'), JSON.stringify(parsed.turns[0]));
	expect('codex files: title from your request', parsed.title === 'Extend the script', parsed.title);

	const fs = new FakeFs();
	fs.put(`C:/Users/W/.codex/sessions/2026/11/12/rollout-2026-11-12T10-00-00-${TID2}.jsonl`, thread, NOW - 3600_000);
	fs.put('C:/Work/notes.ahk', 'F7::Send x', 1);
	fs.put('C:/Work/Plan.md', '# Plan v2', 1);
	const files = new Map<string, ArrayBuffer | string>();
	const folders = new Set<string>();
	const bin = (d: ArrayBuffer | string) => (typeof d === 'string' ? new TextEncoder().encode(d).buffer : d);
	const fileObj = (p: string) => Object.assign(new TFile(), { path: p, stat: { size: bin(files.get(p)!).byteLength } });
	const v = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? fileObj(p) : folders.has(p) ? {} : null),
		getFiles: () => [...files.keys()].map(fileObj),
		createFolder: async (p: string) => void folders.add(p),
		create: async (p: string, d: string) => void files.set(p, d),
		createBinary: async (p: string, d: ArrayBuffer) => void files.set(p, d),
		readBinary: async (f: { path: string }) => bin(files.get(f.path)!),
		process: async () => undefined,
	};
	const s = normalizeSettings({ maxChatsPerRun: 0, chatFolder: 'AI/Claude Chat', logPath: 'log.md', desktop: { quietMinutes: 0 } }).settings;
	const p = { app: { vault: v, fileManager: { processFrontMatter: async () => undefined } }, settings: s, saveSettings: async () => undefined } as never;
	const r = await runDesktopSync(p, undefined, fs, NOW);
	const text = (x: string) => {
		const d = files.get(x);
		return typeof d === 'string' ? d : new TextDecoder().decode(d);
	};
	const saved = [...files.keys()].filter((x) => x.includes('/Artifacts/') || x.includes('/Attachments/')).sort();
	expect('codex files: sync ran', !r.stopped && r.newCount === 1, JSON.stringify(r));
	expect('codex files: 4 copied', r.filesSaved === 4 && saved.length === 4, saved.join(' | '));
	expect('codex files: image from the thread when its temp file is gone', saved.some((x) => x.endsWith('/Attachments/2026-11-12 Extend the script/Image 1.png') && text(x).length > 0), saved.join(' | '));
	expect('codex files: attached file copied', saved.some((x) => x.endsWith('/Attachments/2026-11-12 Extend the script/notes.ahk') && text(x) === 'F7::Send x'));
	expect('codex files: changed file from disk, new file from the thread', saved.some((x) => x.endsWith('/Plan.md') && text(x) === '# Plan v2') && saved.some((x) => x.endsWith('/Notes.md') && text(x) === 'Kept'));
	const md = [...files.keys()].find((x) => x.endsWith('Extend the script.md'))!;
	const t = text(md);
	expect('codex files: links in your message and Files section', /📎 \[\[[^\]]*notes\.ahk\|notes\.ahk\]\]\nExtend the script/.test(t) && /!\[\[[^\]]*Image 1\.png\]\]/.test(t) && /### Artifacts[\s\S]*Plan\.md[\s\S]*Notes\.md/.test(t), t.slice(t.indexOf('## You')));
}

/** Safety stops: many saved chats missing, and moves that must carry saved files along. */
async function guardTest() {
	expect('guard: a few missing chats are restored as before', !massMissing(100, 9) && !massMissing(20, 4));
	expect('guard: many missing at once stop the sync', massMissing(100, 21) && massMissing(951, 926) && !massMissing(100, 20));

	// A desktop sync whose history points at the wrong folder restores nothing.
	const NOW = Date.parse('2026-11-12T12:00:00Z');
	const fs = new FakeFs();
	const vaultFiles2 = new Map<string, string>();
	const v = {
		getAbstractFileByPath: (p: string) => (vaultFiles2.has(p) ? Object.assign(new TFile(), { path: p }) : null),
		createFolder: async () => undefined,
		create: async (p: string, d: string) => void vaultFiles2.set(p, d),
		process: async () => undefined,
	};
	const s = normalizeSettings({ maxChatsPerRun: 0, chatFolder: 'AI/Claude Chat', logPath: 'log.md', desktop: { quietMinutes: 0 } }).settings;
	for (let i = 0; i < 12; i++) {
		const id = `sess-${i}`;
		fs.put(`C:/Users/W/.claude/projects/p/${id}.jsonl`, jl({ type: 'user', sessionId: id, timestamp: '2026-11-06T10:00:00Z', message: { role: 'user', content: `Prompt ${i}` } }), NOW - 3600_000);
		s.claude[0]!.desktop.index[id] = { updated: '2026-11-06T10:00:00Z', size: 1, mtime: 1, source: `C:/Users/W/.claude/projects/p/${id}.jsonl`, md: `Old/${id}.md`, synced: 'x' };
	}
	const p = { app: { vault: v, fileManager: { processFrontMatter: async () => undefined } }, settings: s, saveSettings: async () => undefined } as never;
	const r = await runDesktopSync(p, undefined, fs, NOW);
	expect('guard: desktop sync stops, nothing restored', !!r.stopped?.includes('Refresh index') && r.restored.length === 0 && ![...vaultFiles2.keys()].some((k) => k.endsWith('.md') && k !== 'log.md'), JSON.stringify(r));

	// Moving a folder in Obsidian carries a session's saved files along.
	const s2 = normalizeSettings({ claude: [{}], chatgpt: [{}] }).settings;
	s2.claude[0]!.desktop.index.x = { updated: 'u', size: 1, mtime: 1, source: 's', md: 'Old/a.md', synced: 'x', files: { k: 'Old/Artifacts/a/Report.md' } };
	followRename(s2, 'Old', 'New');
	expect('follow: saved session files move with their folder', s2.claude[0]!.desktop.index.x!.files!.k === 'New/Artifacts/a/Report.md');
}

/** Real session files -> in-memory vault: shows where each session would be saved. Nothing on disk changes. */
async function live() {
	const nodeFs = await import('node:fs/promises');
	const os = await import('node:os');
	const real: DesktopFs = {
		home: os.homedir().replace(/\\/g, '/'),
		env: (n) => process.env[n],
		readDir: async (d) => (await nodeFs.readdir(d, { withFileTypes: true }).catch(() => [])).map((e) => ({ name: e.name, dir: e.isDirectory() })),
		stat: async (p) => nodeFs.stat(p).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs })).catch(() => null),
		readText: async (p) => nodeFs.readFile(p, 'utf8').catch(() => null),
		readBytes: async (p) => nodeFs.readFile(p).then((b) => new Uint8Array(b)).catch(() => null),
	};
	const files = new Map<string, string>();
	const memVault = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? Object.assign(new TFile(p, { size: 0 }), { path: p }) : null),
		createFolder: async () => undefined,
		create: async (p: string, d: string) => void files.set(p, d),
		createBinary: async (p: string) => void files.set(p, '(binary)'),
		getFiles: () => [],
		process: async () => undefined,
	};
	const s = normalizeSettings({ maxChatsPerRun: 0, chatFolder: '30 Sources/AI Chats/Claude Desktop/Chat', logPath: 'log.md', desktop: { quietMinutes: 0 } }).settings;
	const p = { app: { vault: memVault, fileManager: { processFrontMatter: async () => undefined } }, settings: s, saveSettings: async () => undefined } as never;
	const r = await runDesktopSync(p, undefined, real);
	for (const path of [...files.keys()].filter((x) => x.endsWith('.md')).sort()) console.log('  ' + path.replace('30 Sources/AI Chats/', ''));
	const kept = [...files.keys()].filter((x) => /\/(Artifacts|Attachments)\//.test(x));
	console.log(`  files saved: ${r.filesSaved} (${kept.filter((x) => x.includes('/Attachments/')).length} attachments)`);
	const tally = new Map<string, number>();
	for (const x of kept) {
		const k = `${x.split('/')[2]} ${x.includes('/Attachments/') ? 'attachment' : 'artifact'} .${x.split('.').pop()!.toLowerCase()}`;
		tally.set(k, (tally.get(k) ?? 0) + 1);
	}
	for (const [k, n] of [...tally].sort()) console.log(`    ${n}  ${k}`);
	expect('live: real sync ran', !r.stopped && r.newCount > 0, `${r.listed} files: ${r.newCount} saved, ${r.empty} empty/helper, stopped: ${r.stopped ?? 'no'}`);
	expect('live: Claude sidebar groups read', Object.keys(s.claude[0]!.desktop.groupCache ?? {}).length > 0, `${Object.keys(s.claude[0]!.desktop.groupCache ?? {}).length} assignments`);
}
