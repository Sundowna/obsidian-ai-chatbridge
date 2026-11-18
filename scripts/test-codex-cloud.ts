// Codex cloud tasks test: parser and a full Codex cloud sync on an in-memory vault with a fake
// chatgpt.com. Synthetic data only, shaped like the models in OpenAI's Codex CLI
// (codex-rs/backend-client, read 2026-11-18). Run: npm run test:codex-cloud

import { TFile } from 'obsidian';
import { checkCodexList, checkCodexTask, codexFolderName, codexRaw, isRunning, isTaskId, parseCodexRaw, parseCodexTask } from '../src/cloud/codex-cloud';
import { syncCodexCloud, type CodexCloudContext } from '../src/cloud/codex-sync';
import { emptyCloudResult } from '../src/cloud/sync';
import { codexCloudBeside, normalizeSettings } from '../src/migrate';
import { MassMissingError } from '../src/missing-guard';
import { followRename } from '../src/follow';
import { readWrite } from './fake-vault';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const DONE = 'task_e_0123456789abcdef0123456789abcdef';
const RUNNING = 'task_e_ffffffffffffffffffffffffffffffff';
const EMPTY = 'task_e_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const T0 = Date.parse('2026-11-10T13:00:00Z') / 1000;
const listEntry = (id: string, status: string, updated: number, title = 'Fix the README') => ({
	id, title, has_generated_title: true, created_at: T0, updated_at: updated, archived: false, has_unread_turn: false,
	task_status_display: { environment_label: 'me/notes-app', latest_turn_status_display: { turn_status: status, diff_stats: { files_modified: 1, lines_added: 2, lines_removed: 1 }, sibling_turn_ids: [] } },
});
const DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-# notes\n+# Notes\n+Uses ```code``` fences.\n';
const details = (id: string, prompt: string, answer: string) => ({
	task: { id, title: 'Fix the README', created_at: T0, archived: false, external_pull_requests: [{ id: 'p1', assistant_turn_id: 'at1', pull_request: { number: 7, url: 'https://github.com/me/notes-app/pull/7', state: 'open', merged: false, mergeable: true, title: 'Fix [the] README' } }] },
	current_user_turn: { id: 'ut1', created_at: T0 + 1, turn_status: 'completed', input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: prompt }] }] },
	current_assistant_turn: {
		id: 'at1', created_at: T0 + 5, turn_status: 'completed', sibling_turn_ids: [],
		worklog: { messages: [
			{ author: { role: 'assistant' }, content: { parts: ['Looking at the README.'] } },
			{ author: { role: 'tool' }, content: { parts: ['$ cat README.md'] } },
			{ author: { role: 'tool' }, content: { parts: ['# notes'] } },
		] },
		output_items: [{ type: 'message', role: 'assistant', content: [{ content_type: 'text', text: answer }] }, { type: 'pr', output_diff: { diff: DIFF } }],
	},
});

// --- parser ---------------------------------------------------------------
expect('id: Codex task IDs pass, others not', isTaskId(DONE) && !isTaskId('../etc') && !isTaskId('task_e_a/b'));
const list = checkCodexList({ items: [listEntry(DONE, 'completed', T0 + 9), listEntry(RUNNING, 'in_progress', T0 + 20, 'Busy')], cursor: null });
const task = list.tasks[0]!;
expect('list: times from seconds, environment, status', task.created_at === '2026-11-10T13:00:00.000Z' && task.updated_at === '2026-11-10T13:00:09.000Z' && task.environment === 'me/notes-app' && task.status === 'completed' && list.cursor === undefined);
expect('list: running task waits', !isRunning(task) && isRunning(list.tasks[1]!));
for (const [label, bad] of [['no items', { data: [] }], ['entry without id', { items: [{ title: 'x' }] }], ['odd id', { items: [{ id: 'task_../x' }] }]] as const) {
	let threw = false;
	try {
		checkCodexList(bad);
	} catch {
		threw = true;
	}
	expect(`list: ${label} stops`, threw);
}
let wrongTask = false;
try {
	checkCodexTask(details(RUNNING, 'x', 'y'), DONE);
} catch {
	wrongTask = true;
}
expect('task: answer for another task stops', wrongTask);

