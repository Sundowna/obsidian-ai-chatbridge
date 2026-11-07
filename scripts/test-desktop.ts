// Desktop apps test: parsers, renderer, scanner and a full sync run on a fake vault
// and a fake file system. Synthetic data only. Run: npm run test:desktop
// Optional: DESKTOP_LIVE=1 also parses the real session files on this computer (read-only, prints counts only).

import { claudeDesktopTitle, parseClaudeSession, cleanClaudePrompt } from '../src/desktop/claude-code';
import { codexTitles, parseCodexSession } from '../src/desktop/codex';
import { renderDesktopTranscript, sessionFolderName } from '../src/desktop/render';
import { claudeDesktopMetaFiles, listSessionFiles, type DesktopFs } from '../src/desktop/scan';
import { runDesktopSync } from '../src/desktop/sync';
import { mergeDesktop } from '../src/main';
import { followRename } from '../src/follow';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import { TFile } from 'obsidian';

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
expect('claude: desktop title file', claudeDesktopTitle(JSON.stringify({ cliSessionId: 'a', title: 'T' }))?.title === 'T' && claudeDesktopTitle('{}') === null);
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
expect('settings: default folders next to Claude Chat', settings.desktop.claude.folder === '30 Sources/AI Chats/Claude Desktop' && settings.desktop.codex.folder === '30 Sources/AI Chats/Codex');
expect('settings: saved values win', mergeDesktop({ claude: { enabled: false, folder: 'X', extraFolders: [], index: {} } } as never, 'A/B').claude.folder === 'X');
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
	fs.put(`C:/Users/W/AppData/Local/Claude-Data/claude_x/claude-code-sessions/acc/org/local_abc.json`, JSON.stringify({ cliSessionId: SID, title: 'Sidebar title', titleSource: 'user' }), old);
	fs.put('E:/Cowork/s1.jsonl', claudeFile.replace(new RegExp(SID, 'g'), 'cowork-1'), old);

	const listed = await listSessionFiles(fs, 'claude', []);
	expect('scan: subagents folder skipped', listed.length === 3 && !listed.some((f) => f.path.includes('subagents')), listed.map((f) => f.path).join());
	expect('scan: codex index file is not a session', (await listSessionFiles(fs, 'codex', [])).length === 2);

	settings.desktop.claude.extraFolders = ['E:\\Cowork'];
	const r1 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 1: no stop', !r1.stopped, r1.stopped);
	expect('sync 1: 3 new (claude, codex, extra folder)', r1.newCount === 3, JSON.stringify(r1));
	expect('sync 1: active session waits', r1.active === 1);
	expect('sync 1: empty + guardian skipped', r1.empty === 2);
	const claudeMd = '30 Sources/AI Chats/Claude Desktop/BrainTest/2026-11-06 Sidebar title.md';
	expect('sync 1: claude transcript path', vaultFiles.has(claudeMd), [...vaultFiles.keys()].join(' | '));
	expect('sync 1: codex transcript path', vaultFiles.has('30 Sources/AI Chats/Codex/Open/2026-11-06 Fix ChatBridge sync.md'));
	expect('sync 1: no raw copy by default', ![...vaultFiles.keys()].some((p) => p.endsWith('.jsonl')));

	const r2 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('sync 2: nothing new, unchanged counted', r2.newCount === 0 && r2.changedCount === 0 && r2.unchanged === 3, JSON.stringify(r2));

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
	const n = followRename(settings, '30 Sources/AI Chats/Codex', '30 Sources/AI Chats/OpenAI Codex');
	expect('rename: desktop index follows', n === 1 && settings.desktop.codex.index[TID]!.md.startsWith('30 Sources/AI Chats/OpenAI Codex/'));

	settings.desktop.claude.enabled = false;
	settings.desktop.codex.enabled = false;
	const r6 = await runDesktopSync(plugin, undefined, fs, NOW);
	expect('disabled: nothing read', r6.listed === 0);

	if (process.env.DESKTOP_LIVE) await live();
	console.log(failures ? `\n${failures} FAILED` : '\nAll desktop tests passed.');
	process.exit(failures ? 1 : 0);
})();

/** Read-only pass over the real session folders: counts only, nothing written. */
async function live() {
	const nodeFs = await import('node:fs/promises');
	const os = await import('node:os');
	const real: DesktopFs = {
		home: os.homedir().replace(/\\/g, '/'),
		env: (n) => process.env[n],
		readDir: async (d) => (await nodeFs.readdir(d, { withFileTypes: true }).catch(() => [])).map((e) => ({ name: e.name, dir: e.isDirectory() })),
		stat: async (p) => nodeFs.stat(p).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs })).catch(() => null),
		readText: async (p) => nodeFs.readFile(p, 'utf8').catch(() => null),
	};
	const appTitles = new Map<string, string>();
	for (const f of await claudeDesktopMetaFiles(real)) {
		const t = claudeDesktopTitle((await real.readText(f)) ?? '');
		if (t) appTitles.set(t.id, t.title);
	}
	expect('live: Claude desktop titles found', appTitles.size > 0, `${appTitles.size} titles`);
	const titlesReal = codexTitles((await real.readText(`${real.home}/.codex/session_index.jsonl`)) ?? '');
	for (const app of ['claude', 'codex'] as const) {
		const files = await listSessionFiles(real, app, []);
		let ok = 0, empty = 0, sub = 0, turns = 0;
		for (const f of files) {
			const text = (await real.readText(f.path)) ?? '';
			const s = app === 'claude' ? parseClaudeSession(text, f.path.split('/').pop()!.replace('.jsonl', ''), appTitles) : parseCodexSession(text, titlesReal);
			if (!s) empty++;
			else if (s.isSubagent) sub++;
			else {
				ok++;
				turns += s.turns.length;
				console.log(`  ${app}: ${s.created.slice(0, 10)} ${s.title.slice(0, 60)} → ${sessionFolderName(s.cwd, 'Other')} (${s.turns.length} turns)`);
			}
		}
		expect(`live ${app}: every file parsed or skipped`, ok + empty + sub === files.length, `${files.length} files: ${ok} sessions, ${sub} helper, ${empty} empty, ${turns} turns`);
	}
}
