// Claude Code cloud sessions test: parser and a full cloud sync on an in-memory vault with a
// fake claude.ai. Synthetic data only, shaped like what claude.ai/v1/code/sessions sent on
// 2026-11-13. Run: npm run test:cloud

import { TFile } from 'obsidian';
import { checkCloudEvents, checkCloudList, cloudFolderName, isCloudSession, parseCloudRaw, parseCloudSession, cloudRaw } from '../src/cloud/claude-cloud';
import { emptyCloudResult, syncClaudeCloud, type CloudSyncContext } from '../src/cloud/sync';
import { normalizeSettings } from '../src/migrate';
import { MassMissingError } from '../src/missing-guard';
import { followRename } from '../src/follow';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const CLOUD = 'cse_01Cloud';
const BRIDGE = 'cse_01Bridge';
const RUNNING = 'cse_01Running';
const listEntry = (id: string, kind: string, worker: string, last: string, title = 'Fix the README') => ({
	id, title, created_at: '2026-11-10T13:00:00Z', updated_at: last, last_event_at: last, status: 'active', status_bucket: 'completed',
	worker_status: worker, environment_kind: kind, tags: [], config: { model: 'claude-opus-5-5', sources: [{ type: 'git_repository', url: 'https://github.com/me/notes-app' }] },
});
let n = 0;
const ev = (type: string, payload: Record<string, unknown>, at = '2026-11-10T13:00:00Z') => ({ event_id: `e${++n}`, event_type: type, sequence_num: String(n), created_at: at, source: 'worker', payload });
const BASE_EVENTS = [
	ev('system', { type: 'system', subtype: 'init', cwd: '/home/user/notes-app', model: 'claude-opus-5-5', session_id: 'x' }),
	ev('env_manager_log', { type: 'env_manager_log', message: 'cloning' }),
	// The first prompt has no timestamp of its own: the event's created_at is used.
	ev('user', { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Please fix the README<system-reminder>hidden</system-reminder>' } }, '2026-11-10T13:00:05Z'),
	ev('assistant', { type: 'assistant', uuid: 'a1', timestamp: '2026-11-10T13:00:07Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/home/user/notes-app/NOTES.md', content: '# Notes\n' } }] } }),
	ev('user', { type: 'user', uuid: 'u2', timestamp: '2026-11-10T13:00:08Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
	ev('assistant', { type: 'assistant', uuid: 'a2', timestamp: '2026-11-10T13:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, pushed to the branch.' }] } }),
	ev('result', { type: 'result', subtype: 'success' }),
];
const newestFirst = <T extends { sequence_num: string }>(a: T[]) => [...a].sort((x, y) => Number(y.sequence_num) - Number(x.sequence_num));

// --- parser ---------------------------------------------------------------
const list = checkCloudList({ data: [listEntry(CLOUD, 'anthropic_cloud', 'idle', '2026-11-10T13:00:09Z'), listEntry(BRIDGE, 'bridge', 'idle', '2026-11-10T13:00:09Z')], next_cursor: '' });
expect('list: repo from the git source', list.sessions[0]!.repo === 'me/notes-app' && list.cursor === undefined);
expect('list: Remote Control sessions are not cloud sessions', isCloudSession(list.sessions[0]!) && !isCloudSession(list.sessions[1]!));
let threw = false;
try {
	checkCloudList({ items: [] });
} catch {
	threw = true;
}
expect('list: odd shape stops', threw);

const events = checkCloudEvents({ data: newestFirst(BASE_EVENTS), resume_cursor: 'r' }).events;
const parsed = parseCloudSession(list.sessions[0]!, events)!;
expect('parse: session found', !!parsed);
expect('parse: title from claude.ai', parsed.title === 'Fix the README');
expect('parse: oldest first, prompt cleaned', parsed.turns[0]!.role === 'user' && 'text' in parsed.turns[0]!.parts[0]! && parsed.turns[0]!.parts[0].text === 'Please fix the README');
expect('parse: prompt time from the event', parsed.turns[0]!.time === '2026-11-10T13:00:05Z');
expect('parse: tool steps and reply', JSON.stringify(parsed.turns[1]!.parts) === JSON.stringify([{ tools: 1 }, { text: 'Done, pushed to the branch.' }]));
expect('parse: cwd and model from init', parsed.cwd === '/home/user/notes-app' && parsed.model === 'claude-opus-5-5');
expect('parse: thinking left out', !JSON.stringify(parsed.turns).includes('secret'));
expect('parse: written file kept from the session, not from a path', parsed.files?.length === 1 && parsed.files[0]!.source === undefined && parsed.files[0]!.text === '# Notes\n');
expect('folder: named after the repository', cloudFolderName(list.sessions[0]!, parsed.cwd, 'Other') === 'notes-app');
const round = parseCloudRaw(cloudRaw(list.sessions[0]!, events));
expect('raw: saved file reads back the same', JSON.stringify(parseCloudSession(round.session, round.events)) === JSON.stringify(parsed));
expect('parse: no message from you -> null', parseCloudSession(list.sessions[0]!, checkCloudEvents({ data: [BASE_EVENTS[0]] }).events) === null);