const d = checkCodexTask(details(DONE, 'Please fix the README', 'Done, opened a pull request.'), DONE);
const parsed = parseCodexTask(task, d)!;
expect('parse: found', !!parsed);
expect('parse: prompt, then answer with tool steps', parsed.session.turns.length === 2 && parsed.session.turns[0]!.role === 'user'
	&& JSON.stringify(parsed.session.turns[1]!.parts) === JSON.stringify([{ text: 'Looking at the README.' }, { tools: 2 }, { text: 'Done, opened a pull request.' }]), JSON.stringify(parsed.session.turns));
expect('parse: title, times, app', parsed.session.title === 'Fix the README' && parsed.session.created === '2026-11-10T13:00:01.000Z' && parsed.session.app === 'codex');
expect('parse: diff and pull request', parsed.diff === DIFF && parsed.pullRequests[0]?.number === 7);
expect('folder: named after the environment\'s repository', codexFolderName(task, 'Other') === 'notes-app');
const round = parseCodexRaw(codexRaw(task, d));
expect('raw: saved file reads back the same', JSON.stringify(parseCodexTask(round.task, round.details)) === JSON.stringify(parsed));
expect('parse: no prompt -> null', parseCodexTask(task, checkCodexTask({ task: { id: DONE }, current_user_turn: { input_items: [] } }, DONE)) === null);
const failed = parseCodexTask(task, checkCodexTask({ ...details(DONE, 'Try', ''), current_assistant_turn: { turn_status: 'failed', error: { code: 'setup_failed', message: 'npm install failed' } } }, DONE))!;
expect('parse: failed turn keeps its error', failed.error === 'setup_failed: npm install failed' && failed.session.turns.length === 1);

// --- settings -------------------------------------------------------------
expect('migrate: Codex Cloud next to the ChatGPT chat folder', codexCloudBeside('10 AI/ChatGPT/Chat') === '10 AI/ChatGPT/Codex-Cloud' && codexCloudBeside('ChatGPT/Chat') === 'ChatGPT/Codex-Cloud');
const old = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: { chatFolder: 'Vault AI/Claude/Chat' } }], chatgpt: [{ id: 'default', label: 'Main', web: { folder: 'Vault AI/ChatGPT/Chat' } }] } as never).settings.chatgpt[0]!.web;
expect('migrate: an older vault gets the folder beside its own, off', old.codexCloudFolder === 'Vault AI/ChatGPT/Codex-Cloud' && old.codexCloud === false, old.codexCloudFolder);

