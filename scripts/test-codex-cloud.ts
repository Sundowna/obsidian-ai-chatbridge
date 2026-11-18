// Codex cloud tasks test: the connection client, the parser and a full Codex cloud sync on an
// in-memory vault with a fake Codex. Synthetic data shaped exactly like what chatgpt.com/codex
// sent over its app-server connection on 2026-11-18 (texts and IDs made up).
// Run: npm run test:codex-cloud

import { TFile } from 'obsidian';
import { CodexAppServer, CODEX_APP_SERVER_URL, type CodexCloudClient, type SocketLike } from '../src/cloud/codex-app-server';
import { checkCodexItems, checkCodexList, checkCodexTurns, codexFolderName, codexRaw, isRunning, isThreadId, interactionsOnly, joinTurns, orderTurns, parseCodexRaw, parseCodexTask, trimStep, turnsRunning } from '../src/cloud/codex-cloud';
import { syncCodexCloud, type CodexCloudContext } from '../src/cloud/codex-sync';
import { emptyCloudResult } from '../src/cloud/sync';
import { codexCloudBeside, normalizeSettings } from '../src/migrate';
import { MassMissingError } from '../src/missing-guard';
import { followRename } from '../src/follow';
import { readWrite } from './fake-vault';

(globalThis as { window?: unknown }).window ??= globalThis;

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const DONE = '6afdb9e6-40c4-8191-a1c1-04b03bf000fe';
const RUNNING = '6af4710e-cde8-8191-9948-9ecfb982f055';
const EMPTY = '01a19adb-052f-71c2-864c-7af5cd3d20ed';
const WORK = '01a19abb-c3a8-7393-af50-ec1b6b1a405b';
const T0 = Date.parse('2026-11-10T13:00:00Z') / 1000;
const thread = (id: string, updated: number, opts: { name?: string | null; status?: string; originator?: string } = {}) => ({
	id, environments: [{ environmentId: 'ccarenv_b64_x', cwd: '/workspace', runtimeWorkspaceRoots: ['/workspace'] }], extra: null, sessionId: id,
	forkedFromId: null, preview: '', ephemeral: false, historyMode: 'legacy', modelProvider: 'local', model: 'gpt-6.2-sol', reasoningEffort: 'low',
	createdAt: T0, updatedAt: updated, recencyAt: updated, status: { type: opts.status ?? 'idle' }, path: null, cwd: '/workspace', cliVersion: '',
	originator: opts.originator ?? 'codex_cloud', source: { custom: 'codex-cloud-agent' }, threadSource: 'user',
	name: opts.name === undefined ? 'In the repo notes-app, fix the READ…' : opts.name, turns: [],
});
const DIFF = '--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-# notes\n+# Notes\n+Uses ```code``` fences.\n';
let turnNo = 0;
const turn = (start: number, prompt: string, answer: string, status = 'completed', withChange = false) => ({
	id: `01a1ef1e-0000-7000-8000-${String(++turnNo).padStart(12, '0')}`, rootTurnId: null, itemsView: 'full', status, error: null,
	startedAt: start, completedAt: start + 80, durationMs: 80_000,
	items: [
		{ type: 'userMessage', id: 'u', clientId: 'c', content: [{ type: 'text', text: prompt, text_elements: [] }], startedAtMs: start * 1000, completedAtMs: start * 1000 },
		{ type: 'agentMessage', id: 'm1', text: 'Looking at the README.', phase: 'commentary', startedAtMs: start * 1000 + 2000 },
		{ type: 'commandExecution', id: 'e1', command: '/bin/bash -lc "cat README.md"', status: 'completed', aggregatedOutput: '# notes\n', exitCode: 0, startedAtMs: start * 1000 + 3000 },
		{ type: 'mcpToolCall', id: 'e2', server: 'codex_apps', tool: 'github.fetch_file', status: 'completed', arguments: { path: 'README.md' }, result: { content: [{ type: 'text', text: 'Action completed.' }] }, startedAtMs: start * 1000 + 4000 },
		{ type: 'reasoning', id: 'r1', summary: [], content: [], startedAtMs: start * 1000 + 5000 },
		...(withChange ? [{ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'README.md', kind: { type: 'update' }, diff: DIFF }], startedAtMs: start * 1000 + 6000 }] : []),
		...(answer ? [{ type: 'agentMessage', id: 'm2', text: answer, phase: 'final_answer', startedAtMs: start * 1000 + 70_000 }] : []),
	],
});

