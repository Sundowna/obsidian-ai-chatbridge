// AI memory: what each AI keeps about you between chats (memory files, global instructions),
// saved as dated, read-only snapshots. Pure types, no Obsidian.

/** What we remember about one source's last snapshot (no memory text). */
export interface MemoryState {
	/** Fingerprint of the snapshot's text below the properties. */
	hash: string;
	/** Vault path of that snapshot. */
	snapshot: string;
	/** When it was written (ISO). */
	synced: string;
	/** How many memory files it holds. */
	files: number;
}

export interface MemorySettings {
	/** Vault folder; snapshots go to <folder>/<provider>/<account>/. */
	folder: string;
	/** Automatic memory sync; 0 = off. */
	intervalMinutes: number;
	/** Codex on this computer (~/.codex, or CODEX_HOME). */
	codexLocal: boolean;
	/** Claude Code on this computer (~/.claude, or CLAUDE_CONFIG_DIR). */
	claudeCodeLocal: boolean;
	/** Claude accounts (by account ID) whose memories on claude.ai are read. */
	claudeWeb: Record<string, boolean>;
	/** ChatGPT accounts (by account ID) whose memories on chatgpt.com are read. */
	chatgptWeb: Record<string, boolean>;
	/** Lumo accounts (by account ID) whose memories and personalization in Lumo are read. Missing = none. */
	lumoWeb?: Record<string, boolean>;
	/** Gemini accounts (by account ID) whose own Gems are read. Missing = none. */
	geminiWeb?: Record<string, boolean>;
	/** The privacy filter: passwords, recovery codes, 2FA seeds, ID and card numbers become [REDACTED]. */
	redact: boolean;
	/** "<provider>/<account>" -> its last snapshot. */
	states: Record<string, MemoryState>;
}

/** One memory file as the AI keeps it, or a row of its memory database. */
export interface MemoryFile {
	/** Path below the AI's home folder, starting with "/": the H2 in the snapshot. */
	path: string;
	/** The text, unchanged. Missing when the file could not be shown as text (see note). */
	text?: string;
	/** Shown instead of the text, e.g. "Not text (1,204 bytes)." */
	note?: string;
	/** Code-block language, from the file's ending. */
	lang: string;
}

/** One place that was looked at, and what was there. */
export interface MemoryPlace {
	/** As written in the snapshot's list, e.g. "memories/". */
	name: string;
	/** "3 files", "not found", "0 memories" … */
	status: string;
}

/** Everything one AI keeps on this computer, read in one go. */
export interface MemoryCapture {
	provider: string;
	account: string;
	source: 'local' | 'web';
	/** The AI's home folder that was read, or the website. */
	home: string;
	places: MemoryPlace[];
	files: MemoryFile[];
	/** Set by the privacy filter when it replaced something: how many values in all. */
	redacted?: number;
	/** False when none of the places exists: nothing is written then. */
	found: boolean;
}
