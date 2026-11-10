<img src="chatBridgeLogo.png" width="120" alt="AI ChatBridge logo"><h1 align="left">AI ChatBridge</h1>

Sync your **Claude**, **ChatGPT**, **Gemini**, **Google AI Studio** and **Proton Lumo** chats into your Obsidian vault.
The idea is to mirror the chats and folders from your AI web & desktop interfaces to your Obsidian vault, **including media, files and artifacts.**
This way it looks and feels the same way as the GUIs that you are used to - minimum barrier-to-entry and context switching.
Each chat is saved as the raw JSON the website returns, plus a readable Markdown transcript, so your AI conversations live next to the rest of your notes.

### Overview:
- Sync chats from Claude, ChatGPT, Gemini, Google AI Studio and Proton Lumo - web & desktop interfaces (other models coming)
- Claude Code and Codex sessions from your computer too
- Multiple accounts per provider e.g. 2x Claude Pro accounts
- Includes downloads of everything you put in and got out of AI - all media, files and artifacts
- Same folders as in the apps - projects, recent chats, Claude Code groups, Codex projects, etc.
- Selective project sync (e.g. when you have multiple vaults) - choose which folders get synced per vault
- New feature: Target folder per project - e.g. send your "Thesis" project straight into `10 Projects/Thesis`, the rest stays in the default folders
- New feature: ChatGPT's visual answers (cards, charts, diagrams, source chips) and voice chats come through readable - not as "see raw JSON"
- Background sync job with timer
- Automatic retry for large imports i.e. HTTP 429 - Too many requests error (no waiting for days for OpenAI to send you your data)
- Only new or changed chats get synced again - and moving or renaming notes in Obsidian is tracked
- Read-only - nothing is ever changed or deleted on the provider's side

### Note:
Large imports (i.e. 1,000+ chats) may take a while due to "429 - Too many request" errors from provider servers - but still a lot faster than OpenAI's response to data request :)

Changing a project's target folder only applies to chats synced from then on - already saved chats stay where they are. Just move them in Obsidian, the plugin keeps track.

> **Unofficial.** This plugin is not affiliated with, endorsed by, or supported by Anthropic, OpenAI, Google or Proton. It reads the same web endpoints your browser uses, which can change without notice.

## What gets synced

| From | What | Files |
| --- | --- | --- |
| **Claude** (claude.ai) | Chats per project + Claude Code sessions listed on claude.ai | Artifacts & uploads |
| **ChatGPT** | Chats per project, archived chats optional - custom GPT chats go to `Recent`. Visual answers become cards, voice chats keep their words | Generated files & uploads |
| **Gemini** | Chats | Pictures as links |
| **Proton Lumo** | Chats & projects - decrypted on your computer | Coming... |
| **Claude Code** (desktop app & CLI) | Sessions from this computer, same groups as the Code sidebar | (Stored locally) |
| **Codex** (ChatGPT desktop app & CLI) | Threads from this computer, per project | (Stored locally) |

## How it looks in your vault

```text
AI Chats/
├── Claude Desktop/
│   ├── Chat/
│   │   ├── Recent/
│   │   │   ├── 2026-11-05 Trip to Lisbon.md
│   │   │   └── 2026-11-05 Trip to Lisbon.json
│   │   └── Thesis/                    ← a claude.ai project
│   │       ├── Artifacts/…            ← files Claude made
│   │       └── Attachments/…          ← files you uploaded
│   └── Code/                          ← Claude Code sessions
├── ChatGPT Desktop/
│   ├── Chat/
│   └── Codex/
├── Gemini/
│   ├── Chat/
│   └── AI Studio/
└── Lumo/
    └── Chat/
```

Each transcript has front matter (handy for Dataview or Bases) and then the chat:

```markdown
---
uuid: c_1a2b3c4d5e6f7a8b
created: 2026-09-03T09:14:54.888Z
updated: 2026-09-03T09:16:06.168Z
raw: "[[2026-09-03 Sourdough starter tips.json]]"
unread: true
---
## You · 2026-09-03 11:14

My sourdough starter smells like nail polish. Is it ruined?

## Gemini (3.6 Flash)

**No, it's just hungry.** That smell means it has used up its food. Feed it…
```

If a chat changes, the new version is saved next to the old one as `… (updated YYYY-MM-DD HHmm)` - nothing gets overwritten.

## Getting started