// --- connection client ------------------------------------------------------
class FakeSocket implements SocketLike {
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: { code?: number }) => void) | null = null;
	sent: Record<string, unknown>[] = [];
	closed = false;
	constructor(private readonly answer: (m: Record<string, unknown>) => unknown) {
		setTimeout(() => {
			this.readyState = 1;
			this.onopen?.(undefined);
		}, 0);
	}
	send(data: string): void {
		const m = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(m);
		if (m.id === undefined) return;
		const reply = this.answer(m);
		setTimeout(() => {
			this.onmessage?.({ data: JSON.stringify({ method: 'thread/status/changed', params: {} }) }); // a notification first
			this.onmessage?.({ data: JSON.stringify({ id: m.id, ...(reply as object) }) });
		}, 0);
	}
	close(): void {
		this.closed = true;
	}
}

(async () => {
const TOKEN = 'eyJ.secret-token.sig';
let opened: { url: string; protocols: string[] } | null = null;
let sock: FakeSocket | null = null;
const server = await CodexAppServer.open(TOKEN, '9.9.9', (url, protocols) => {
	opened = { url, protocols };
	sock = new FakeSocket((m) => (m.method === 'initialize' ? { result: { userAgent: 'app-server-backend/0.1.0' } } : m.method === 'thread/list' ? { result: { data: [], nextCursor: null } } : { error: { code: -32601, message: 'nope' } }));
	return sock;
});
const o = opened as { url: string; protocols: string[] } | null;
expect('client: Codex address and login in the sub-protocols', o?.url === CODEX_APP_SERVER_URL && JSON.stringify(o?.protocols) === JSON.stringify(['codex-app-server', 'codex-client.browser', `openai-bearer.${TOKEN}`]));
const s0 = sock as FakeSocket | null;
expect('client: says hello, then initialized', s0?.sent[0]?.method === 'initialize' && (s0?.sent[0]?.params as { clientInfo?: { name?: string; version?: string } })?.clientInfo?.version === '9.9.9' && s0?.sent[1]?.method === 'initialized');
const listed = await server.call('thread/list', { limit: 2 });
expect('client: answer matched by id, notification ignored', JSON.stringify(listed) === '{"data":[],"nextCursor":null}');
let blocked = '';
try {
	await (server as unknown as { call(m: string, p: object): Promise<unknown> }).call('turn/start', {});
} catch (e) {
	blocked = String(e);
}
expect('client: only reads – anything else is refused before sending', blocked.includes('Blocked') && !s0?.sent.some((m) => m.method === 'turn/start'));
let err = '';
try {
	await server.call('thread/turns/list', { threadId: DONE });
} catch (e) {
	err = String(e);
}
expect('client: an error answer stops with its message, without the login', err.includes('nope') && !err.includes(TOKEN));
server.close();
expect('client: close closes the socket and later calls fail', s0?.closed === true && (await server.call('thread/list', {}).then(() => false, () => true)));
let refused = '';
try {
	await CodexAppServer.open(TOKEN, '9.9.9', () => {
		const f: SocketLike = { readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send: () => undefined, close: () => undefined };
		setTimeout(() => f.onerror?.(undefined), 0);
		return f;
	});
} catch (e) {
	refused = String(e);
}
expect('client: refused connection says to log in again, no login shown', refused.includes('log in to ChatGPT again') && !refused.includes(TOKEN), refused);

// --- parser -----------------------------------------------------------------
expect('id: thread UUIDs pass, others not', isThreadId(DONE) && !isThreadId('../etc') && !isThreadId('task_e_123'));
const list = checkCodexList({ data: [thread(DONE, T0 + 90), thread(RUNNING, T0 + 200, { status: 'active', name: 'Busy' })], nextCursor: null });
const task = list.tasks[0]!;
expect('list: times from seconds, originator, status', task.created_at === '2026-11-10T13:00:00.000Z' && task.updated_at === '2026-11-10T13:01:30.000Z' && task.originator === 'codex_cloud' && task.status === 'idle' && list.cursor === undefined);
expect('list: running task waits', !isRunning(task) && isRunning(list.tasks[1]!));
for (const [label, bad] of [['no data', { items: [] }], ['entry without id', { data: [{ name: 'x' }] }], ['odd id', { data: [{ id: 'task_../x' }] }]] as const) {
	let threw = false;
	try {
		checkCodexList(bad);
	} catch {
		threw = true;
	}
	expect(`list: ${label} stops`, threw);
}
expect('turns: turns without their steps are fine (steps come separately)', checkCodexTurns({ data: [{ id: 't', items: [], itemsView: 'notLoaded' }], nextCursor: null }).turns.length === 1);
let noTurnId = false;
try {
	checkCodexTurns({ data: [{ items: [] }], nextCursor: null });
} catch {
	noTurnId = true;
}
expect('turns: a turn without id stops', noTurnId);

const t1 = turn(T0 + 1, 'In the repo notes-app, fix the README heading.', 'Done. Heading fixed.', 'completed', true);
const t2 = turn(T0 + 500, 'Also add a licence', 'Added LICENSE.');
const ordered = orderTurns([t2, t1, t2]);
expect('turns: newest-first pages put in order, each once', ordered.length === 2 && ordered[0] === t1);
const joined = joinTurns([{ ...t2, items: [] }, { ...t1, items: [] }], [...t1.items.map((item) => ({ turnId: t1.id, item })), ...t2.items.map((item) => ({ turnId: t2.id, item })), { turnId: 'stray', item: { type: 'agentMessage', id: 'x', text: 'late' } }]);
expect('join: steps back in their turns, turns in order, stray steps kept', joined.length === 3 && joined[0]!.id === t1.id && (joined[0]!.items as unknown[]).length === t1.items.length && (joined[1]!.items as unknown[]).length === t2.items.length && joined[2]!.id === 'stray');
const bigStep = trimStep({ type: 'commandExecution', aggregatedOutput: 'x'.repeat(60_000), result: { content: [{ text: 'y'.repeat(60_000) }] } }, 50_000);
expect('trim: long step output cut and marked, nested too', (bigStep.aggregatedOutput as string).length < 50_100 && (bigStep.aggregatedOutput as string).endsWith('…[cut 10000 characters]') && JSON.stringify(bigStep.result).includes('[cut 10000 characters]'));
expect('trim: your words and the answers stay whole', (trimStep({ type: 'agentMessage', text: 'z'.repeat(60_000) }, 50_000).text as string).length === 60_000);
let badItems = false;
try {
	checkCodexItems({ data: [{ item: { type: 'agentMessage' } }], nextCursor: null });
} catch {
	badItems = true;
}
expect('items: a step without its turn stops', badItems);
const slim = interactionsOnly([t1])[0]!.items as Record<string, unknown>[];
expect('interactions only: messages kept, steps between them one placeholder, reasoning gone', JSON.stringify(slim.map((i) => i.type)) === JSON.stringify(['userMessage', 'agentMessage', 'stepsSkipped', 'agentMessage']) && JSON.stringify(slim[2]!.kinds) === JSON.stringify({ commandExecution: 1, mcpToolCall: 1, fileChange: 1 }) && slim[2]!.count === 3, JSON.stringify(slim.map((i) => i.type)));
expect('interactions only: note counts the same steps', JSON.stringify(parseCodexTask(task, { turns: interactionsOnly([t1]) })!.session.turns) === JSON.stringify(parseCodexTask(task, { turns: [t1] })!.session.turns));
expect('interactions only: filtering twice changes nothing', JSON.stringify(interactionsOnly(interactionsOnly([t1]))) === JSON.stringify(interactionsOnly([t1])));
const parsed = parseCodexTask(task, { turns: [t1] })!;
expect('parse: found', !!parsed);
expect('parse: prompt, then answer with tool steps (reasoning left out)', parsed.session.turns.length === 2 && parsed.session.turns[0]!.role === 'user'
	&& JSON.stringify(parsed.session.turns[1]!.parts) === JSON.stringify([{ text: 'Looking at the README.' }, { tools: 3 }, { text: 'Done. Heading fixed.' }]), JSON.stringify(parsed.session.turns[1]?.parts));
expect('parse: title from the prompt when the name is just the prompt cut off', parsed.session.title === 'In the repo notes-app, fix the README heading.', parsed.session.title);
expect('parse: a real name is kept', parseCodexTask(checkCodexList({ data: [thread(DONE, T0, { name: 'README fix' })] }).tasks[0]!, { turns: [t1] })!.session.title === 'README fix');
const scheduledPrompt = 'System instruction (automation runtime; not user content):\n\nYou are executing a scheduled automation run.\n\nRun context (internal only):\n- Title: Agriland Market Watch\n- Timezone: Europe/Zurich';
expect('parse: a scheduled run is named after its schedule', parseCodexTask(checkCodexList({ data: [thread(WORK, T0, { name: null, originator: 'codex_work_web' })] }).tasks[0]!, { turns: [turn(T0, scheduledPrompt, 'Report.')] })!.session.title === 'Agriland Market Watch');
expect('parse: times, app, model', parsed.session.created === '2026-11-10T13:00:01.000Z' && parsed.session.app === 'codex' && parsed.session.model === 'gpt-6.2-sol');
expect('parse: file changes with diff', parsed.changes.length === 1 && parsed.changes[0]!.path === 'README.md' && parsed.changes[0]!.kind === 'update' && parsed.changes[0]!.diff === DIFF);
const two = parseCodexTask(task, { turns: ordered })!;
expect('parse: two turns -> two prompts in order', two.session.turns.filter((x) => x.role === 'user').length === 2 && JSON.stringify(two.session.turns[2]!.parts).includes('Also add a licence'));
expect('folder: Tasks for chatgpt.com/codex, Work for ChatGPT', codexFolderName(task, 'Other') === 'Tasks' && codexFolderName(checkCodexList({ data: [thread(WORK, T0, { originator: 'codex_work_mobile' })] }).tasks[0]!, 'Other') === 'Work' && codexFolderName(checkCodexList({ data: [thread(WORK, T0, { originator: 'x' })] }).tasks[0]!, 'Other') === 'Other');
const round = parseCodexRaw(codexRaw(task, { turns: [t1] }));
expect('raw: saved file reads back the same', JSON.stringify(parseCodexTask(round.task, round.details)) === JSON.stringify(parsed));
expect('parse: no prompt -> null', parseCodexTask(task, { turns: [{ id: 'x', items: [{ type: 'agentMessage', text: 'hi' }], itemsView: 'full' }] }) === null);
const failed = parseCodexTask(task, { turns: [{ ...turn(T0, 'Try', ''), status: 'failed', error: { message: 'npm install failed' } }] })!;
expect('parse: failed turn keeps its error', failed.error === 'npm install failed');
expect('parse: interrupted turn is not an error', parseCodexTask(task, { turns: [turn(T0, 'What are you busy with?', '', 'interrupted')] })!.error === undefined);
expect('running: a last turn in progress waits', turnsRunning({ turns: [t1, { ...t2, status: 'inProgress' }] }) && !turnsRunning({ turns: [t1] }));

// --- settings -----------------------------------------------------------------
expect('migrate: Codex Cloud next to the ChatGPT chat folder', codexCloudBeside('10 AI/ChatGPT/Chat') === '10 AI/ChatGPT/Codex-Cloud' && codexCloudBeside('ChatGPT/Chat') === 'ChatGPT/Codex-Cloud');
const old = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: { chatFolder: 'Vault AI/Claude/Chat' } }], chatgpt: [{ id: 'default', label: 'Main', web: { folder: 'Vault AI/ChatGPT/Chat' } }] } as never).settings.chatgpt[0]!.web;
expect('migrate: an older vault gets the folder beside its own, off', old.codexCloudFolder === 'Vault AI/ChatGPT/Codex-Cloud' && old.codexCloud === false, old.codexCloudFolder);

