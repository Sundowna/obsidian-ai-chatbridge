# Plan: any computer can sync

Written 19.11.2026. Not started. Nothing in the code has changed yet.

Before building, read [FEATURES.md](../../FEATURES.md) and follow its rule. The settings screen and the sync flow change, so no listed behaviour may be dropped. Update FEATURES.md with the new ones.

## The goal

Walter wants the Brain vault on several laptops, kept in step through Proton Drive. Tower is often switched off and he will be on a laptop somewhere else. So **whichever computer he is on must be able to sync everything itself**, including the online accounts (claude.ai, ChatGPT, Lumo, Gemini, AI Studio).

Proton Drive copies the whole vault, including `.obsidian/plugins/ai-chatbridge/`. It has no ignore list. So ChatBridge must never have two computers writing the same file.

## What Walter decided

- **No hub.** "One computer syncs, the others ask it" is out, because Tower will be off.
- The open-notes layout (`workspace.json`) may sync between laptops. That is fine.
- The phone part (the `mobile-sync` branch) stays parked. This plan does not need it.

## How it works

### 1. Settings and sync history are split up

Today `data.json` holds everything: settings, the lists of what was synced, and paths that only exist on Tower (Hermes folders on `D:\AI\Hermes`, Claude Code folders under `C:\Users\Walter\.claude`, 1,305 local chat files in the Claude Code index).

After the change:

| File | What is in it | Who writes it |
|---|---|---|
| `data.json` | Shared settings: accounts, folder names, how notes look, which projects | Any computer, but only when Walter changes a setting |
| `computers/<name>.json` | This computer's folder paths (Claude Code extra folders, Hermes profiles) and its lists of what it has synced: every `index`, `fileIndex`, `cloudIndex`, plus cooldowns, resume points, inventories and progress | Only that computer |
| `sync-busy.json` | The busy marker (see 2) | The computer that is syncing |

`<name>` is the computer's name (see 4).

### 2. The busy marker

- When a computer starts a sync, it writes `sync-busy.json`: computer name, start time, and a "still alive" time that it updates every minute.
- If another computer sees a marker that is still alive, it does not start. It shows "Laptop 1 is syncing (since 10:02). Try again later" and offers "Sync anyway".
- A marker with no update for 30 minutes counts as abandoned, for example when a lid was closed mid-sync. The next computer may take over.
- The marker is removed when the sync ends.
- Proton may deliver the marker a few minutes late. So the marker is a safety net, not a guarantee. Parts 3 and 5 make a rare overlap harmless.

### 3. Each computer keeps its own list, and reads the others'

- Before a sync, ChatBridge reads every `computers/*.json` and combines the lists. For each chat it takes the newest entry.
- A chat that Tower fetched yesterday is not fetched again on the laptop, unless it changed since.
- When the sync ends, the computer writes **only its own file**.
- Combining never deletes. A chat missing from one list but present in another counts as synced.

### 4. The computer's name stays the same

- The name comes from the computer's network name, as today (`computerName()` in `src/computer.ts`). It is stored once in Obsidian's local storage for this vault, which never travels, so it doesn't change when the network does.
- In settings Walter can rename it, for example when two laptops report the same name. Renaming also renames `computers/<old>.json`, and asks before moving the `Code-Local/<old>` folder.

### 5. The same chat always gives the same note

- Check that writing a note is fully repeatable: the same chat produces exactly the same text and the same file name on every computer. That means no "synced at" time inside the note body, and no order that depends on the computer.
- If anything differs, fix it, so that two computers fetching the same chat write identical files and Proton has nothing to clash over.

### 6. Local chats stay on their own computer

- Claude Code, Codex and Hermes sessions are files on one computer. Each computer syncs its own, into its own folder (`Code-Local/<name>/…`, as today), and lists them only in its own file.
- If a computer has none of these, for example no Hermes, it simply shows nothing for them. No error, no red warning.

## Moving the current settings over

- On first start after the update, ChatBridge makes a backup (`data.before-computers.json`, like the earlier `data.before-*.json` backups). It then moves Tower's paths and lists out of `data.json` into `computers/Tower.json`.
- It does this only on the computer whose paths they are. It checks that at least one listed Claude Code or Hermes folder exists here. On any other computer it leaves them alone and starts an empty file for that computer.
- Older versions of ChatBridge on another computer must not undo this. A version marker in `data.json` makes an old build stop syncing and say "Update ChatBridge on this computer first".

## Settings screen

- At the top: "This computer: Laptop 1" with a Rename button.
- Per account: "Last synced by Tower, 2 hours ago".
- When another computer is busy: the message from part 2.
- Each laptop signs in to each online account once. Logins live in that computer's Obsidian, not in the vault. The settings should say so plainly when an account has no login on this computer: "Sign in on this computer to sync this account".

## Tests

- Unit tests:
  - combining two computers' lists (newest wins, nothing lost)
  - an abandoned busy marker
  - the move from the old `data.json` (Tower and non-Tower cases)
  - renaming a computer
  - writing a note twice gives identical text
- A two-computer test in the TAlpha test vault, with two separate Obsidian profiles pointing at one copied folder: start a sync on both, check the marker, check the lists combine. Only with Walter present, and only pressing Sync when he says so.
- Then the real Proton test: a throwaway vault copy in Proton "My files" on Tower and one laptop.

## Open questions

- **Pasted cookies.** Pasted cookies live in Obsidian's secret storage (`app.secretStorage`). Check whether that stays on each computer or travels with the vault. If it travels, a cookie pasted on Tower would work on a laptop, which is fine but should be known.
- **Hermes note folder.** Hermes notes go to one shared folder (`AI Chats/Hermes`), not one per computer. Check that two computers with Hermes can never write the same note file. Session IDs should keep them apart.
- **Proton's conflict behaviour** is undocumented. The real Proton test above answers it.
- **Order with the `mobile-sync` branch** (21 commits, not merged). Decide whether to finish and merge it first, or build this on `main` and leave it parked. It may have a helper worth reusing for storing the computer's name.

## Not part of this plan

- Moving the Brain vault into Proton Drive, and moving its Git folder out of the vault. That is a separate step, done once this works.
- Removing the Config Sync plugin. That becomes possible once the whole vault syncs.
