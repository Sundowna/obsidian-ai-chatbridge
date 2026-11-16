// Asking another device to sync: the request and status files, the Writer's rules (each
// request once, not too old, at most one run per two minutes, never into a running sync) and
// the role defaults. The second half runs two fake devices over one in-memory folder.
// Run: npm run test:remote

import { RemoteSync } from '../src/remote/controller';
import {
	cleanNote, controlFolder, decide, defaultRole, doneStatus, mayAsk, MIN_GAP_MS, newRequest, onStatus, parseRequest, parseStatus, refusedStatus, remember, REMEMBER_IDS, REQUEST_FILE,
	roleOf, runningStatus, STATUS_FILE, statusText, type SyncStatus,
} from '../src/remote/protocol';
import type { LastRun } from '../src/last-run';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const HOUR = 3_600_000;
const run = (label: string, outcome: LastRun['outcome'], n = 0, note?: string): LastRun => ({ at: T0 + 5000, trigger: 'auto', outcome, label, newCount: n, changedCount: 0, unchanged: 7, restored: 0, leftForLater: 0, ...(note ? { note } : {}) });

// --- roles ----------------------------------------------------------------------
expect('a computer syncs by default', defaultRole(false) === 'writer');
expect('a phone asks by default', defaultRole(true) === 'requester');
expect('nothing saved on a computer: writer', roleOf(null, false) === 'writer' && roleOf(undefined, false) === 'writer');
expect('a computer can be set to ask', roleOf('requester', false) === 'requester');
expect('a computer keeps a saved writer role', roleOf('writer', false) === 'writer');
expect('junk in storage falls back to the default', roleOf('boss', false) === 'writer' && roleOf(42, false) === 'writer');
expect('a phone always asks, whatever is saved (no direct sync yet)', roleOf('writer', true) === 'requester' && roleOf(null, true) === 'requester');

// --- the request file -------------------------------------------------------------
const req = newRequest('abc12345-xyz', 'Pixel', T0);
expect('a new request names id, device, time and "all"', req.id === 'abc12345-xyz' && req.device === 'Pixel' && req.at === '2026-11-16T12:00:00.000Z' && req.providers.join() === 'all');
expect('a written request reads back the same', JSON.stringify(parseRequest(JSON.stringify(req))) === JSON.stringify(req));
expect('an empty file is no request', parseRequest('') === null);
expect('a half-written file is no request', parseRequest(JSON.stringify(req).slice(0, 30)) === null);
expect('another version is no request', parseRequest(JSON.stringify({ ...req, v: 2 })) === null);
expect('an odd id is no request', parseRequest(JSON.stringify({ ...req, id: '../../x' })) === null && parseRequest(JSON.stringify({ ...req, id: 'short' })) === null);
expect('a request without a time is no request', parseRequest(JSON.stringify({ ...req, at: 'soon' })) === null);
expect('a request without a device is no request', parseRequest(JSON.stringify({ ...req, device: '' })) === null);
expect('missing providers means all', parseRequest(JSON.stringify({ ...req, providers: undefined }))?.providers.join() === 'all');
expect('a list or null is no request', parseRequest('[]') === null && parseRequest('null') === null);

// --- what the Writer decides ---------------------------------------------------------
const idle = { handled: [] as string[], lastRunAt: 0, busy: false };
expect('a fresh request runs', decide(req, T0 + 1000, idle, 12).action === 'run');
expect('a handled id is ignored', decide(req, T0 + 1000, { ...idle, handled: ['abc12345-xyz'] }, 12).action === 'ignore');
expect('a handled id is ignored even when it is old or a sync runs', decide(req, T0 + 99 * HOUR, { handled: [req.id], lastRunAt: T0, busy: true }, 12).action === 'ignore');
const old = decide(req, T0 + 13 * HOUR, idle, 12);
expect('older than the limit is refused, with its age', old.action === 'too-old' && old.hours === 13);
expect('exactly at the limit still runs', decide(req, T0 + 12 * HOUR, idle, 12).action === 'run');
expect('the limit is the setting', decide(req, T0 + 13 * HOUR, idle, 24).action === 'run');
const busy = decide(req, T0 + 1000, { ...idle, busy: true }, 12);
expect('a running sync is never interrupted: wait, no time given', busy.action === 'wait' && busy.at === undefined);
const soon = decide(req, T0 + 60_000, { ...idle, lastRunAt: T0 }, 12);
expect('one run per two minutes: wait until they are over', soon.action === 'wait' && soon.at === T0 + MIN_GAP_MS);
expect('after two minutes it runs', decide(req, T0 + MIN_GAP_MS, { ...idle, lastRunAt: T0 }, 12).action === 'run');
expect('a phone clock ahead of the computer does not block', decide(newRequest('future-000001', 'Pixel', T0 + 5 * 60_000), T0, idle, 12).action === 'run');
let list: string[] = [];
for (let i = 0; i < REMEMBER_IDS + 10; i++) list = remember(list, `id-${i}`);
expect('only the newest ids are remembered', list.length === REMEMBER_IDS && list[0] === 'id-10' && list.at(-1) === `id-${REMEMBER_IDS + 9}`);
expect('remembering an id twice keeps it once', remember(['a', 'b'], 'a').join() === 'b,a');