// --- sync on an in-memory vault ---------------------------------------------
const files = new Map<string, string>();
const vault = {
	getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : null),
	createFolder: async () => undefined,
	create: async (p: string, data: string) => void files.set(p, data),
	createBinary: async (p: string, data: ArrayBuffer) => void files.set(p, new TextDecoder().decode(data)),
	...readWrite(files),
	adapter: { read: async (p: string) => files.get(p) ?? '' },
};
let threads: unknown[] = [];
const turnsOf: Record<string, unknown[]> = {};
const calls: { method: string; params: Record<string, unknown> }[] = [];
let opens = 0;
const client: CodexCloudClient = {
	call: async (method, params) => {
		calls.push({ method, params });
		if (method === 'thread/list') {
			// Two pages: the first thread, then the rest.
			const second = params.cursor === 'p2';
			return { data: second ? threads.slice(1) : threads.slice(0, 1), nextCursor: second || threads.length < 2 ? null : 'p2' };
		}
		const own = (turnsOf[params.threadId as string] ?? []) as { id: string; items: unknown[] }[];
		const at = params.cursor ? Number(params.cursor) : 0;
		if (method === 'thread/turns/list') {
			// Turns newest first, one per page, without their steps (as Codex sends them).
			const all = [...own].reverse().map((t) => ({ ...t, items: [], itemsView: 'notLoaded' }));
			return { data: all.slice(at, at + 1), nextCursor: at + 1 < all.length ? String(at + 1) : null };
		}
		// Steps oldest first, three per page, each with its turn.
		const steps = own.flatMap((t) => t.items.map((item) => ({ turnId: t.id, item, startedAtMs: 0 })));
		return { data: steps.slice(at, at + 3), nextCursor: at + 3 < steps.length ? String(at + 3) : null, backwardsCursor: null };
	},
	close: () => undefined,
};
const s = normalizeSettings({ maxChatsPerRun: 0 } as never).settings;
const account = s.chatgpt[0]!;
expect('settings: Codex cloud off by default, folder in the layout', account.web.codexCloud === false && account.web.codexCloudFolder === 'AI Chats/ChatGPT/Codex-Cloud');
expect('settings: steps not kept by default', account.web.codexCloudSteps !== true);
account.web.codexCloudSteps = true; // the tests below check the diff; the default is checked at the end
const ctx = (): CodexCloudContext => ({ app: { vault } as never, settings: s, account, client: async () => (opens++, client), delayMs: 0, progress: () => undefined, save: async () => undefined, sleep: async () => undefined });

