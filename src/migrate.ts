// Turns whatever is in data.json into current settings. Vaults from before multiple accounts
// had one flat set of fields; those become the first account of each provider, so its login,
// folders and sync history carry over unchanged.

import { layoutFolders, layoutRoot } from './desktop/layout';
import type { DesktopAppSettings, DesktopSettings } from './desktop/types';
import { onlySelected } from './project-catalog';
import type { HermesSettings } from './hermes/types';
import {
	DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_LABEL, DEFAULT_CLAUDE_WEB, DEFAULT_DESKTOP, DEFAULT_GEMINI, DEFAULT_GPT, DEFAULT_HERMES, DEFAULT_LUMO, DEFAULT_STUDIO, DEFAULT_SETTINGS, desktopApp,
	type ChatgptAccount, type ClaudeAccount, type GeminiAccount, type ClaudeWebSettings, type GptSettings, type LumoAccount, type Settings,
} from './settings';

/** The desktop settings as they were saved before multiple accounts. */
export interface LegacyDesktop extends DesktopSettings {
	claude: DesktopAppSettings;
	codex: DesktopAppSettings;
}

type Legacy = Partial<ClaudeWebSettings> & Partial<Omit<Settings, 'claude' | 'chatgpt' | 'desktop'>> & {
	rawFolder?: string;
	gpt?: Partial<GptSettings>;
	desktop?: Partial<LegacyDesktop>;
};

type Saved = Partial<Settings>;

const hydrateDesktop = (d: Partial<DesktopAppSettings> | undefined, folder: string): DesktopAppSettings => ({
	...desktopApp(folder),
	...d,
	extraFolders: [...(d?.extraFolders ?? [])],
	index: { ...(d?.index ?? {}) },
	ignored: { ...(d?.ignored ?? {}) },
	groupCache: { ...(d?.groupCache ?? {}) },
});

/**
 * Desktop settings from data.json over the defaults. A vault that never had them gets the
 * layout next to its Claude Chat folder (e.g. "30 Sources/AI Chats/Claude/Code-Local/Tower").
 */
export function mergeDesktop(saved: Partial<LegacyDesktop> | undefined, chatFolder: string): LegacyDesktop {
	const to = layoutFolders(layoutRoot(chatFolder));
	const parent = chatFolder.split('/').slice(0, -1).join('/');
	const under = (r: string, rest: string) => (r ? `${r}/${rest}` : rest);
	const app = (s: Partial<DesktopAppSettings> | undefined, folder: string, before016: string): DesktopAppSettings => {
		// 0.16.0 used ".../Claude Desktop" and ".../Codex"; nothing written there yet -> the new layout.
		const unused = !Object.keys(s?.index ?? {}).length && s?.folder === under(parent, before016);
		return hydrateDesktop({ ...s, ...(unused ? { folder } : {}) }, folder);
	};
	return {
		...DEFAULT_DESKTOP,
		...saved,
		claude: app(saved?.claude, to.claudeCodeLocal, 'Claude Desktop'),
		codex: app(saved?.codex, to.codexLocal, 'Codex'),
	};
}

/** The flat settings of 0.17 and earlier, as the first account of each provider. */
function fromLegacy(old: Legacy): Saved {
	// v0.1.0 had one "rawFolder"; it becomes the Claude Chat folder.
	const chatFolder = old.chatFolder ?? old.rawFolder ?? DEFAULT_CLAUDE_WEB.chatFolder;
	const { claude, codex, ...desktop } = mergeDesktop(old.desktop, chatFolder);
	const web: Partial<ClaudeWebSettings> = { chatFolder };
	for (const key of ['orgId', 'secretId', 'onlyProjects', 'projects', 'codeFolder', 'projectSubfolders', 'recentFolderName', 'downloadFiles', 'index', 'fileIndex'] as const) {
		if (old[key] !== undefined) Object.assign(web, { [key]: old[key] });
	}
	const shared: Partial<Settings> = {};
	for (const key of ['maxChatsPerRun', 'delaySeconds', 'intervalMinutes', 'logPath'] as const) {
		if (old[key] !== undefined) Object.assign(shared, { [key]: old[key] });
	}
	return {
		...shared,
		claude: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: web as ClaudeWebSettings, desktop: claude }],
		chatgpt: [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: (old.gpt ?? {}) as GptSettings, desktop: codex }],
		desktop,
	};
}

/** Seeds the status text when upgrading a vault with one unfiltered inventory. */
function seedChatProgress(g: GptSettings): void {
	if (g.chatProgress || (g.onlyProjects && g.projects.some((name) => name.trim()))) return;
	const states = Object.entries(g.inventories?.accounts ?? {});
	const session = g.inventories?.session;
	if (session) states.push([session.key, session.inventory]);
	const state = states.length === 1 ? states[0] : undefined;
	if (!state) return;
	const [inventoryKey, inventory] = state;
	const scope = JSON.stringify([g.includeArchived === true, [], '', []]);
	if (inventory.scope !== scope) return;
	const rows = Object.values(inventory.known).filter((row) => row.generation === inventory.generation);
	g.chatProgress = { inventoryKey, scope, total: rows.length, saved: rows.filter((row) => g.index[row.item.id]).length };
}