// --- the status file -----------------------------------------------------------------
const running = runningStatus(req, 'Tower', T0 + 1000);
expect('running status names the request and both devices', running.requestId === req.id && running.device === 'Tower' && running.requestedBy === 'Pixel' && running.state === 'running' && !running.finishedAt);
const ok = doneStatus(running, [run('claude.ai', 'ok', 3), run('ChatGPT', 'ok', 1)], T0 + 9000);
expect('done: ok with counts per provider', ok.state === 'done' && ok.result === 'ok' && ok.providers['claude.ai']?.new === 3 && ok.providers.ChatGPT?.unchanged === 7 && ok.finishedAt === '2026-11-16T12:00:09.000Z' && ok.startedAt === running.startedAt);
expect('done: message counts what was saved', ok.message === '4 saved, 14 unchanged.');
const problems = doneStatus(running, [run('claude.ai', 'ok', 2), run('ChatGPT', 'error', 0, 'chatgpt.com answered 401 (not logged in).')], T0 + 9000);
expect('done: an error makes it "problems" and names the provider', problems.result === 'problems' && problems.message === '2 saved. Problems: ChatGPT.' && problems.providers.ChatGPT?.note?.includes('401') === true);
const skippedRun = doneStatus(running, [run('claude.ai', 'ok', 2)], T0, undefined, ['ChatGPT']);
expect('done: a source waiting for a sync by hand is named', skippedRun.result === 'problems' && skippedRun.message === '2 saved. Skipped until synced by hand on Tower: ChatGPT.');
expect('done: only skipped sources is not "nothing"', doneStatus(running, [], T0, undefined, ['ChatGPT']).result === 'problems');
expect('done: a source that failed in this run is not listed twice', doneStatus(running, [run('ChatGPT', 'error')], T0, undefined, ['ChatGPT']).message === '0 saved. Problems: ChatGPT.');
expect('done: a cooldown counts as a problem too', doneStatus(running, [run('ChatGPT', 'waiting')], T0).result === 'problems');
expect('done: stopped', doneStatus(running, [run('claude.ai', 'stopped', 1)], T0).result === 'stopped');
expect('done: no runs is "nothing"', doneStatus(running, [], T0).result === 'nothing');
expect('done: a thrown error is "failed"', doneStatus(running, [], T0, 'boom').result === 'failed' && doneStatus(running, [], T0, 'boom').message === 'The sync failed: boom');
const KEY = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OTAifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const leaky = doneStatus(running, [run('claude.ai', 'error', 0, `Cookie sessionKey=sk-ant-sid01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA; Authorization: Bearer ${KEY}`)], T0, `token ${KEY}`);
const leakyText = JSON.stringify(leaky);
expect('no login survives in a status', !leakyText.includes('sk-ant-sid01') && !leakyText.includes('eyJ') && !leakyText.includes('AAAAAAAA'));
expect('long notes are cut', cleanNote('word '.repeat(200)).length <= 301);
const refused = refusedStatus(req, 'Tower', T0 + 13 * HOUR, 13, 12);
expect('refused status says why', refused.state === 'refused' && refused.result === 'too-old' && refused.message?.includes('13 hours old') === true);
expect('a written status reads back', parseStatus(JSON.stringify(ok))?.result === 'ok' && parseStatus(JSON.stringify(running))?.state === 'running');
expect('a half-written status is none', parseStatus(JSON.stringify(ok).slice(0, 40)) === null && parseStatus('') === null);
expect('a status with an unknown state is none', parseStatus(JSON.stringify({ ...ok, state: 'maybe' })) === null);
const clock = () => 'today 12:00';
expect('status in words: running', statusText(running, clock).text === 'Tower is syncing (started today 12:00).');
expect('status in words: done ok', statusText(ok, clock).text === 'Last synced by Tower today 12:00: 4 saved, 14 unchanged.' && statusText(ok, clock).tone === 'ok');
expect('status in words: an error is red, a refusal orange', statusText(problems, clock).tone === 'bad' && statusText(skippedRun, clock).tone === 'bad' && statusText(refused, clock).tone === 'warn');

