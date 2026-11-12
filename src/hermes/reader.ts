// Reads a Hermes state.db without ever writing to it.
//
// The database runs in WAL mode, so the newest messages may exist only in state.db-wal. A plain
// file copy could tear (Hermes may be writing), and opening state.db alone misses the -wal.
// So each run takes a consistent snapshot with SQLite's backup API: the source is opened
// read-only, copied page by page into a temp file (WAL content included), and everything else
// reads that copy. The temp file is deleted afterwards.
//
// Two ways to do that, the first that works is used:
//   1. node:sqlite, built into Obsidian's Electron (Node 22.16+/23.8+ has backup()).
//   2. A short Python script (sqlite3.backup), with Hermes' own bundled Python or one on the PATH.
// Desktop only; on mobile there is neither, and the caller reports that.

export type Row = Record<string, unknown>;

/** A snapshot of one state.db, readable with SQL. */
export interface Snapshot {
	query(sql: string, params?: (string | number)[]): Promise<Row[]>;
	close(): Promise<void>;
}

export interface SqliteBackend {
	name: 'node:sqlite' | 'python';
	/** Snapshot the database at `dbPath` (read-only on the source). */
	snapshot(dbPath: string): Promise<Snapshot>;
}

type Req = (m: string) => unknown;

/** Obsidian desktop's require (window.require), or Node's in tests; null on mobile. */
export function nodeRequire(): Req | null {
	// In Obsidian: window.require (desktop only). In the Node tests: Node's own require.
	const w = typeof window === 'undefined' ? undefined : (window as unknown as { require?: Req });
	if (typeof w?.require === 'function') return w.require;
	return typeof require === 'function' ? (require as Req) : null;
}

interface NodeFs {
	existsSync(p: string): boolean;
	rmSync(p: string, o: { force: boolean }): void;
	readdirSync(p: string): string[];
}
interface NodePath {
	join(...p: string[]): string;
	dirname(p: string): string;
	basename(p: string): string;
	resolve(p: string): string;
}

function tools(req: Req) {
	return {
		fs: req('fs') as NodeFs,
		path: req('path') as NodePath,
		os: req('os') as { tmpdir(): string },
		crypto: req('crypto') as { randomBytes(n: number): { toString(enc: string): string } },
	};
}

/** True when a path has a folder named "Private" in it. Those are never read. */
export function isPrivatePath(p: string): boolean {
	return p.replace(/\\/g, '/').split('/').some((part) => part.toLowerCase() === 'private');
}

function tempDbPath(req: Req): string {
	const { os, path, crypto } = tools(req);
	return path.join(os.tmpdir(), `ai-chatbridge-hermes-${crypto.randomBytes(6).toString('hex')}.db`);
}

function removeTemp(req: Req, file: string): void {
	const { fs } = tools(req);
	for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
		try {
			fs.rmSync(f, { force: true });
		} catch {
			// best effort: it is our own temp file
		}
	}
}

function checkSource(req: Req, dbPath: string): void {
	if (isPrivatePath(dbPath)) throw new Error(`${dbPath} is inside a Private folder, which is never read.`);
	if (!tools(req).fs.existsSync(dbPath)) throw new Error(`${dbPath} does not exist.`);
}

// ---------- 1. node:sqlite ----------

interface StatementSync {
	all(...params: (string | number)[]): Row[];
}
interface DatabaseSyncT {
	prepare(sql: string): StatementSync;
	exec(sql: string): void;
	close(): void;
}
interface NodeSqlite {
	DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => DatabaseSyncT;
	backup?: (source: DatabaseSyncT, path: string) => Promise<number>;
}

export function nodeSqliteBackend(req: Req | null = nodeRequire()): SqliteBackend | null {
	if (!req) return null;
	let mod: NodeSqlite;
	try {
		mod = req('node:sqlite') as NodeSqlite;
	} catch {
		return null;
	}
	if (typeof mod?.DatabaseSync !== 'function' || typeof mod.backup !== 'function') return null;
	const backup = mod.backup;
	return {
		name: 'node:sqlite',
		async snapshot(dbPath) {
			checkSource(req, dbPath);
			const tmp = tempDbPath(req);
			try {
				const src = new mod.DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
				try {
					await backup(src, tmp);
				} finally {
					src.close();
				}
				const snap = new mod.DatabaseSync(tmp);
				// Our own copy: leave WAL mode so no -wal/-shm files appear next to it.
				snap.exec('PRAGMA journal_mode=DELETE');
				return {
					query: async (sql, params = []) => snap.prepare(sql).all(...params).map((r) => ({ ...r })),
					close: async () => {
						try {
							snap.close();
						} finally {
							removeTemp(req, tmp);
						}
					},
				};
			} catch (e) {
				removeTemp(req, tmp);
				throw e;
			}
		},
	};
}

// ---------- 2. Python ----------

/**
 * snapshot <src> <dst>: read-only open (mode=ro URI), backup into dst.
 * query <db>: reads {"sql", "params"} as JSON on stdin, prints the rows as JSON (ASCII only,
 * so the Windows console code page cannot garble them).
 */