const hydrateClaude = (a: Partial<ClaudeAccount>): ClaudeAccount => ({
	id: a.id ?? DEFAULT_ACCOUNT_ID,
	label: a.label ?? DEFAULT_ACCOUNT_LABEL,
	web: { ...DEFAULT_CLAUDE_WEB, ...a.web, projects: [...(a.web?.projects ?? [])], index: { ...(a.web?.index ?? {}) }, fileIndex: { ...(a.web?.fileIndex ?? {}) } },
	desktop: hydrateDesktop(a.desktop, DEFAULT_SETTINGS.claude[0]!.desktop.folder),
});

const hydrateGpt = (a: Partial<ChatgptAccount>): ChatgptAccount => {
	const web: GptSettings = { ...DEFAULT_GPT, ...a.web, projects: [...(a.web?.projects ?? [])], index: { ...(a.web?.index ?? {}) }, fileIndex: { ...(a.web?.fileIndex ?? {}) } };
	seedChatProgress(web);
	return {
		id: a.id ?? DEFAULT_ACCOUNT_ID,
		label: a.label ?? DEFAULT_ACCOUNT_LABEL,
		web,
		desktop: hydrateDesktop(a.desktop, DEFAULT_SETTINGS.chatgpt[0]!.desktop.folder),
	};
};

const hydrateLumo = (a: Partial<LumoAccount>): LumoAccount => {
	const projects = [...(a.web?.projects ?? [])];
	// Earlier builds saved every project name; only selected ones may stay in data.json.
	const projectCatalog = onlySelected(a.web?.projectCatalog, projects, a.web?.recentFolderName || DEFAULT_LUMO.recentFolderName);
	return {
		id: a.id ?? DEFAULT_ACCOUNT_ID,
		label: a.label ?? DEFAULT_ACCOUNT_LABEL,
		web: { ...DEFAULT_LUMO, ...a.web, projects, projectCatalog, index: { ...(a.web?.index ?? {}) } },
	};
};

/** A vault that never had Lumo gets it next to its other chat folders. */
function firstLumo(claudeChatFolder: string): LumoAccount[] {
	return [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: { ...DEFAULT_LUMO, folder: layoutFolders(layoutRoot(claudeChatFolder)).lumoChat } }];
}

const hydrateGemini = (a: Partial<GeminiAccount>): GeminiAccount => ({
	id: a.id ?? DEFAULT_ACCOUNT_ID,
	label: a.label ?? DEFAULT_ACCOUNT_LABEL,
	web: { ...DEFAULT_GEMINI, ...a.web, index: { ...(a.web?.index ?? {}) } },
	studio: { ...DEFAULT_STUDIO, ...a.studio, index: { ...(a.studio?.index ?? {}) } },
});

/** A vault that never had Gemini gets it next to its other chat folders. */
function firstGemini(claudeChatFolder: string): GeminiAccount[] {
	const to = layoutFolders(layoutRoot(claudeChatFolder));
	return [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, web: { ...DEFAULT_GEMINI, index: {}, folder: to.geminiChat }, studio: { ...DEFAULT_STUDIO, index: {}, folder: to.studio } }];
}

/** Hermes settings; a new vault puts them next to the other providers ("<root>/Hermes"). */
function hydrateHermes(h: Partial<HermesSettings> | undefined, claudeChatFolder: string): HermesSettings {
	const root = layoutRoot(claudeChatFolder);
	return {
		...DEFAULT_HERMES,
		...h,
		folder: h?.folder ?? (root ? `${root}/Hermes` : 'Hermes'),
		profiles: (h?.profiles ?? []).map((p) => ({ ...p, index: { ...(p.index ?? {}) }, ignored: { ...(p.ignored ?? {}) } })),
	};
}

/** `migrated` = flat settings were converted (the caller keeps a copy of the old file). */
export function normalizeSettings(loaded: unknown): { settings: Settings; migrated: boolean } {
	const raw = (loaded ?? {}) as Saved & Legacy;
	const flat = !Array.isArray(raw.claude);
	const saved: Saved = flat ? fromLegacy(raw) : raw;
	const claude = saved.claude?.length ? saved.claude : DEFAULT_SETTINGS.claude;
	const chatgpt = saved.chatgpt?.length ? saved.chatgpt : DEFAULT_SETTINGS.chatgpt;
	const hydratedClaude = claude.map(hydrateClaude);
	return {
		migrated: flat && loaded !== null && loaded !== undefined,
		settings: {
			maxChatsPerRun: saved.maxChatsPerRun ?? DEFAULT_SETTINGS.maxChatsPerRun,
			delaySeconds: saved.delaySeconds ?? DEFAULT_SETTINGS.delaySeconds,
			intervalMinutes: saved.intervalMinutes ?? DEFAULT_SETTINGS.intervalMinutes,
			syncOnStartup: saved.syncOnStartup ?? DEFAULT_SETTINGS.syncOnStartup,
			logPath: saved.logPath ?? DEFAULT_SETTINGS.logPath,
			rawRootOn: saved.rawRootOn ?? DEFAULT_SETTINGS.rawRootOn,
			rawRoot: saved.rawRoot ?? DEFAULT_SETTINGS.rawRoot,
			claude: hydratedClaude,
			chatgpt: chatgpt.map(hydrateGpt),
			lumo: saved.lumo?.length ? saved.lumo.map(hydrateLumo) : firstLumo(hydratedClaude[0]!.web.chatFolder),
			gemini: saved.gemini?.length ? saved.gemini.map(hydrateGemini) : firstGemini(hydratedClaude[0]!.web.chatFolder),
			desktop: { ...DEFAULT_DESKTOP, ...saved.desktop },
			hermes: hydrateHermes(saved.hermes, hydratedClaude[0]!.web.chatFolder),
		},
	};
}