// --- the asking side -----------------------------------------------------------------
const pending = { id: req.id, at: T0 };
expect('running is told once', onStatus(pending, running).notify && onStatus(pending, running).pending?.seen === 'running' && !onStatus({ ...pending, seen: 'running' }, running).notify);
expect('done is told and ends the wait', onStatus({ ...pending, seen: 'running' }, ok).notify && onStatus(pending, ok).pending === null);
expect('refused is told and ends the wait', onStatus(pending, refused).notify && onStatus(pending, refused).pending === null);
const other: SyncStatus = { ...ok, requestId: 'another-request-1' };
expect('a status for another request says nothing', !onStatus(pending, other).notify && onStatus(pending, other).pending === pending);
expect('no status, or not waiting: nothing', !onStatus(pending, null).notify && !onStatus(null, ok).notify);
expect('asking again is held back for two minutes', !mayAsk(pending, T0 + 60_000) && mayAsk(pending, T0 + MIN_GAP_MS) && mayAsk(null, T0));

// --- the folder setting -------------------------------------------------------------
expect('folder is tidied', controlFolder(' /00 Inbox/Mobile/ChatBridge/ ') === '00 Inbox/Mobile/ChatBridge' && controlFolder('a\\b') === 'a/b');
expect('empty, hidden or climbing folders are refused', controlFolder('') === null && controlFolder('.obsidian/x') === null && controlFolder('a/../b') === null && controlFolder('a/.hidden') === null);

// --- two devices over one folder ------------------------------------------------------
// The controller's timers and the settings UI are not exercised here; the files, the device
// storage and the order of things are.
(globalThis as unknown as { window: unknown }).window = globalThis;
const files = new Map<string, string>();
const sizes = new Map<string, number>();
const writes = new Map<string, number>();
const dirs = new Set<string>();
const adapter = {
	exists: async (p: string) => files.has(p) || dirs.has(p),
	read: async (p: string) => {
		const t = files.get(p);
		if (t === undefined) throw new Error('missing');
		return t;
	},
	// Like Android: a file that is created reports size 0 until it is written a second time.
	write: async (p: string, t: string) => {
		writes.set(p, (writes.get(p) ?? 0) + 1);
		sizes.set(p, files.has(p) ? t.length : 0);
		files.set(p, t);
	},
	stat: async (p: string) => (files.has(p) ? { type: 'file', size: sizes.get(p) ?? 0 } : null),
	mkdir: async (p: string) => void dirs.add(p),
};
const FOLDER = 'Inbox/ChatBridge';
function device(role: 'writer' | 'requester', name: string) {
	const store = new Map<string, unknown>([['ai-chatbridge-role', role], ['ai-chatbridge-device', name]]);
	const state = { busy: false, synced: 0, fail: false, lastRuns: {} as Record<string, LastRun> };
	const plugin = {
		app: { vault: { adapter }, loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => (v === null ? store.delete(k) : store.set(k, v)) },
		settings: { remote: { folder: FOLDER, maxAgeHours: 12 }, get lastRuns() { return state.lastRuns; } },
		get busy() { return state.busy; },
		onBusyChange: () => () => undefined,
		pausedSources: () => [] as string[],
		syncAllRequested: async () => {
			state.synced++;
			if (state.fail) throw new Error('disk full');
			state.lastRuns['web:claude:default'] = { ...run('claude.ai', 'ok', 2), at: Date.now() };
		},
	};
	return { remote: new RemoteSync(plugin as never), state, store };
}
const readStatus = () => parseStatus(files.get(`${FOLDER}/${STATUS_FILE}`) ?? '');