// --- sync on an in-memory vault ---------------------------------------------
(async () => {
const files = new Map<string, string>();
const vault = {
	getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p, { size: files.get(p)!.length }) : null),
	createFolder: async () => undefined,
	create: async (p: string, d: string) => void files.set(p, d),
	createBinary: async (p: string, d: ArrayBuffer) => void files.set(p, new TextDecoder().decode(d)),
	readBinary: async (f: TFile) => new TextEncoder().encode(files.get(f.path) ?? '').buffer,
	adapter: { read: async (p: string) => files.get(p) ?? '' },
};
let sessionList: unknown[] = [];
const eventsOf: Record<string, unknown[]> = {};
const requested: string[] = [];
const api = {
	codeSessionsPath: (c?: string) => `/v1/code/sessions?limit=100${c ? `&cursor=${c}` : ''}`,
	codeEventsPath: (id: string, c?: string) => `/v1/code/sessions/${id}/events?limit=200${c ? `&cursor=${c}` : ''}`,
	get: async (path: string) => {
		requested.push(path);
		if (path.startsWith('/v1/code/sessions?')) return { bytes: new ArrayBuffer(0), json: { data: sessionList, next_cursor: null } };
		const m = /sessions\/([^/]+)\/events(?:.*cursor=(\d+))?/.exec(path)!;
		const all = newestFirst(eventsOf[m[1]!] as { sequence_num: string }[]);
		// Two pages: newest 4, then the rest.
		const page = m[2] ? all.slice(4) : all.slice(0, 4);
		return { bytes: new ArrayBuffer(0), json: { data: page, next_cursor: m[2] || all.length <= 4 ? undefined : '4' } };
	},
};
const s = normalizeSettings({ orgId: 'aaaaaaaa-0000-4000-8000-000000000001', maxChatsPerRun: 0}).settings;
const account = s.claude[0]!;
expect('settings: cloud sessions on by default', account.web.cloudSessions === true);
const ctx = (): CloudSyncContext => ({ app: { vault } as never, settings: s, account, api: api as never, delayMs: 0, progress: () => undefined, save: async () => undefined, sleep: async () => undefined });

sessionList = [listEntry(CLOUD, 'anthropic_cloud', 'idle', '2026-11-10T13:00:09Z'), listEntry(BRIDGE, 'bridge', 'idle', '2026-11-10T13:00:09Z'), listEntry(RUNNING, 'anthropic_cloud', 'running', '2026-11-10T14:00:00Z', 'Busy')];
eventsOf[CLOUD] = BASE_EVENTS;
const r1 = emptyCloudResult();
await syncClaudeCloud(ctx(), r1);
const code = account.web.codeFolder;
const md1 = `${code}/notes-app/2026-11-10 Fix the README.md`;
expect('sync: one new cloud session, bridge skipped, running waits', r1.newCount === 1 && r1.listed === 2 && r1.running === 1, JSON.stringify({ ...r1, written: undefined }));
expect('sync: transcript in Code Cloud/<repo>', files.has(md1), [...files.keys()].join(' | '));
expect('sync: raw file mirrored under the raw folder', files.has(`${s.rawRoot}/${code}/notes-app/2026-11-10 Fix the README.json`));
expect('sync: both event pages fetched', requested.filter((p) => p.includes(`${CLOUD}/events`)).length === 2);
const text = files.get(md1) ?? '';
expect('sync: front matter says cloud, repo and link', text.includes('app: "Claude Code (cloud)"') && text.includes('repo: "me/notes-app"') && text.includes(`source: "https://claude.ai/code/${CLOUD}"`) && text.includes('account: "Main"'));
expect('sync: written file saved as an artifact', files.has(`${code}/notes-app/Artifacts/2026-11-10 Fix the README/NOTES.md`));
expect('sync: never asks for the bridge session', !requested.some((p) => p.includes(BRIDGE)));

requested.length = 0;
const r2 = emptyCloudResult();
await syncClaudeCloud(ctx(), r2);
expect('sync again: nothing new, no events fetched', r2.newCount === 0 && r2.unchanged === 1 && !requested.some((p) => p.includes('/events')));

// The session goes on: a new transcript next to the old one.
eventsOf[CLOUD] = [...BASE_EVENTS, ev('user', { type: 'user', uuid: 'u3', timestamp: '2026-11-11T09:00:00Z', message: { role: 'user', content: 'One more thing' } }, '2026-11-11T09:00:00Z')];
sessionList = [listEntry(CLOUD, 'anthropic_cloud', 'idle', '2026-11-11T09:00:00Z')];
const r3 = emptyCloudResult();
await syncClaudeCloud(ctx(), r3);
const updated = [...files.keys()].find((p) => p.includes('(updated') && p.endsWith('.md'));
expect('sync: changed session gets an "(updated …)" transcript, old one stays', r3.changedCount === 1 && !!updated && files.has(md1));
expect('sync: unchanged file not copied again', ![...files.keys()].some((p) => p.includes('(updated') && p.includes('/Artifacts/')));

// Deleted transcript: written again from the saved raw file, same name.
const latest = account.web.cloudIndex![CLOUD]!.md;
files.delete(latest);
requested.length = 0;
const r4 = emptyCloudResult();
await syncClaudeCloud(ctx(), r4);
expect('restore: deleted transcript written again without asking claude.ai', r4.restored.length === 1 && files.has(latest) && !requested.some((p) => p.includes('/events')));

// Moving the folder in Obsidian: the history follows, nothing is restored.
followRename(s, `${code}/notes-app`, `${code}/notes-app-moved`);
const moved = account.web.cloudIndex![CLOUD]!;
expect('follow: moved transcript and files are found', moved.md.startsWith(`${code}/notes-app-moved/`) && Object.values(moved.files ?? {}).every((p) => p.startsWith(`${code}/notes-app-moved/`)));

// Many saved sessions missing: stop instead of restoring them all.
for (let i = 0; i < 12; i++) account.web.cloudIndex![`cse_gone${i}`] = { updated: 'x', md: `gone/${i}.md`, json: `gone/${i}.json`, synced: 'x' };
let stopped = '';
try {
	await syncClaudeCloud(ctx(), emptyCloudResult());
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