export const PY_SCRIPT = String.raw`
import sys, json, sqlite3, pathlib
cmd = sys.argv[1]
if cmd == "version":
    print(sqlite3.sqlite_version)
elif cmd == "snapshot":
    src = sqlite3.connect(pathlib.Path(sys.argv[2]).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    dst = sqlite3.connect(sys.argv[3])
    try:
        src.backup(dst)
        dst.execute("PRAGMA journal_mode=DELETE")
    finally:
        dst.close()
        src.close()
    print("ok")
elif cmd == "query":
    req = json.loads(sys.stdin.read())
    con = sqlite3.connect(sys.argv[2])
    con.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in con.execute(req["sql"], req.get("params") or [])]
    finally:
        con.close()
    for r in rows:
        for k, v in list(r.items()):
            if isinstance(v, bytes):
                r[k] = v.decode("utf-8", "replace")
    sys.stdout.write(json.dumps(rows, ensure_ascii=True))
`;

interface ChildProcess {
	stdout: { on(ev: 'data', fn: (b: Uint8Array) => void): void };
	stderr: { on(ev: 'data', fn: (b: Uint8Array) => void): void };
	stdin: { end(data?: string): void };
	on(ev: 'error', fn: (e: Error) => void): void;
	on(ev: 'close', fn: (code: number | null) => void): void;
}
type Spawn = (cmd: string, args: string[], o: { windowsHide: boolean; timeout: number }) => ChildProcess;

function runPython(req: Req, python: string, args: string[], input = '', timeoutMs = 60_000): Promise<string> {
	const spawn = (req('child_process') as { spawn: Spawn }).spawn;
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			// Node kills the process after `timeout` (it then closes with code null).
			child = spawn(python, ['-I', '-c', PY_SCRIPT, ...args], { windowsHide: true, timeout: timeoutMs });
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		const out: Uint8Array[] = [];
		const err: Uint8Array[] = [];
		child.stdout.on('data', (b) => out.push(b));
		child.stderr.on('data', (b) => err.push(b));
		child.on('error', reject);
		child.on('close', (code) => {
			const text = (parts: Uint8Array[]) => new TextDecoder().decode(concat(parts));
			if (code === 0) resolve(text(out));
			else if (code === null) reject(new Error(`Python did not answer within ${timeoutMs / 1000} s.`));
			else reject(new Error(`Python failed (${code}): ${text(err).trim().split(/\r?\n/).pop() ?? ''}`));
		});
		child.stdin.end(input);
	});
}

function concat(parts: Uint8Array[]): Uint8Array {
	const n = parts.reduce((a, p) => a + p.length, 0);
	const all = new Uint8Array(n);
	let at = 0;
	for (const p of parts) {
		all.set(p, at);
		at += p.length;
	}
	return all;
}

/**
 * Pythons to try: the one in the settings, Hermes' bundled one (<Hermes root>/tools/python-*),
 * then "python3", "python", "py". The Microsoft Store placeholder is skipped.
 */
export function pythonCandidates(req: Req, configured: string, profilePaths: string[]): string[] {
	const { fs, path } = tools(req);
	const out: string[] = [];
	if (configured.trim()) out.push(configured.trim());
	const roots = new Set<string>();
	for (const p of profilePaths) {
		roots.add(p);
		if (path.basename(path.dirname(p)).toLowerCase() === 'profiles') roots.add(path.dirname(path.dirname(p)));
	}
	for (const root of roots) {
		const dir = path.join(root, 'tools');
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir).filter((n) => /^python/i.test(n)).sort().reverse();
		} catch {
			continue;
		}
		for (const n of names) {
			for (const exe of ['python.exe', 'bin/python3', 'python']) {
				const full = path.join(dir, n, exe);
				if (fs.existsSync(full)) {
					out.push(full);
					break;
				}
			}
		}
	}
	out.push('python3', 'python', 'py');
	return [...new Set(out)];
}

/** The first Python that runs and has sqlite3, or null. */
export async function findPython(req: Req, candidates: string[]): Promise<string | null> {
	for (const c of candidates) {
		if (/WindowsApps/i.test(c)) continue;
		try {
			const v = await runPython(req, c, ['version'], '', 15_000);
			if (/^\d+\.\d+/.test(v.trim())) return c;
		} catch {
			// next one
		}
	}
	return null;
}

export function pythonBackend(python: string, req: Req | null = nodeRequire()): SqliteBackend | null {
	if (!req) return null;
	return {
		name: 'python',
		async snapshot(dbPath) {
			checkSource(req, dbPath);
			const tmp = tempDbPath(req);
			try {
				await runPython(req, python, ['snapshot', dbPath, tmp]);
			} catch (e) {
				removeTemp(req, tmp);
				throw e;
			}
			return {
				query: async (sql, params = []) => JSON.parse(await runPython(req, python, ['query', tmp], JSON.stringify({ sql, params }))) as Row[],
				close: async () => removeTemp(req, tmp),
			};
		},
	};
}

/** node:sqlite if Obsidian has it, else Python. Null when neither works (e.g. on mobile). */
export async function pickBackend(pythonPath: string, profilePaths: string[], req: Req | null = nodeRequire()): Promise<SqliteBackend | null> {
	const node = nodeSqliteBackend(req);
	if (node) return node;
	if (!req) return null;
	const python = await findPython(req, pythonCandidates(req, pythonPath, profilePaths));
	return python ? pythonBackend(python, req) : null;
}
