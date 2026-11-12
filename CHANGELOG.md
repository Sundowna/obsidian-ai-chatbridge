# Changelog

## 0.28.0 - 2026-11-12

### New
- **Refresh the Hermes profile list** - **Refresh** in the Hermes tab's Profiles heading looks for profiles again (`HERMES_HOME`, the Hermes `profiles/` folder) and checks the ones you added by path. It says what changed, e.g. "2 new profiles found, 1 no longer exists". New profiles are added turned off and tagged **New**
- **No longer found** - Hermes profiles whose `state.db` is gone are listed at the bottom, with the reason ("Folder not found" or "No state.db in this folder") and how many sessions they saved. Each keeps its switch: left on, it syncs again as soon as it is back. **Remove** takes it off the list; its notes stay in the vault, and you are asked first if it saved any. Nothing is removed by itself

### Changed
- The Overview's Hermes card counts only profiles that can be found, e.g. "2 of 5 agents on, 1 not found"

### Fixes
- **A missing Hermes profile no longer stops the sync** - a profile that was turned on but whose `state.db` was deleted stopped the whole Hermes sync with "…/state.db does not exist". It is now skipped and the other profiles still sync. A manual sync's message names the profiles it skipped

## 0.27.0 - 2026-11-12

### New
- **Claude Code and Codex files** - local sessions now bring their files along, like the website chats. Images and files you attached go to `Attachments/`, and documents Claude or Codex wrote or sent you (Markdown, HTML, PDF, Office files, images) go to `Artifacts/`, next to the note. Each file is copied in its latest version, or rebuilt from the session if it is gone. Pasted images show up in your message. Source code, `~/.claude` files and temp scratch files are left out unless the assistant sent them to you, and notes already in the vault are linked, not copied. Artifacts and Claude Docs published on claude.ai are listed as links. Sessions synced before get their files on the next sync, and their notes stay as they are. Turn this off with General → **Save session files**
- **Stop all** on the Overview, right next to **Sync all**. It's greyed out until something syncs, then stops it after the current chat. While a sync runs, **Sync all** shows **Syncing…**
- **Hermes on the Overview** - a Hermes Agent section with its logo shows how many agents (profiles) are on, e.g. "1 of 6 agents on", and how many chats they saved, with its own **Sync** button. With no agent on, the button says **Set up** and opens the Hermes tab; **Manage agents** opens it too
- The Hermes tab uses Hermes Agent's own logo

### Changed
- The Overview's summary counts Hermes chats too ("… and 5 Hermes chats saved so far")

### Fixes
- **A sync from before a reload can't undo your changes anymore** - after the plugin was reloaded (e.g. after an update), a sync that was still running in the old copy kept the old settings. Right after **Move into the new layout**, it could download every ChatGPT chat again as "(recovered)" into the old folders and write the old folder paths back. An old copy now never saves, and its sync stops before the next chat
- **Safety stop for many missing chats** - when many saved chats are missing at once (at least 10, and more than a fifth), the claude.ai, ChatGPT and desktop syncs stop before writing anything and ask you to use **Refresh index**, instead of restoring or downloading them all again. One or two deleted notes are still restored as before
- **Move into the new layout** always switches the folder settings to the new folders, even if the move stops halfway
- Codex: the "Files mentioned by the user" block is no longer shown as text in your message; the attached files are linked instead
- Claude Code: a session that starts with an image no longer gets a title like "IMG-…"
- Two Hermes profiles found with the same name (e.g. two "default" homes) got the same vault folder. The second is now named "default (2)", also for profiles found before

## 0.26.0 - 2026-11-12

### New
- **Hermes Agent chats** - a new **Hermes** tab syncs chats from [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research), whichever model you ran - Claude, GPT, a local Qwen… Each Hermes profile gets its own switch and **Sync** button, and its own subfolder under `AI Chats/Hermes/`. Profiles are found by themselves (`HERMES_HOME`, `profiles/`) and start turned off; you can also add one by path. Command: **Sync Hermes Agent chats**, and **Sync all** includes the profiles that are on
- **Read-only, always** - Hermes keeps its chats in a SQLite database (`state.db`). The plugin never writes to it: each sync opens it read-only, copies a consistent snapshot with SQLite's backup function (recent messages still in `state.db-wal` included) to a temporary file, reads that copy and deletes it. It uses Obsidian's built-in SQLite, or a Python on your computer if Obsidian has none
- **Tool steps you can open** - every run of tool calls becomes a collapsed callout listing each step: the tool, its arguments and a shortened result
- Each transcript has `source: hermes`, `hermes_profile`, `model`, `session_id` and dates as `YYYY-MM-DD` in its properties. Only new or changed sessions are saved; a changed one gets an `(updated …)` copy like every other chat. Helper (subagent) sessions, sessions still running, and anything run in or mentioning a folder named `Private` are left out

### Changed
- README reorganised: quick start first, one table of sources, clearer privacy section

## 0.25.0 - 2026-11-11