threads = [thread(DONE, T0 + 90), thread(RUNNING, T0 + 200, { status: 'active', name: 'Busy' }), thread(EMPTY, T0 + 30, { name: null, originator: 'codex_work_web' })];
turnsOf[DONE] = [t1];
turnsOf[EMPTY] = [{ id: 'e', items: [], itemsView: 'full', status: 'completed', startedAt: T0 }];
const r1 = emptyCloudResult();
await syncCodexCloud(ctx(), r1);
const base = account.web.codexCloudFolder;
const md1 = `${base}/Tasks/2026-11-10 In the repo notes-app, fix the README heading.md`;
expect('sync: one new task, running waits, empty remembered', r1.newCount === 1 && r1.listed === 3 && r1.running === 1 && account.web.codexCloudIndex![EMPTY]?.md === '', JSON.stringify({ ...r1, written: undefined }));
expect('sync: both list pages read, read-only calls only', calls.filter((c) => c.method === 'thread/list').length === 2 && calls.every((c) => ['thread/list', 'thread/turns/list', 'thread/items/list'].includes(c.method)));
expect('sync: turns asked without steps, steps from the item list, oldest first', calls.some((c) => c.method === 'thread/turns/list' && c.params.itemsView === undefined) && calls.filter((c) => c.method === 'thread/items/list').every((c) => c.params.sortDirection === 'asc') && calls.filter((c) => c.method === 'thread/items/list' && c.params.threadId === DONE).length >= 2);
expect('sync: never asks for the running task', !calls.some((c) => c.params.threadId === RUNNING));
expect('sync: transcript in Codex-Cloud/Tasks', files.has(md1), [...files.keys()].join(' | '));
expect('sync: raw file mirrored under the raw folder', files.has(`${s.rawRoot}/${md1.replace(/\.md$/, '.json')}`));
const text = files.get(md1) ?? '';
expect('sync: front matter says Codex cloud, where started, link, model', text.includes('app: "Codex (cloud)"') && text.includes('started_from: "codex_cloud"') && text.includes(`source: "https://chatgpt.com/local/${DONE}"`) && text.includes('model: "gpt-6.2-sol"') && text.includes('account: "Main"'));
expect('sync: headings You / Codex', text.includes('## You') && text.includes('## Codex'));
expect('sync: changes section with a fenced diff that survives backticks', text.includes('## Changes') && text.includes('1 file, +2 −1') && text.includes('> ````diff') && text.includes('> +Uses ```code``` fences.'));

