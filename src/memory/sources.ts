// Reads what Codex and Claude Code keep about you on this computer. Reading only: nothing
// outside the vault is ever changed. Files come through the same DesktopFs as the session sync
// (so CODEX_HOME and CLAUDE_CONFIG_DIR are honoured and tests can use a fake one); Codex's
// memory database is read from a read-only snapshot, like Hermes' state.db.
//
// Nothing is filtered or rewritten: the text is saved exactly as the AI keeps it. The only
// thing skipped is a folder named "Private".

import { claudeHome, codexHome, type DesktopFs } from '../desktop/scan';
import { isPrivatePath, type Row, type SqliteBackend } from '../hermes/reader';
import type { MemoryCapture, MemoryFile, MemoryPlace } from './types';

const MAX_DEPTH = 6;
/** A memory file larger than this is listed, not copied. */
const MAX_BYTES = 2_000_000;

const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`;
const plural = (n: number, noun: string, many = `${noun}s`) => `${n.toLocaleString('en')} ${n === 1 ? noun : many}`;

const LANG: Record<string, string> = { md: 'markdown', json: 'json', jsonl: 'json', toml: 'toml', yaml: 'yaml', yml: 'yaml' };
const langOf = (name: string): string => LANG[/\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'text';

/** Every file below `dir`, as paths relative to it, sorted. */
async function walk(fs: DesktopFs, dir: string, depth = 0, prefix = ''): Promise<string[]> {
	if (depth > MAX_DEPTH) return [];
	const out: string[] = [];
	const entries = [...(await fs.readDir(dir))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const e of entries) {
		if (e.dir) {
			if (e.name.toLowerCase() !== 'private') out.push(...(await walk(fs, join(dir, e.name), depth + 1, `${prefix}${e.name}/`)));
		} else out.push(`${prefix}${e.name}`);
	}
	return out;
}

/** One file as a memory entry: its text unchanged, or a note saying why it is not shown. */
async function readFile(fs: DesktopFs, full: string, shown: string): Promise<MemoryFile | null> {
	const st = await fs.stat(full);
	if (!st) return null;
	const lang = langOf(shown);
	if (st.size > MAX_BYTES) return { path: shown, lang, note: `Not copied: ${plural(st.size, 'byte')}, larger than ${plural(MAX_BYTES, 'byte')}.` };
	const text = await fs.readText(full);
	if (text === null) return { path: shown, lang, note: 'Could not be read.' };
	if (text.includes('\u0000')) return { path: shown, lang, note: `Not text (${plural(st.size, 'byte')}).` };
	return { path: shown, lang, text };
}

/** A folder's files as memory entries, and its line in the list of places. */
async function readFolder(fs: DesktopFs, home: string, folder: string, exists: boolean): Promise<{ place: MemoryPlace; files: MemoryFile[] }> {
	if (!exists) return { place: { name: `${folder}/`, status: 'not found' }, files: [] };
	const files: MemoryFile[] = [];
	for (const rel of await walk(fs, join(home, folder))) {
		const f = await readFile(fs, join(home, `${folder}/${rel}`), `/${folder}/${rel}`);
		if (f) files.push(f);
	}
	return { place: { name: `${folder}/`, status: plural(files.length, 'file') }, files };
}

// ---------- Codex ----------

/** Codex's memory pipeline keeps one row per chat thread here before it writes the memory files. */
const CODEX_TABLE = 'stage1_outputs';
/** Counters Codex updates whenever it uses a memory. Left out, or every use would make a new snapshot. */
const CODEX_COUNTERS = new Set(['usage_count', 'last_usage', 'selected_for_phase2', 'selected_for_phase2_source_updated_at']);

/** One database row as text: short values as "name: value" lines, long text under its own "--- name ---" line. */
export function rowText(row: Row, skip: ReadonlySet<string> = CODEX_COUNTERS): string {
	const head: string[] = [];
	const long: string[] = [];
	for (const [key, value] of Object.entries(row)) {
		if (skip.has(key) || value === null || value === undefined) continue;
		if (value instanceof Uint8Array) head.push(`${key}: (binary, ${plural(value.length, 'byte')})`);
		else if (typeof value === 'string' && (value.includes('\n') || value.length > 200)) long.push(`--- ${key} ---\n${value}`);
		else head.push(`${key}: ${typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`);
	}
	return [head.join('\n'), ...long].filter(Boolean).join('\n\n');
}

async function readCodexDb(home: string, name: string, backend: SqliteBackend | null): Promise<{ place: MemoryPlace; files: MemoryFile[] }> {
	if (!backend) return { place: { name, status: 'not read: no way to read SQLite here' }, files: [] };
	const db = await backend.snapshot(join(home, name));
	try {
		const has = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [CODEX_TABLE]);
		if (!has.length) return { place: { name, status: `no ${CODEX_TABLE} table` }, files: [] };
		const rows = await db.query(`SELECT * FROM ${CODEX_TABLE} ORDER BY thread_id`);
		const files = rows.map((row, i): MemoryFile => {
			const id = typeof row.thread_id === 'string' && row.thread_id ? row.thread_id : `row ${i + 1}`;
			return { path: `/${name}/${CODEX_TABLE}/${id}`, lang: 'text', text: rowText(row) };
		});
		return { place: { name, status: `${plural(rows.length, 'memory', 'memories')} in table ${CODEX_TABLE}` }, files };
	} finally {
		await db.close();
	}
}

/**
 * Codex on this computer: the global AGENTS.md (and AGENTS.override.md), everything in
 * memories/ and memories_v2/, and the per-thread rows of its memory database.
 */
export async function captureCodex(fs: DesktopFs, account: string, backend: SqliteBackend | null): Promise<MemoryCapture> {
	const home = codexHome(fs);
	if (isPrivatePath(home)) throw new Error(`${home} is inside a Private folder, which is never read.`);
	const top = await fs.readDir(home);
	const hasDir = (n: string) => top.some((e) => e.dir && e.name === n);
	const places: MemoryPlace[] = [];
	const files: MemoryFile[] = [];
	let found = false;

	for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
		const f = await readFile(fs, join(home, name), `/${name}`);
		// The override file is rare: only listed when it is there.
		if (f || name === 'AGENTS.md') places.push({ name, status: f ? 'found' : 'not found' });
		if (f) {
			files.push(f);
			found = true;
		}
	}
	for (const folder of ['memories', 'memories_v2']) {
		const r = await readFolder(fs, home, folder, hasDir(folder));
		places.push(r.place);
		files.push(...r.files);
		if (hasDir(folder)) found = true;
	}
	const dbs = top.filter((e) => !e.dir && /^memories(_\d+)?\.sqlite$/.test(e.name)).map((e) => e.name).sort();
	for (const name of dbs) {
		const r = await readCodexDb(home, name, backend);
		places.push(r.place);
		files.push(...r.files);
		found = true;
	}
	if (!dbs.length) places.push({ name: 'memories_*.sqlite', status: 'not found' });
	return { provider: 'Codex', account, source: 'local', home, places, files, found };
}

// ---------- Claude Code ----------

/** A project folder name ("D--Notes-Private-x") that has "Private" as one of its parts. */
const privateProject = (name: string): boolean => name.split('-').some((part) => part.toLowerCase() === 'private');

/** Claude Code on this computer: the global CLAUDE.md and every project's memory folder. */
export async function captureClaudeCode(fs: DesktopFs, account: string): Promise<MemoryCapture> {
	const home = claudeHome(fs);
	if (isPrivatePath(home)) throw new Error(`${home} is inside a Private folder, which is never read.`);
	const places: MemoryPlace[] = [];
	const files: MemoryFile[] = [];

	const global = await readFile(fs, join(home, 'CLAUDE.md'), '/CLAUDE.md');
	places.push({ name: 'CLAUDE.md', status: global ? 'found' : 'not found' });
	if (global) files.push(global);

	const projects = (await fs.readDir(join(home, 'projects'))).filter((e) => e.dir).map((e) => e.name).sort();
	let withMemory = 0;
	let memoryFiles = 0;
	const skipped: string[] = [];
	for (const project of projects) {
		const dir = join(home, `projects/${project}/memory`);
		const rels = await walk(fs, dir);
		if (!rels.length) continue;
		if (privateProject(project)) {
			skipped.push(project);
			continue;
		}
		withMemory++;
		for (const rel of rels) {
			const f = await readFile(fs, join(dir, rel), `/projects/${project}/memory/${rel}`);
			if (f) {
				files.push(f);
				memoryFiles++;
			}
		}
	}
	places.push({
		name: 'projects/*/memory/',
		status: projects.length
			? `${plural(memoryFiles, 'file')} in ${plural(withMemory, 'project')} (${plural(projects.length, 'project')} looked at)`
			: 'not found',
	});
	if (skipped.length) places.push({ name: 'skipped', status: `${plural(skipped.length, 'project')} with "Private" in the name: ${skipped.join(', ')}` });
	return { provider: 'Claude Code', account, source: 'local', home, places, files, found: !!global || projects.length > 0 };
}
