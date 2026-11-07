<p align="left"><img src="chatBridgeLogo.png" width="120" alt="Project logo"></p>  # AI ChatBridge

Sync your **claude.ai** and **ChatGPT** chats into your Obsidian vault.
The idea is to mirror the chats and folders from your AI web & desktop interfaces to your Obsidian vault.
This way it looks and feels the same way as the GUIs that you are used - minimum barrier-to-entry and context switching.
Each chat is saved as the raw JSON the website returns, plus a readable Markdown transcript, so your AI conversations live next to the rest of your notes.

> **Unofficial.** This plugin is not affiliated with, endorsed by, or supported by Anthropic or OpenAI. It reads the same web endpoints your browser uses, which can change without notice.

## Features

- Log in to claude.ai and ChatGPT in a window inside Obsidian, the same way you do in a browser.
- Copy chats into the vault as raw JSON plus a Markdown transcript with a link back to the original chat.
- Optionally download files the AI created (to `Artifacts/`) and files you uploaded (to `Attachments/`) next to each chat.
- Mirror your claude.ai / ChatGPT projects as subfolders, or sync only the projects you list.
- Keep Claude Code sessions listed on claude.ai in a separate folder.
- **Desktop apps:** also save the chats that exist only on this computer: Claude Code sessions from the Claude desktop app and CLI (`~/.claude/projects`), and Codex threads from the ChatGPT/Codex desktop app and CLI (`~/.codex/sessions`). Titles and folders match the apps' sidebars: Claude Code sessions go into one folder per sidebar group (otherwise per working folder), with forks and side sessions nested under the session they came from. Codex threads go into one folder per project, or `Recent`. Sessions still being written wait for a quiet period. Cowork sessions are kept in the cloud, not on this computer, so they cannot be read locally. If you have session `.jsonl` files elsewhere, add their folders under **Extra session folders**.
- Only new or changed chats are written again; moving or renaming synced notes inside Obsidian is tracked.
- Optional automatic sync (every 30 minutes or more), which pauses itself after an error.
- Read-only: the plugin never creates, changes or deletes anything on claude.ai or ChatGPT.

## Commands

| Command | What it does |
| --- | --- |
| **Sync Claude chats** | Sync claude.ai only |
| **Sync ChatGPT chats** | Sync ChatGPT only |
| **Sync desktop app chats (Claude, Codex)** | Save local Claude Code and Codex sessions |
| **Move synced chats into the app layout (Claude Desktop, ChatGPT Desktop)** | Move existing synced folders to `Claude Desktop/Chat`, `Claude Desktop/Code`, `ChatGPT Desktop/Chat` and `ChatGPT Desktop/Codex`. Links and the sync index follow |
| **Sync all chats** | Sync every provider you are logged in to, then the desktop apps that are on |
| **Diagnose: save claude.ai answers for the open chat** | Save the raw API answers for the open chat, for bug reports |

## Getting started

1. Install and enable the plugin (see below).
2. Open **Settings → AI ChatBridge**.
3. Under **Accounts**, select **Log in** for claude.ai and/or ChatGPT and sign in in the window that opens. It closes itself once you are logged in.
4. Choose the folders (defaults: `AI Chats/Claude`, `AI Chats/Claude Code`, `AI Chats/ChatGPT`).
5. Select **Sync** or **Sync all**.

**Max chats per run** starts at 3 so a first test is quick. Set it to `0` to sync everything.

## Privacy and network use

This plugin needs network access to work. Please read this before using it.

- **Services contacted:** `claude.ai` and `chatgpt.com` (and their login pages, for example `auth.openai.com`), only when you log in or run a sync. Nothing is sent anywhere else. There is no telemetry.
- **What is sent:** the requests your browser would send to list and read your own chats and files, with your login cookies.
- **Accounts:** you need your own claude.ai and/or ChatGPT account.
- **Where logins are stored:** in the login window's own Electron storage on this computer, outside the vault. Logins are never written to `data.json`, to notes or to logs. **Log out** in the settings removes them.
- **Session key fallback (claude.ai):** if the login window does not work, you can paste your `sessionKey` cookie. It is kept in Obsidian's secret storage on this computer, not in the vault.
- **What is written:** chat JSON, Markdown transcripts, downloaded files and a sync log, only inside the vault folders you choose. The sync index in `data.json` holds chat IDs and paths, no content and no secrets.
- **Files outside the vault (desktop apps only):** when a desktop app is turned on in the **Desktop apps** tab, the plugin *reads* that app's session files on this computer (`~/.claude/projects`, the Claude desktop app's session list and Local Storage for titles and sidebar groups, `~/.codex/.codex-global-state.json` for Codex projects, `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.codex/session_index.jsonl`, and any extra folders you add). It never changes or deletes them, and sends nothing over the network. Turn an app off to stop this.
- **Terms of service:** automated access may be limited by the providers' terms. Use a reasonable delay between requests and your own judgment.

## Requirements

- Obsidian **1.11.4** or newer.
- **Desktop only** (Windows, macOS, Linux). The login windows rely on Electron, which is not available on mobile. The **Browse…** folder picker uses the system folder dialog.

## Installation

### From Community plugins

Once the plugin is accepted into the directory: **Settings → Community plugins → Browse**, search for **AI ChatBridge**, then select **Install** and **Enable**.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Sundowna/obsidian-ai-chatbridge/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/ai-chatbridge/`.
3. Reload Obsidian and enable **AI ChatBridge** in **Settings → Community plugins**.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run dev     # watch build to main.js
npm run build   # type check + production build
npm run lint    # eslint with eslint-plugin-obsidianmd
```

For live testing, clone the repo into `<vault>/.obsidian/plugins/ai-chatbridge/` (or copy the build output there) and reload Obsidian.

`npm run test:offline` runs parser tests against chat exports in `samples/`. That folder is git-ignored because it holds real chats; add your own exports to run it.

## Releasing

1. Update `minAppVersion` in `manifest.json` if needed.
2. Run `npm version patch` (or `minor` / `major`). This bumps `package.json`, `manifest.json` and `versions.json`, commits, and creates a tag without a `v` prefix.
3. Push the commit and tag: `git push --follow-tags`.
4. The **Release Obsidian plugin** workflow builds the plugin and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css`. Review it and publish.

## Support

Found a bug or have an idea? [Open an issue](https://github.com/Sundowna/obsidian-ai-chatbridge/issues).

## License

[0BSD](LICENSE)