calls.length = 0;
const r2 = emptyCloudResult();
await syncCodexCloud(ctx(), r2);
expect('sync again: nothing new, no turns fetched', r2.newCount === 0 && r2.unchanged === 2 && !calls.some((c) => c.method === 'thread/turns/list'), JSON.stringify({ ...r2, written: undefined }));

// A follow-up: the one note is rewritten, the version before stays as raw .json.
turnsOf[DONE] = [t1, t2];
threads = [thread(DONE, T0 + 86400)];
calls.length = 0;
const r3 = emptyCloudResult();
await syncCodexCloud(ctx(), r3);
const e3 = account.web.codexCloudIndex![DONE]!;
const mds = [...files.keys()].filter((p) => p.endsWith('.md'));
expect('follow-up: turns read over two pages', calls.filter((c) => c.method === 'thread/turns/list').length === 2);
expect('follow-up: one note, rewritten, both prompts in order', r3.changedCount === 1 && e3.md === md1 && mds.length === 1 && (files.get(md1) ?? '').indexOf('fix the README heading') < (files.get(md1) ?? '').indexOf('Also add a licence'), mds.join(' | '));
const keptRaw = e3.versions?.[0]?.files[0] ?? '';
expect('follow-up: version before kept and named in the note', files.has(keptRaw) && keptRaw.includes('(version ') && (files.get(md1) ?? '').includes('earlier_versions: 1'), keptRaw);
expect('follow-up: kept version has only the first prompt', (files.get(keptRaw) ?? '').includes('fix the README heading') && !(files.get(keptRaw) ?? '').includes('Also add a licence'));

