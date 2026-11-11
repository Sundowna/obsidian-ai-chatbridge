# Changelog

## Unreleased

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