// --- sync on an in-memory vault ---------------------------------------------
(async () => {
const files = new Map<string, string>();
const vault = {
	getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : null),
	createFolder: async () => undefined,
	create: async (p: string, data: string) => void files.set(p, data),
	createBinary: async (p: string, data: ArrayBuffer) => void files.set(p, new TextDecoder().decode(data)),
	...readWrite(files),
	adapter: { read: async (p: string) => files.get(p) ?? '' },
};
let taskList: unknown[] = [];
const detailOf: Record<string, unknown> = {};
const requested: string[] = [];
const api = {
	codexTasksPath: (c?: string) => `/backend-api/wham/tasks/list?limit=20&task_filter=current${c ? `&cursor=${c}` : ''}`,
	codexTaskPath: (id: string) => `/backend-api/wham/tasks/${id}`,
	get: async (path: string) => {
		requested.push(path);
		if (path.includes('/tasks/list')) {
			// Two pages: the first entry, then the rest.
			const second = path.includes('cursor=2');
			return { json: { items: second ? taskList.slice(1) : taskList.slice(0, 1), cursor: second || taskList.length < 2 ? null : '2' } };
		}
		const id = path.split('/').pop()!;
		return { json: detailOf[id] };
	},
};
const s = normalizeSettings({ maxChatsPerRun: 0 } as never).settings;
const account = s.chatgpt[0]!;
expect('settings: Codex cloud off by default, folder in the layout', account.web.codexCloud === false && account.web.codexCloudFolder === 'AI Chats/ChatGPT/Codex-Cloud');
const ctx = (): CodexCloudContext => ({ app: { vault } as never, settings: s, account, api, delayMs: 0, progress: () => undefined, save: async () => undefined, sleep: async () => undefined });

taskList = [listEntry(DONE, 'completed', T0 + 9), listEntry(RUNNING, 'in_progress', T0 + 20, 'Busy'), listEntry(EMPTY, 'completed', T0 + 3, 'Empty')];
detailOf[DONE] = details(DONE, 'Please fix the README', 'Done, opened a pull request.');
detailOf[EMPTY] = { task: { id: EMPTY }, current_user_turn: { input_items: [] } };
const r1 = emptyCloudResult();
await syncCodexCloud(ctx(), r1);
const base = account.web.codexCloudFolder;
const md1 = `${base}/notes-app/2026-11-10 Fix the README.md`;
expect('sync: one new task, running waits, empty remembered', r1.newCount === 1 && r1.listed === 3 && r1.running === 1 && account.web.codexCloudIndex![EMPTY]?.md === '', JSON.stringify({ ...r1, written: undefined }));
expect('sync: both list pages read', requested.filter((p) => p.includes('/tasks/list')).length === 2);
expect('sync: never asks for the running task', !requested.some((p) => p.endsWith(RUNNING)));
expect('sync: transcript in Codex-Cloud/<repo>', files.has(md1), [...files.keys()].join(' | '));
expect('sync: raw file mirrored under the raw folder', files.has(`${s.rawRoot}/${base}/notes-app/2026-11-10 Fix the README.json`));
const text = files.get(md1) ?? '';
expect('sync: front matter says Codex cloud, environment, link, PR', text.includes('app: "Codex (cloud)"') && text.includes('environment: "me/notes-app"') && text.includes(`source: "https://chatgpt.com/codex/tasks/${DONE}"`) && text.includes('pull_request: "https://github.com/me/notes-app/pull/7"') && text.includes('account: "Main"'));
expect('sync: headings You / Codex', text.includes('## You') && text.includes('## Codex'));
expect('sync: changes section with a fenced diff that survives backticks', text.includes('## Changes') && text.includes('1 file, +2 −1') && text.includes('> ````diff') && text.includes('> +Uses ```code``` fences.'));
expect('sync: pull request listed without brackets in its title', text.includes('- [#7 Fix the README](https://github.com/me/notes-app/pull/7) (open)'));

requested.length = 0;
const r2 = emptyCloudResult();
await syncCodexCloud(ctx(), r2);
expect('sync again: nothing new, no task fetched', r2.newCount === 0 && r2.unchanged === 2 && !requested.some((p) => p.includes('/tasks/task_')), JSON.stringify({ ...r2, written: undefined }));

// A follow-up: the one note is rewritten, the version before stays as raw .json.
detailOf[DONE] = details(DONE, 'Also add a licence', 'Added LICENSE.');
taskList = [listEntry(DONE, 'completed', T0 + 86400)];
const r3 = emptyCloudResult();
await syncCodexCloud(ctx(), r3);
const e3 = account.web.codexCloudIndex![DONE]!;
const mds = [...files.keys()].filter((p) => p.endsWith('.md'));
expect('follow-up: one note, rewritten', r3.changedCount === 1 && e3.md === md1 && mds.length === 1 && (files.get(md1) ?? '').includes('Also add a licence'), mds.join(' | '));
const keptRaw = e3.versions?.[0]?.files[0] ?? '';
expect('follow-up: version before kept and named in the note', files.has(keptRaw) && keptRaw.includes('(version ') && (files.get(md1) ?? '').includes('earlier_versions: 1'), keptRaw);
expect('follow-up: kept version still has the first prompt', (files.get(keptRaw) ?? '').includes('Please fix the README'));

// Deleted transcript: written again from the saved raw file, without asking chatgpt.com.
files.delete(md1);
requested.length = 0;
const r4 = emptyCloudResult();
await syncCodexCloud(ctx(), r4);
expect('restore: deleted transcript written again from the raw file', r4.restored.length === 1 && files.has(md1) && !requested.some((p) => p.includes('/tasks/task_')));

// Moving the folder in Obsidian: the history follows.
followRename(s, `${base}/notes-app`, `${base}/notes-app-moved`);
expect('follow: moved transcript is found', account.web.codexCloudIndex![DONE]!.md.startsWith(`${base}/notes-app-moved/`));

// Many saved tasks missing: stop instead of restoring them all.
for (let i = 0; i < 12; i++) account.web.codexCloudIndex![`task_e_gone${i}`] = { updated: 'x', md: `gone/${i}.md`, json: `gone/${i}.json`, synced: 'x' };
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