1. Install and enable the plugin (see [Installation](#installation))
2. Go to **Settings → AI ChatBridge**
3. Pick a tab - **Claude**, **ChatGPT**, **Lumo** or **Gemini** - and select **Log in**. Sign in like you would in your browser, the window closes by itself once you're in
4. Check the folders, or just keep the defaults under `AI Chats/`
5. Select **Sync now**, or **Sync all** on the **Overview** tab

**Max chats per run** starts at 3, so the first sync is just a quick test. Set it to `0` to sync everything.

Want your Claude Code and Codex sessions too? Turn on the **Desktop app** side of the account.

## Commands

| Command | What it does |
| --- | --- |
| **Sync all chats** | All accounts you're logged in to, then the desktop apps that are on |
| **Sync Claude chats** | All claude.ai accounts you're logged in to |
| **Sync ChatGPT chats** | All ChatGPT accounts you're logged in to |
| **Sync Gemini and AI Studio chats** | All Google accounts you're logged in to - Gemini chats, then AI Studio prompts |
| **Sync Lumo chats** | All Proton Lumo accounts you're logged in to |
| **Sync desktop app chats (Claude, Codex)** | Local Claude Code and Codex sessions |
| **Reconcile all ChatGPT chats** | Check all ChatGPT chats again, not just the recent changes |
| **Cancel pending chat sync retry** | Stop a waiting retry after a 429 pause |
| **Move synced chats into the app layout (Claude Desktop, ChatGPT Desktop)** | Moves folders from older versions into `Claude Desktop/…` and `ChatGPT Desktop/…` - links and the sync index follow |
| **Diagnose: save claude.ai answers for the open chat** | Saves the raw answers of the open chat, for bug reports |

## Choosing what to sync

- **Project folders** - one subfolder per project, or everything in one folder
- **Only sync selected projects** - fetch your project list and tick the ones you want (chats without a project are in the list too)
- **Choose a folder per project** - turn it on under **Only sync selected projects** and every ticked project gets a folder field. Type a path or pick an existing folder. Empty means the default, shown greyed in the field: the chat folder, in the project's subfolder if **Project folders** is on. Folders that don't exist yet are created on the next sync. A project with its own folder takes all its chats, Claude Code sessions included
- **Download files and images** - on or off per Claude and ChatGPT account
- **Automatic sync** - every 30 minutes or more. After an error it pauses until you sync by hand, so nothing runs in a loop

## Multiple accounts

On any provider tab select **Add account** and give it a name e.g. `Work`. Each account gets its own login and its own folders e.g. `Claude Desktop (Work)/Chat`.

Two accounts can share one desktop app without anything being saved twice. A session goes:

- to the account whose **Extra session folders** hold it (handy with `CLAUDE_CONFIG_DIR` or `CODEX_HOME`)
- otherwise to the account that made it - matched by Claude organization ID or ChatGPT workspace ID, which each account fills in on its first web sync
- otherwise to the first account. Claude Code sessions run only from the CLI have no login recorded, so they end up here

A session that's already saved stays with the account that saved it.

## Desktop app sessions

Some chats only live on your computer - Claude Code sessions from the Claude desktop app and CLI (`~/.claude/projects`) and Codex threads from the ChatGPT/Codex desktop app and CLI (`~/.codex/sessions`). AI ChatBridge saves those too, one Markdown note per session.

- Titles and folders match the apps' sidebars - Claude Code sessions go in one folder per sidebar group (otherwise per working folder), with forks and side sessions nested under the session they came from. Codex threads go in one folder per project, or `Recent`
- Sessions that are still running wait for a quiet period before they're saved
- Session files somewhere else? Add the folder under **Extra session folders**
- Claude Cowork sessions are kept in the cloud, not on your computer, so they can't be read locally

## Privacy and network use

This plugin needs network access to work. Please read this before using it.

- **Services contacted:** `claude.ai`, `chatgpt.com`, `gemini.google.com`, `aistudio.google.com` (with its API host `alkalimakersuite-pa.clients6.google.com`) and `lumo.proton.me`, plus their login pages e.g. `auth.openai.com`, `accounts.google.com` and `account.proton.me` - only when you log in or sync. Nothing is sent anywhere else. No telemetry
- **What is sent:** the same requests your browser sends to list and read your own chats and files, with your login
- **Accounts:** you need your own account with each provider you sync
- **Login windows:** a normal sign-in page in a window of its own, locked down - pages opened there can't use your camera, microphone, location, notifications or connected devices
- **ChatGPT's visual answers:** turned into plain HTML and pictures in your notes - nothing from a chat is ever run, and drawings can't load anything from other websites
- **Where logins are stored:** in each login window's own storage on this computer, outside the vault, separately per account. Never in `data.json`, notes or logs. **Log out** and **Remove** in the settings clear them
- **Account identifiers:** the name you give an account, and its claude.ai organization ID or ChatGPT workspace ID, are stored in `data.json` - these are not secrets
- **Pasted login fallback (claude.ai, ChatGPT, Gemini and AI Studio):** if the login window doesn't work you can paste a login cookie from your browser instead, under the account's advanced settings - claude.ai's `sessionKey`, ChatGPT's `__Secure-next-auth.session-token` (or the whole Cookie header), or the whole Cookie header of a `gemini.google.com` request for Google. It's kept in Obsidian's secret storage on this computer - never in the vault, `data.json`, notes or logs - and the login window wins if both are set. Google's cookies only go into a separate hidden window kept in memory, which is emptied after each sync. Lumo has no fallback: unlocking its encrypted chats needs keys only its login window holds. The ChatGPT and Google fallbacks are new
- **Gemini and AI Studio:** Google has no API for either, so the plugin opens them in a hidden window with your Google login and reads the same data their own pages load. Requests are signed inside that page the same way the page signs its own - no Google token is saved or logged. Google blocks logins from windows inside apps, so the Google login window says it's Firefox. Gemini and AI Studio support is new
- **Proton Lumo:** Lumo stores chats end-to-end encrypted. To sync them, the plugin opens Lumo in a hidden window with your login and unlocks your keys for that one sync - the keys stay in memory and are never saved or logged. The chats are then saved **readable** in your vault, so anything that can read your vault can read them. With **Only sync selected projects** on, only the names of the selected Lumo projects end up in `data.json`. Lumo support is new
- **What is written:** chat JSON, Markdown transcripts, downloaded files and a sync log - only in the vault folders you choose. The sync index in `data.json` holds chat IDs and paths, no chat content and no secrets
- **Files outside the vault (desktop apps only):** when desktop sessions are on for an account, the plugin *reads* that app's files on this computer - `~/.claude/projects`, the Claude desktop app's session list and Local Storage (for titles and sidebar groups), `~/.codex/.codex-global-state.json`, `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.codex/session_index.jsonl` and any extra folders you add. It never changes them and sends nothing over the network. Turn the app off to stop this
- **Terms of service:** automated access may be limited by the providers' terms. Keep a reasonable delay between requests and use your own judgment

## Requirements

- Obsidian **1.11.4** or newer
- **Desktop only** (Windows, macOS, Linux) - the login windows need Electron, which isn't there on mobile

## Installation

### From Community plugins

Once the plugin is accepted into the directory: **Settings → Community plugins → Browse**, search for **AI ChatBridge**, then **Install** and **Enable**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Sundowna/obsidian-ai-chatbridge/releases/latest)
2. Copy them into `<your vault>/.obsidian/plugins/ai-chatbridge/`
3. Reload Obsidian and enable **AI ChatBridge** in **Settings → Community plugins**

## FAQ

**My first sync is taking forever?**

That's the 429s - with 1,000+ chats the providers start saying "too many requests". The plugin pauses, shows a countdown in the status bar and carries on by itself. Still faster than waiting for a data export :)

**The login window doesn't work for me?**

Use the pasted login fallback. Sign in to the site in your browser and open DevTools (**F12**), then:

- **claude.ai:** **Application → Cookies**, copy the value of `sessionKey`
- **ChatGPT:** **Application → Cookies**, copy the value of `__Secure-next-auth.session-token` - or, if ChatGPT split it into `.0` and `.1`, go to **Network**, select a `chatgpt.com` request and copy its whole `Cookie` header
- **Gemini and AI Studio:** **Network**, select a `gemini.google.com` request and copy its whole `Cookie` header

Paste it under the account's advanced settings in the plugin. Pasted cookies run out sooner than a login - Google's especially - so paste a fresh one when the sync says it expired.

**Can I edit the synced notes?**

Better not - treat them as the originals. Delete one and the next sync puts it back. Write your own notes somewhere else and link to the transcript.

**A sync stopped with "could not be verified"?**

The provider changed how its site answers, so the plugin stopped rather than save something wrong. Please [open an issue](https://github.com/Sundowna/obsidian-ai-chatbridge/issues) with the line from the sync log.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run dev     # watch build to main.js
npm run build   # type check + production build
npm run lint    # eslint with eslint-plugin-obsidianmd
```

For live testing, clone the repo into `<vault>/.obsidian/plugins/ai-chatbridge/` (or copy the build output there) and reload Obsidian.

Tests run offline - `npm run test:gemini`, `test:lumo`, `test:desktop`, `test:inventory` and `test:sync` use made-up samples. `npm run test:offline` also reads chat exports from `samples/`, which is git-ignored because it holds real chats - add your own exports to run it.

## Releasing

1. Update `minAppVersion` in `manifest.json` if needed
2. Add a `## x.y.z - YYYY-MM-DD` section to [CHANGELOG.md](CHANGELOG.md) - it becomes the release notes
3. Run `npm version patch` (or `minor` / `major`). This bumps `package.json`, `manifest.json` and `versions.json`, commits, and creates a tag without a `v` prefix
4. Push the commit and tag: `git push --follow-tags`
5. The **Release Obsidian plugin** workflow builds the plugin and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css`, and this version's changelog as notes. Review it and publish

## Support

Found a bug or have an idea? [Open an issue](https://github.com/Sundowna/obsidian-ai-chatbridge/issues). What changed in each version is in the [changelog](CHANGELOG.md).

## License

[0BSD](LICENSE)