async function devices() {
	const tower = device('writer', 'Tower');
	const phone = device('requester', 'Pixel');

	await tower.remote.check();
	expect('devices: no request, nothing happens', tower.state.synced === 0 && files.size === 0);

	await phone.remote.ask();
	const written = parseRequest(files.get(`${FOLDER}/${REQUEST_FILE}`) ?? '');
	expect('devices: the phone writes the request and creates the folder', written?.device === 'Pixel' && dirs.has('Inbox') && dirs.has(FOLDER) && phone.remote.pending?.id === written?.id);
	expect('devices: the phone itself never syncs', phone.state.synced === 0);
	expect('devices: a new file reported as empty is written once more, so its size is right', writes.get(`${FOLDER}/${REQUEST_FILE}`) === 2 && sizes.get(`${FOLDER}/${REQUEST_FILE}`) === files.get(`${FOLDER}/${REQUEST_FILE}`)!.length);
	await phone.remote.check();
	expect('devices: a phone looking at its own request does nothing', phone.state.synced === 0 && readStatus() === null);

	await tower.remote.check();
	const first = readStatus();
	expect('devices: the computer runs the request once and reports', tower.state.synced === 1 && first?.state === 'done' && first.result === 'ok' && first.requestId === written?.id && first.device === 'Tower' && first.requestedBy === 'Pixel' && first.providers['claude.ai']?.new === 2);
	await tower.remote.check();
	await tower.remote.check();
	expect('devices: the same request is never run again', tower.state.synced === 1);

	await phone.remote.check();
	expect('devices: the phone sees the answer and stops waiting', phone.remote.pending === null && phone.remote.status?.result === 'ok');

	// A second request right away: the phone holds it back, and so would the computer.
	await phone.remote.ask();
	expect('devices: a second ask within two minutes still goes out once the first is answered', parseRequest(files.get(`${FOLDER}/${REQUEST_FILE}`) ?? '')?.id !== written?.id);
	const second = parseRequest(files.get(`${FOLDER}/${REQUEST_FILE}`) ?? '')!;
	await phone.remote.ask();
	expect('devices: asking twice in a row writes one request', parseRequest(files.get(`${FOLDER}/${REQUEST_FILE}`) ?? '')?.id === second.id);
	await tower.remote.check();
	expect('devices: the computer waits out its two minutes', tower.state.synced === 1 && readStatus()?.requestId === written?.id);
	tower.remote.stop(); // clears the timer it set for later

	// A new computer session (same device storage), two minutes on.
	const tower2 = new RemoteSync((() => {
		const d = device('writer', 'Tower');
		for (const [k, v] of tower.store) d.store.set(k, v);
		d.store.set('ai-chatbridge-request-last-run', Date.now() - MIN_GAP_MS - 1);
		d.state.busy = true;
		towerLater = d;
		return (d.remote as unknown as { plugin: unknown }).plugin;
	})() as never);
	await tower2.check();
	expect('devices: a running sync is not interrupted', towerLater.state.synced === 0 && readStatus()?.requestId === written?.id);
	towerLater.state.busy = false;
	towerLater.state.fail = true;
	await tower2.check();
	const failed = readStatus();
	expect('devices: when it is free the request runs; a failure is reported, not hidden', towerLater.state.synced === 1 && failed?.requestId === second.id && failed.result === 'failed' && failed.message === 'The sync failed: disk full');
	await tower2.check();
	expect('devices: a failed request is not retried on its own', towerLater.state.synced === 1);

	// An old request, e.g. the computer was off for a day.
	const stale = newRequest('old-request-0001', 'Pixel', Date.now() - 30 * HOUR);
	files.set(`${FOLDER}/${REQUEST_FILE}`, JSON.stringify(stale));
	towerLater.store.set('ai-chatbridge-request-last-run', 0);
	await tower2.check();
	expect('devices: an old request is refused, not run', towerLater.state.synced === 1 && readStatus()?.state === 'refused' && readStatus()?.requestId === stale.id);

	// A half-written request file (the vault sync is still carrying it).
	files.set(`${FOLDER}/${REQUEST_FILE}`, '{"v":1,"id":"half-writ');
	await tower2.check();
	expect('devices: a half-written request is left for the next look', towerLater.state.synced === 1 && readStatus()?.requestId === stale.id);

	// Obsidian closed in the middle of a requested sync: the status must not say "running" for ever.
	const cut = newRequest('cut-short-00001', 'Pixel', Date.now());
	files.set(`${FOLDER}/${REQUEST_FILE}`, JSON.stringify(cut));
	files.set(`${FOLDER}/${STATUS_FILE}`, JSON.stringify(runningStatus(cut, 'Tower', Date.now())));
	towerLater.store.set('ai-chatbridge-requests-handled', [cut.id]);
	await tower2.check();
	expect('devices: a status left at "running" is closed after a restart', towerLater.state.synced === 1 && readStatus()?.state === 'done' && readStatus()?.result === 'failed');

	// A computer set to ask does not serve requests.
	const laptop = device('requester', 'Laptop');
	files.set(`${FOLDER}/${REQUEST_FILE}`, JSON.stringify(newRequest('for-the-tower-01', 'Pixel', Date.now())));
	await laptop.remote.check();
	expect('devices: a requester never runs a request', laptop.state.synced === 0);

	// An unusable folder setting.
	const lost = device('requester', 'Pixel');
	(lost.remote as unknown as { plugin: { settings: { remote: { folder: string } } } }).plugin.settings.remote.folder = '.hidden';
	const before = files.size;
	await lost.remote.ask();
	expect('devices: with an unusable folder nothing is written and nothing is pending', files.size === before && lost.remote.pending === null);
	tower2.stop();
}
let towerLater: ReturnType<typeof device>;

void devices().then(() => {
	console.log(failures ? `\n${failures} FAILED` : '\nAll remote sync tests passed.');
	process.exit(failures ? 1 : 0);
});