### New
- **Stop a running sync** - while a sync runs, the ribbon icon becomes a stop button, the progress notice has **Stop**, the status bar text stops it when selected, and the **Sync** buttons in the settings turn into **Stop** for the account that is syncing (greyed out for the others). There is also a **Stop the running sync** command. The sync ends after the current chat: everything saved so far stays, and the next sync carries on from there
- **Refresh index** - General → **Refresh index** (and a command) finds synced notes you moved outside Obsidian, e.g. in the file manager or while the plugin was off, by the chat ID in their properties, and their raw files by link or by a unique name. The next sync then doesn't save them a second time. Shows how many were found and how many are nowhere
- **New folder layout** - one folder per provider, split by where the chats live: `Claude/Chat/<project>`, `Claude/Code-Cloud`, `Claude/Code-Local/<computer>/<repo>`, `ChatGPT/Chat/<project>`, `ChatGPT/Codex-Local/<computer>`. New vaults start with it, and the raw files folder mirrors it (`80 Archive/raw/…`)
- **Accounts share folders** - a new account saves into the same folders as the first one, and every transcript gets `account: "<name>"` in its properties so Dataview or Bases can tell them apart
- **Move into the new layout** - General → **Folder layout** lists every folder that would move, from where to where, and asks before moving. Second accounts' folders merge into the shared ones, the raw files follow, emptied old folders are cleaned up, and folders you picked yourself stay where they are. Nothing is overwritten: a file whose name is already taken stays put and is listed

### Changed
- Every sync saves the newest chats first, desktop sessions and repaired chats included, so a limited or stopped run always has your latest chats
- The Overview's **Sync** on an account card runs website, desktop app and AI Studio as one sync, so **Stop** ends all of it, and it tells you when the account has nothing it can sync
- Fewer duplicate "starting…" notices

## 0.24.1 - 2026-11-11

### Changed
- Clearer folder names in the settings: Claude's **Code folder** is now **Code Cloud folder** (Claude Code sessions listed on claude.ai), and the desktop app folders are **Code Local folder** (Claude) and **Codex Local folder** (ChatGPT). Only the labels changed; your folders stay as they are

## 0.24.0 - 2026-11-11

### New
- **One raw files folder for everything, on by default** - General → **Raw files folder** (default `80 Archive/raw`, with an on/off switch). Every raw .json (and kept .jsonl) goes there at the same path as its transcript, e.g. `80 Archive/raw/30 Sources/AI Chats/Claude/Chat/Recent/…`, so the transcript folders hold only Markdown. While it is on, the JSON folder fields in the accounts and projects are hidden and not used; switch it off to choose them per account as before. Files saved before can be moved there in one click, with Obsidian's own move
- **JSON folders** - every folder setting now has a **JSON folder** right under it, so the raw .json files can live apart from the Markdown transcripts. Works for claude.ai (chat and code folders), ChatGPT (older parts of long chats included), Lumo, Gemini, AI Studio and the desktop apps (the raw session folder, with **Keep the raw session file** on). Leave it empty and nothing changes: the files stay next to the transcripts, as before. Project and app subfolders are mirrored inside the JSON folder, and the transcript's `raw:` link uses the full path, so it never points at the wrong file
- **Per project, too** - with **Choose a folder per project** on, each ticked project gets a second line for its own JSON folder. Its greyed default shows where the files go otherwise
- **Tidy up in one click** - after you change a JSON folder, the settings show how many saved files are still in the old place and offer to move them. Obsidian's own move is used, so links and the sync history follow; transcripts and downloaded files stay where they are
- **Sync all on startup** - a new toggle under General → Sync runs "Sync all" once, 10 seconds after the vault opens. Off by default; only accounts you are logged in to, and as quiet as the automatic sync

## 0.23.0 - 2026-11-10

### New
- **Target folder per project** - with **Only sync selected projects** on, turn on **Choose a folder per project** and give any ticked project its own folder in the vault. Empty fields keep the default (shown greyed in the field), suggestions list your existing folders, a bad path is flagged right away, and a folder that doesn't exist yet is created on the next sync. Works for Claude, ChatGPT and Lumo. Already saved chats stay where they are - move them in Obsidian and the plugin keeps track

### Security
- Login windows and the hidden windows used for syncing now refuse camera, microphone, location, notifications and device access. Electron allowed all of these by default
- Drawings in ChatGPT's visual answers can only link inside themselves - nothing loads from other websites when you open a note

### Fixes and housekeeping
- Clearer wording in a few settings
- Development tools updated (no change to what the plugin ships)

## 0.22.0 - 2026-11-10

- ChatGPT's visual answers are drawn as cards in the note - bordered boxes, grids, badges, source chips, chart bars and drawings, in your theme's colours. Icons use Obsidian's own

## 0.21.0 - 2026-11-10

- ChatGPT's visual answers keep their structure in the transcript instead of a flat copy, and source chips become named links instead of "Unresolved source"

## 0.20.1 - 2026-11-10

- ChatGPT voice chats show what was said (yours and ChatGPT's) instead of "see raw JSON". Saved notes get the readable version on the next sync

## 0.20.0 - 2026-11-10

- Gemini and Google AI Studio sync
- Pasted login fallback for ChatGPT, Gemini and AI Studio

## 0.19.0 - 2026-11-09

- Proton Lumo sync - decrypted on your computer
- Project picker with checkboxes for **Only sync selected projects**

## 0.18.1 - 2026-11-09

- Hashing and decoding with web APIs instead of Node modules

## 0.18.0 - 2026-11-09

- Multiple accounts per provider
- Tabbed settings page