// Idle in the list, but the newest turn still runs: wait.
turnsOf[DONE] = [t1, t2, { ...turn(T0 + 90000, 'One more thing', ''), status: 'inProgress' }];
threads = [thread(DONE, T0 + 90000)];
const r5 = emptyCloudResult();
await syncCodexCloud(ctx(), r5);
expect('running turn: not written, saved next time', r5.running === 1 && r5.changedCount === 0 && account.web.codexCloudIndex![DONE]!.updated !== new Date((T0 + 90000) * 1000).toISOString());
turnsOf[DONE] = [t1, t2];
threads = [thread(DONE, T0 + 86400)];

// Deleted transcript: written again from the saved raw file, without asking Codex.
files.delete(md1);
calls.length = 0;
const r4 = emptyCloudResult();
await syncCodexCloud(ctx(), r4);
expect('restore: deleted transcript written again from the raw file', r4.restored.length === 1 && files.has(md1) && !calls.some((c) => c.method === 'thread/turns/list'));

// Moving the folder in Obsidian: the history follows.
followRename(s, `${base}/Tasks`, `${base}/Tasks-moved`);
expect('follow: moved transcript is found', account.web.codexCloudIndex![DONE]!.md.startsWith(`${base}/Tasks-moved/`));

// Default (steps off): the raw file holds the conversation only, the note still counts the steps.
account.web.codexCloudSteps = false;
const SLIM = '01a19a9e-a44c-72ae-8bfb-5361cdf0e0d8';
threads = [thread(SLIM, T0 + 99, { name: 'Long run', originator: 'codex_work_web' })];
turnsOf[SLIM] = [turn(T0 + 5, 'Run the market watch', 'Report sent.', 'completed', true)];
const r6 = emptyCloudResult();
await syncCodexCloud(ctx(), r6);
const slimEntry = account.web.codexCloudIndex![SLIM]!;
const slimRaw = files.get(slimEntry.json) ?? '';
const slimNote = files.get(slimEntry.md) ?? '';
expect('steps off: raw has the conversation and a placeholder, no command output', r6.newCount === 1 && slimRaw.includes('Run the market watch') && slimRaw.includes('Report sent.') && slimRaw.includes('"stepsSkipped"') && !slimRaw.includes('aggregatedOutput') && !slimRaw.includes('cat README.md'), slimRaw.slice(0, 200));
expect('steps off: note counts the steps, no Changes section', slimNote.includes('*(3 tool steps)*') && !slimNote.includes('## Changes'), slimNote.slice(-300));

// Many saved tasks missing: stop instead of restoring them all.
for (let i = 0; i < 12; i++) account.web.codexCloudIndex![`0000000${i}-0000-0000-0000-000000000000`] = { updated: 'x', md: `gone/${i}.md`, json: `gone/${i}.json`, synced: 'x' };
let stopped = '';
try {
	await syncCodexCloud(ctx(), emptyCloudResult());
} catch (e) {
	stopped = e instanceof MassMissingError ? 'stop' : String(e);
}
expect('guard: mass missing stops the run', stopped === 'stop', stopped);

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
if (failures) process.exit(1);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
