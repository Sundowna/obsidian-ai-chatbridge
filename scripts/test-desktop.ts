// Desktop apps test: parsers, renderer, scanner and a full sync run on a fake vault
// and a fake file system. Synthetic data only. Run: npm run test:desktop
// Optional: DESKTOP_LIVE=1 also runs a sync of the real session files on this computer into an
// in-memory vault (read-only on disk) and prints where each session would be saved.

import { parseClaudeSession, cleanClaudePrompt } from '../src/desktop/claude-code';
import { codexTitles, parseCodexSession } from '../src/desktop/codex';
import { renderDesktopTranscript, sessionFolderName } from '../src/desktop/render';
import { listSessionFiles, type DesktopFs } from '../src/desktop/scan';
import { runDesktopSync } from '../src/desktop/sync';
import { claudeGroups, claudePlacement, codexProjectFor, normFolder, parseClaudeMeta, parseCodexState } from '../src/desktop/sections';
import { findLatestJson, lastJsonObject, snappyDecompress } from '../src/desktop/leveldb';
import { layoutMoves, layoutRoot, moveToAppLayout } from '../src/desktop/layout';
import { mergeDesktop } from '../src/main';
import { followRename } from '../src/follow';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import { TFile, TFolder } from 'obsidian';

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
const settings: Settings = { ...DEFAULT_SETTINGS, maxChatsPerRun: 0, chatFolder: '30 Sources/AI Chats/Claude Chat', logPath: 'log.md' } as Settings;
settings.desktop = mergeDesktop(undefined, settings.chatFolder);
expect('settings: app layout next to Claude Chat', settings.desktop.claude.folder === '30 Sources/AI Chats/Claude Desktop/Code' && settings.desktop.codex.folder === '30 Sources/AI Chats/ChatGPT Desktop/Codex');
expect('settings: saved values win', mergeDesktop({ claude: { enabled: false, folder: 'X', extraFolders: [], index: {} } } as never, 'A/B').claude.folder === 'X');
const from016 = mergeDesktop({ claude: { enabled: true, folder: 'S/Claude Desktop', extraFolders: [], index: {} }, codex: { enabled: true, folder: 'S/Codex', extraFolders: [], index: {} } } as never, 'S/Claude Chat');
expect('settings: unused 0.16.0 folders move to the app layout', from016.claude.folder === 'S/Claude Desktop/Code' && from016.codex.folder === 'S/ChatGPT Desktop/Codex');
const used016 = mergeDesktop({ codex: { enabled: true, folder: 'S/Codex', extraFolders: [], index: { t: {} } } } as never, 'S/Claude Chat');
expect('settings: used 0.16.0 folder is kept', used016.codex.folder === 'S/Codex');
expect('layout: root next to or above the chat folder', layoutRoot('S/Claude Chat') === 'S' && layoutRoot('S/Claude Desktop/Chat') === 'S' && layoutRoot('Claude Chat') === '');
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

	settings.desktop.claude.extraFolders = ['E:\\Cowork'];
	const r1 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 1: no stop', !r1.stopped, r1.stopped);
	expect('sync 1: 4 new (claude, fork, codex, extra folder)', r1.newCount === 4, JSON.stringify(r1));
	expect('sync 1: active session waits', r1.active === 1);
	expect('sync 1: empty + guardian skipped', r1.empty === 2);
	const code = '30 Sources/AI Chats/Claude Desktop/Code';
	const claudeMd = `${code}/Obsidian/2026-11-06 Sidebar title.md`;
	expect('sync 1: claude session in its sidebar group', vaultFiles.has(claudeMd), [...vaultFiles.keys()].join(' | '));
	expect('sync 1: fork nested under its parent in the same group', vaultFiles.has(`${code}/Obsidian/Sidebar title/2026-11-06 Sidebar title (fork).md`));
	expect('sync 1: session outside a group by working folder', vaultFiles.has(`${code}/BrainTest/2026-11-06 My title.md`));
	expect('sync 1: codex thread in its project', vaultFiles.has('30 Sources/AI Chats/ChatGPT Desktop/Codex/2nd Brain/2026-11-06 Fix ChatBridge sync.md'));
	expect('sync 1: section in frontmatter', vaultFiles.get(claudeMd)!.includes('section: "Obsidian"'));
	expect('sync 1: no raw copy by default', ![...vaultFiles.keys()].some((p) => p.endsWith('.jsonl')));

	const r2 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 2: nothing new, unchanged counted', r2.newCount === 0 && r2.changedCount === 0 && r2.unchanged === 4, JSON.stringify(r2));
	expect('sync 2: groups cached for when the app storage is unreadable', settings.desktop.claude.groupCache?.local_abc === 'Obsidian');

	// Session continues: new transcript as "(updated …)", old one kept.
	fs.put(cPath, claudeFile + '\n' + jl({ type: 'user', timestamp: '2026-11-07T09:00:00.000Z', message: { role: 'user', content: 'One more thing' } }), old + 1000);
	settings.desktop.keepRaw = true;
	const r3 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 3: changed session written as update', r3.changedCount === 1 && /\(updated 2026-11-07 \d{4}\)$/.test(r3.written[0] ?? ''), JSON.stringify(r3.written));
	expect('sync 3: raw copy next to it', [...vaultFiles.keys()].some((p) => p.endsWith('(updated 2026-11-07 ' + r3.written[0]!.slice(-5, -1) + ').jsonl')));
	expect('sync 3: old transcript untouched', vaultFiles.has(claudeMd));

	// Codex archives a thread: file moves, content same -> no new transcript.
	const t = fs.files.get('C:/Users/W/.codex/sessions/2026/11/06/rollout-a.jsonl')!;
	fs.files.delete('C:/Users/W/.codex/sessions/2026/11/06/rollout-a.jsonl');
	fs.put('C:/Users/W/.codex/archived_sessions/rollout-a.jsonl', t.text, t.mtime);
	const r4 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 4: moved file is not new', r4.newCount === 0 && r4.changedCount === 0, JSON.stringify(r4));
	expect('sync 4: index follows the move', settings.desktop.codex.index[TID]!.source.includes('archived_sessions'));

	// Deleted transcript is written again under the same name.
	const codexMd = settings.desktop.codex.index[TID]!.md;
	vaultFiles.delete(codexMd);
	const r5 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 5: deleted transcript restored', r5.restored.length === 1 && vaultFiles.has(codexMd));

	// Moving the folder in Obsidian updates the desktop index.
	const n = followRename(settings, '30 Sources/AI Chats/ChatGPT Desktop/Codex', '30 Sources/AI Chats/OpenAI Codex');
	expect('rename: desktop index follows', n === 1 && settings.desktop.codex.index[TID]!.md.startsWith('30 Sources/AI Chats/OpenAI Codex/'));

	settings.desktop.claude.enabled = false;
	settings.desktop.codex.enabled = false;
	const r6 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('disabled: nothing read', r6.listed === 0);

	await layoutTest(false);
	await layoutTest(true);
	if (process.env.DESKTOP_LIVE) await live();
	console.log(failures ? `\n${failures} FAILED` : '\nAll desktop tests passed.');
	process.exit(failures ? 1 : 0);
})();

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
	add(`${R}/Claude Chat/2nd Brain/2026-11-05 a.md`, false);
	add(`${R}/Claude Chat/Recent/2026-11-01 b.json`, false);
	add(`${R}/ChatGPT Chat/Recent/Artifacts/2026-10-01 c/img.png`, false);
	add(`${R}/ChatGPT Chat/Recent/2026-10-01 c.md`, false);
	add(`${R}/Claude Desktop/Chat`, true);
	add(`${R}/ChatGPT Desktop/Chat`, true);
	add(`${R}/ChatGPT Desktop/Codex`, true);
	const s = { ...DEFAULT_SETTINGS, chatFolder: `${R}/Claude Chat`, codeFolder: `${R}/Claude Code`, gpt: { ...DEFAULT_SETTINGS.gpt, folder: `${R}/ChatGPT Chat`, index: { x: { updated_at: '', json: '', md: `${R}/ChatGPT Chat/Recent/2026-10-01 c.md`, synced: '' } }, fileIndex: { f: `${R}/ChatGPT Chat/Recent/Artifacts/2026-10-01 c/img.png` } }, index: { y: { updated_at: '', json: `${R}/Claude Chat/Recent/2026-11-01 b.json`, md: '', synced: '' } }, fileIndex: {} } as Settings;
	s.desktop = mergeDesktop({ claude: { enabled: true, folder: `${R}/Claude Desktop`, extraFolders: [], index: {} }, codex: { enabled: true, folder: `${R}/Codex`, extraFolders: [], index: {} } } as never, s.chatFolder);
	if (handEdited) {
		// What happened in the real vault: the chat folder fields were switched to the new folders, nothing moved.
		s.chatFolder = `${R}/Claude Desktop/Chat`;
		s.gpt.folder = `${R}/ChatGPT Desktop/Chat`;
	}
	const isFolder = (p: string) => nodes.get(p) instanceof TFolder;
	const moves = layoutMoves(s, isFolder);
	expect(`${tag}: planned moves`, moves.map((m) => m.label).join() === 'claude.ai chats,Claude Code chats listed on claude.ai,ChatGPT chats' && moves[0]!.from === `${R}/Claude Chat` && moves[2]!.from === `${R}/ChatGPT Chat`, moves.map((m) => `${m.label}: ${m.from} -> ${m.to}`).join(' | '));
	const r = await moveToAppLayout(app as never, s, async () => undefined);
	expect(`${tag}: chats moved into Claude Desktop/Chat`, nodes.has(`${R}/Claude Desktop/Chat/2nd Brain/2026-11-05 a.md`) && nodes.has(`${R}/Claude Desktop/Chat/Recent/2026-11-01 b.json`));
	expect(`${tag}: ChatGPT chats and their files moved`, nodes.has(`${R}/ChatGPT Desktop/Chat/Recent/Artifacts/2026-10-01 c/img.png`));
	expect(`${tag}: emptied old folders removed`, !nodes.has(`${R}/Claude Chat`) && !nodes.has(`${R}/ChatGPT Chat`));
	expect(`${tag}: whole subfolders moved in one rename each`, r.moved === 3 && r.conflicts.length === 0, JSON.stringify(renamed));
	expect(`${tag}: settings point at the new folders`, s.chatFolder === `${R}/Claude Desktop/Chat` && s.codeFolder === `${R}/Claude Desktop/Code` && s.gpt.folder === `${R}/ChatGPT Desktop/Chat` && s.desktop.claude.folder === `${R}/Claude Desktop/Code` && s.desktop.codex.folder === `${R}/ChatGPT Desktop/Codex`);
	expect(`${tag}: indexes follow the move`, s.index.y!.json.startsWith(`${R}/Claude Desktop/Chat/Recent/`) && s.gpt.index.x!.md.startsWith(`${R}/ChatGPT Desktop/Chat/`) && s.gpt.fileIndex.f!.startsWith(`${R}/ChatGPT Desktop/Chat/Recent/Artifacts/`));
	expect(`${tag}: nothing left to move`, layoutMoves(s, isFolder).length === 0);
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
		process: async () => undefined,
	};
	const s = { ...DEFAULT_SETTINGS, maxChatsPerRun: 0, chatFolder: '30 Sources/AI Chats/Claude Desktop/Chat', logPath: 'log.md' } as Settings;
	s.desktop = { ...mergeDesktop(undefined, s.chatFolder), quietMinutes: 0 };
	const p = { app: { vault: memVault, fileManager: { processFrontMatter: async () => undefined } }, settings: s, saveSettings: async () => undefined } as never;
	const r = await runDesktopSync(p, undefined, real);
	for (const path of [...files.keys()].filter((x) => x.endsWith('.md')).sort()) console.log('  ' + path.replace('30 Sources/AI Chats/', ''));
	expect('live: real sync ran', !r.stopped && r.newCount > 0, `${r.listed} files: ${r.newCount} saved, ${r.empty} empty/helper, stopped: ${r.stopped ?? 'no'}`);
	expect('live: Claude sidebar groups read', Object.keys(s.desktop.claude.groupCache ?? {}).length > 0, `${Object.keys(s.desktop.claude.groupCache ?? {}).length} assignments`);
}
