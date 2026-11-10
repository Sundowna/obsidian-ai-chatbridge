# Changelog

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
