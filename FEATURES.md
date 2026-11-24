# Feature inventory (regression checklist)

For coding agents. Read this before rebuilding, redesigning or replacing any existing UI or module.

## Rule

1. Before the change: mark which items below the change touches. Re-read their code; this list can lag.
2. After the change: verify each touched item in a running Obsidian (TAlpha test vault), not only in code. Check stateful controls in every state, in light and dark theme.
3. Fix anything missing before reporting the work as done.
4. If an item cannot or should not be kept, never drop it silently. Report one line each:
   `Dropped/changed: <what> | why: <reason> | impact: <what the user loses>`
   Ask before dropping anything the user interacts with directly.
5. New or changed feature: update this file in the same change.

Source of each section: **[code]** = read from `src/` at 0.30.0; **[readme]** = taken from README.md, covered by `npm run test:*`, not re-read line by line.

## 1. Entry points [code: main.ts]

Command IDs are stable API. Never rename.

- [ ] `sync-all-chats` Sync all chats
- [ ] `sync-claude-chats` "Sync Claude (claude.ai and Claude Code)": every claude.ai account, then Claude Code for every account that has it on; `sync-chatgpt-chats` "Sync ChatGPT (chats and Codex)": every ChatGPT account, then Codex likewise; a part that fails does not stop the next; `sync-lumo-chats`, `sync-gemini-chats` (Gemini, then AI Studio if on)
- [ ] `sync-desktop-app-chats`, `sync-hermes-chats`
- [ ] `sync-ai-memory` Sync AI memory (not part of Sync all)
- [ ] `reconcile-chatgpt-chats` (full check, not only recent changes)
- [ ] `cancel-chatgpt-retry`: only offered while a retry waits and nothing runs
- [ ] `stop-sync`: only offered while a sync runs and no stop was asked yet; the only way to stop a running merge (section 6b)
- [ ] `refresh-index`, `move-to-app-layout`, `diagnose-chat-downloads`
- [ ] `merge-chat-copies`: opens the preview; refused with a notice while a sync runs, while a merge waits or while a merge runs
- [ ] `test-mobile-connection` Test mobile connection: one GET to `claude.ai/api/organizations` and one to `chatgpt.com/api/auth/session` per account, with the pasted login only (secret storage; never the login window). Report dialog with **Copy**: status, content type, Cloudflare check page yes/no, login accepted/refused; "not tested" when nothing is pasted. Writes nothing to the vault or `data.json`; the report (also sent to the console) holds no secret and no answer text
- [ ] `sync-or-ask` Sync: here, or ask the computer (same as the ribbon icon; see section 10). On mobile `sync-all-chats` does the same
- [ ] Ribbon icon: on a device that asks, "Ask the computer to sync" and a click writes a request (section 10). On a device that syncs: `refresh-cw` "Sync all chats" when idle; `square` "Stop sync" / "Stopping the sync…" plus class `is-syncing` while running; click toggles sync or stop; while a merge runs the label is "Merging chat copies…" and a click only shows how to stop it (section 6b)
- [ ] Status bar item: click stops a running sync (not a merge: it shows how to stop it); `ccs-status-stoppable` (hover style) and aria-label only while stoppable; "merging chat copies, N of M" while a merge runs

## 2. Sync engine, all providers [code: main.ts, sync.ts]

- [ ] One sync at a time; a second manual start shows "A sync is already running." (or the project-list variant)
- [ ] Project-list fetch blocks syncs and cannot be stopped (`exclusive`)
- [ ] Stop ends between two chats; everything saved stays; later accounts in the run are skipped
- [ ] Order of Sync all: Claude, ChatGPT, Lumo, Gemini (+ AI Studio), desktop apps, Hermes
- [ ] Sync all runs every part even when one fails (error or exception): the failure gets its notice and last-run entry, then the next part runs; only Stop ends the run early
- [ ] Sync all runs only accounts that are logged in or have a pasted session; nothing to run gives a notice (manual only)
- [ ] Provider-wide sync with one account always runs it, so "not logged in" is shown
- [ ] Automatic sync: off at 0, minimum 30 min; a source that stopped with an error is left out of the automatic sync until it syncs without an error again (by hand or otherwise); all other sources keep syncing
- [ ] Sync on startup: once, 10 s after layout ready, quiet like the automatic sync
- [ ] Automatic and resume runs skip ChatGPT accounts in cooldown; other accounts still run
- [ ] ChatGPT 429: cooldown per account, automatic retry, countdown in status bar, survives restart (cooldown adopted on load)
- [ ] Max chats per run (default 3, 0 = no limit), newest first; rest counted as "left for next run"
- [ ] Delay between requests (default 1.5 s, minimum 1 s)
- [ ] Only new or changed chats are fetched
- [ ] One note per chat, every provider (versions.ts): a changed chat rewrites its note in place, same name and place (also after a rename or move); never a second note, never an `(updated …)`, `(recovered)` or `(transcript …)` name
- [ ] Before the raw file is written over, the earlier one is copied to `<name> (version <stamp>)<ext>` beside it (stamp = that version's own update time; ChatGPT's `(older N)` parts with it). Same content again, or a run stopped half way, makes no second copy
- [ ] Note properties: `earlier_versions: N` and `earlier_raw:` links, only when N > 0, written before `unread`
- [ ] Index per chat: `versions` (earlier raw files) and `noteHash` (fingerprint of the note text below the properties)
- [ ] Properties you added are carried over on every rewrite; plugin properties take the new value; `unread` keeps your value when the chat itself did not change (restore, re-render)
- [ ] Edited note (text differs from `noteHash`): setting **When an edited note gets an update**: `copy` (default, saves `<name> (my edits <stamp>).md` first), `keep` (note untouched, raw files still updated), `overwrite`. Named in the sync log
- [ ] Notes from before fingerprints: edited only if the file changed after its sync AND the new transcript no longer holds every old turn
- [ ] Desktop: the raw `.jsonl` is rewritten in place; an earlier copy is kept as a version only when the new file does not start with it; none with Keep raw off. A changed raw folder setting does not move a session's raw copy (the move row does)
- [ ] Hermes: raw `.json` per session (rows from `state.db`) under the raw files folder, linked as `raw:`; a session saved before that keeps its old note text as JSON for its first earlier version
- [ ] ChatGPT: a note rendered differently now (new files, newer plugin) is rewritten in place, counted as "refreshed transcripts"
- [ ] Quick check of unchanged chats (Claude file check, ChatGPT file check and redraw; quick-check.ts): after a full check that left nothing to do, a chat's raw files are not read again while their size and modified time, its note and versions, its saved files and the plugin build (version + `main.js` time) stay the same. A deleted file or note, a raw file changed on disk, a stale note or a new build brings the full check back; a vault that cannot tell file times always does the full check. Results the same as without it. Covered by `npm run test:sync` and `npm run test:claude`
- [ ] Index saved after every chat (into this computer's file, section 11), so a stop loses nothing
- [ ] Restore: deleted `.md` rewritten from saved `.json` under its own name and place, with its version info; deleted `.json` fetched again under the same name; both gone = saved like new (Claude) or again under the same names (ChatGPT, Gemini, AI Studio, Lumo)
- [ ] Missing-guard: many saved chats missing stops the sync before anything is written
- [ ] Unexpected data shape stops the sync ("could not be verified" class of errors), nothing more is written
- [ ] Error messages are redacted (no session key)
- [ ] Sync log line per run appended to the log note (`AI Chats/AI ChatBridge log.md` by default), with daily-note link, counts, written notes (first 20), stop reason
- [ ] Renames and moves inside Obsidian update the index (debounced save, 1 s)
- [ ] Refresh index finds notes moved outside Obsidian by chat ID; earlier-version files by their unique name
- [ ] Earlier-version files follow renames, folder moves and the raw-file move row (Hermes raw files and Claude Code cloud raw files too)
- [ ] On unload: pending index saved, running sync stopped, login windows closed, no saves afterwards
- [ ] Settings migration from before multiple accounts keeps `data.before-accounts.json` once

## 3. Feedback to the user [code: main.ts, progress.ts, last-run.ts]

- [ ] Manual sync: sticky notice with text, progress bar (indeterminate until counts are known) and a Stop button; Stop turns to disabled "Stopping…"
- [ ] Status bar while syncing: label, short step, percentage; ChatGPT shows "N of M chats saved"
- [ ] Status bar idle: "next sync HH:MM" while automatic sync is on, plus " · waiting for you: <sources>" for sources paused after an error; "syncing in 10 s" before a startup sync; "retry in MM:SS" during a ChatGPT cooldown
- [ ] Result notice after manual runs, and after automatic runs that saved or restored something: new, changed, unchanged, restored, left for next run, still active, Hermes profiles not found
- [ ] Stopped, waiting (cooldown) and failed runs each have their own notice text
- [ ] Last run stored per account surface in this computer's file (section 11; counts and reason only, never chat text; note cut at 300 chars); a run another computer did shows its name ("today 10:02 on Tower")
- [ ] Last-sync line: `history` icon, coloured dot, text, tooltip. Tone: `is-ok` green, `is-warn` orange (stopped, waiting, nothing selected, Hermes not found), `is-bad` red plus red text. "not synced yet" without a run. Automatic runs marked "(automatic)"
- [ ] Overview hero: one line for the last Sync all, naming accounts with problems

## 4. Settings UI [code: src/ui]

Every selected or active state needs a visible signal in light and dark theme.

**Shell**
- [ ] Tabs: Overview, Claude, ChatGPT, Lumo, Gemini, Hermes, Memory, General; each with icon; active tab has `is-active` and `aria-selected="true"`; hover style
- [ ] Current tab, selected account per provider, selected surface and open Advanced sections survive a redraw; scroll position kept on redraw, reset to top on tab change
- [ ] Closing settings forgets in-memory project lists (Lumo)

**Overview**
- [ ] Hero on a device that asks: **Stop all** hidden, the main button reads **Ask the computer to sync**; below the totals the remote status line (section 10), hidden while there is none
- [ ] Hero: totals (chats, desktop sessions, Hermes chats), **Stop all** (disabled when idle, `mod-warning` while running, "Stopping…"), **Sync all** (`mod-cta`, disabled and "Syncing…" while busy), tooltips for both
- [ ] Per provider: head with icon, name, **Add account**; one card per account
- [ ] Account card: title button opens that account; surface lines (Web or Gemini, AI Studio, Desktop) with dot `is-on`, count or "Off" / "Not logged in" / "Checking…"; last-sync line where a failed run wins over a newer good one; **Sync** runs web, desktop and AI Studio as one stoppable run
- [ ] Hermes card: agents on of found, not-found count, chats saved, last sync; **Sync**, or **Set up** when none is on; **Manage agents**

**Sync buttons everywhere (`bindSyncButton`)**
- [ ] Idle label; "Stop" with `mod-warning` while its own sync runs; "Stopping…" disabled after stop; disabled with tooltip "Another sync is running" while another runs; `mod-cta` restored afterwards

**Provider tabs**
- [ ] Account pills with login dot, active pill `is-active` + `aria-selected`; **Add account**
- [ ] Account header: **Rename** (name check, folders unchanged), **Remove** only with 2+ accounts (confirm, logs out, forgets history, notes stay)
- [ ] Surface switch: Web | Desktop app (Claude, ChatGPT); Chat | AI Studio (Gemini); none for Lumo; active segment `is-active` + `aria-selected`
- [ ] Login row: "Checking…" then state; buttons depend on state: logged in = **Log out** + **Sync now** (cta); not logged in = **Log in** (cta), plus **Sync now** if a pasted session exists; last-sync line; saved count; extra notes (same organization warning, cooldown time, shared Google login)
- [ ] Folder fields: text with folder suggestions, **Browse…** (system dialog), empty and hidden folders ignored
- [ ] JSON folder fields: hidden while the General raw files folder is on; saved on blur or Enter; `is-invalid` + error text for bad paths, last good value kept; reset button shown only when not default; "New folder: created on the next sync."
- [ ] "N JSON files in the old place" row appears only when files are misplaced; confirm with example; "Moving…"; blocked during a sync
- [ ] Use project subfolders; folder name for chats without a project (plain name only)
- [ ] Download files and images (Claude, ChatGPT)
- [ ] Only sync selected projects, then Choose a folder per project (sub-setting)
- [ ] Project picker: Fetch projects / Refresh list / Fetching… (cta only before first fetch), status with indeterminate bar, error text, "N of M selected · K with own folder", "Fetched … ago", filter box from 9 rows, Select all/Clear become Select shown/Clear shown while filtering, tags **New** and **Not found**, chat counts, warnings (nothing selected, catalog note), per-row transcript and JSON folder lines with greyed default, reset, invalid state; only the picker redraws on a tick
- [ ] Lumo: project list fetched once per settings opening, full list in memory only, only selected names saved
- [ ] Claude: Include archived chats toggle (off by default); Claude Code cloud sessions toggle; Advanced: Session key (secret storage), Organization ID (UUID check)
- [ ] ChatGPT: Codex Cloud folder and Codex Cloud JSON folder (folder fields like the others); Codex cloud tasks toggle (off by default); Keep Codex's steps toggle (off by default); Include pinned chats (on by default); Include archived chats; Advanced: Session cookie, Incremental sync overlap (1 to 1440), Workspace ID, Reset file delays
- [ ] Gemini: "What is saved" note; Advanced: Google cookies. AI Studio: Sync AI Studio toggle, own folder
- [ ] Lumo: Encryption note
- [ ] Desktop app panel: Sync desktop sessions toggle (rest hidden while off), **Sync now**, Code Local / Codex Local folder, Raw session folder (only with Keep the raw session file), Reads from (roots and account matching text), Advanced: Extra session folders

**Hermes tab**
- [ ] Desktop-only message without Node
- [ ] Head with saved count, last sync, **Sync now** (only with a profile on); Hermes folder
- [ ] Profiles found on first visit, added turned off; **Add by path** (rejects empty, `Private`, duplicates; strips `state.db`); **Refresh** with spinner, "Refreshing…", result text and time, **New** tags
- [ ] Per profile: toggle, **Sync** when on, remove icon only with nothing saved
- [ ] "No longer found" group: reason, toggle with tooltip, **Remove** (confirm when it has saved sessions; notes stay)
- [ ] Advanced: Python path, "How it reads" note

**Memory tab** [code: ui/memory-tab.ts]
- [ ] Desktop-only message without Node
- [ ] Head with description, last-sync line and **Sync now** (both only with a source on; `bindSyncButton`)
- [ ] Memory folder (folder field with suggestions and **Browse…**)
- [ ] "On the web" heading; one row per Claude account ("Claude", or "Claude (label)" with several): what is read, last snapshot time and file count, toggle (off by default; redraws the tab)
- [ ] One row per ChatGPT account ("ChatGPT", or "ChatGPT (label)" with several): what is read, the summary note, last snapshot time, toggle (off by default; redraws the tab)
- [ ] "On this computer" heading naming the account (computer name); one row each for Codex and Claude Code: the folder it reads, last snapshot time and file count, toggle (off by default; redraws the tab)
- [ ] Automatic memory sync (minutes): 0 off, minimum 30, bad input ignored; own timer, restarted on change
- [ ] "Privacy" heading with the **Privacy filter** toggle (on by default)
- [ ] "What is saved" note

**General tab**
- [ ] **Computers** (before Sync from another device): **This computer** with its name in bold and what the files are for; **Other computers**: "Looking…", then one line per other computer file ("Laptop: last synced today 10:02", newest first, clash copies counted once) or "None yet…"
- [ ] **Sync from another device**: **This device** dropdown Syncs (writer) / Asks another device (requester), disabled on mobile, description changes with the role, remote status line, **Ask now** (cta) only when asking; **Name of this device** (saved on leaving the field, empty = default); **Folder for sync requests** (folder field; hidden, empty and `..` paths ignored); **Ignore requests older than (hours)** only when syncing (1 to 168, bad input ignored)
- [ ] Max chats per run, Delay, Sync all on startup, Automatic sync (each validated; bad input ignored)
- [ ] Raw files folder with on/off switch, default `80 Archive/raw`, description changes with state; move row for all raw files
- [ ] Desktop sessions: Mirror the apps' sidebar, Wait until quiet (0 to 1440, default 15), Keep the raw session file, Include helper sessions (re-checks skipped ones), Save session files
- [ ] Notes: **When an edited note gets an update** dropdown (Keep my version as a copy / Don't update that note / Overwrite)
- [ ] Refresh index button with "Refreshing…" and the last result
- [ ] **Merge chat copies into one note**: **Preview…** button, always shown
- [ ] Move into the new layout: shown only when something would move; lists from → to; confirm

**Dialogs**
- [ ] Name dialog: Enter submits, inline error, focus and select on open. Confirm dialog: warning (red) or cta tone, Cancel
- [ ] Merge preview (merge-modal.ts): reads only. One switch per kind with its count (`(updated …)` on; transcript-only and recovered-only off); total line; one collapsible line per chat (first 300) with folder, text source, notes to trash, versions kept, saved files, links per note, warnings; **Save preview as a note**, **Cancel**, **Merge N chats** (warning, disabled at 0). Closing it any way changes nothing

## 5. Logins [code: login.ts]

- [ ] Own window per account; closes itself on login; 15 min limit; reopening focuses the open one; account name in the title with 2+ accounts
- [ ] Partition names are fixed (`persist:claude-chat-sync-*`, `persist:ai-chatbridge-*`); first account keeps the base name. Renaming logs everyone out
- [ ] Login windows: sandboxed, all permissions refused except sanitized clipboard write, cross-site jumps and popups stay inside the window
- [ ] Google login presents as Firefox, client hints removed
- [ ] Hidden windows for Lumo, Gemini, AI Studio; pasted Google cookies go to an in-memory session cleared after use
- [ ] Split cookies (`name.0`, `name.1`) count as logged in
- [ ] ChatGPT: each sync reads the chatgpt.com page through the login window's own storage, so the renewed login cookie is kept there (a pasted session still goes through `requestUrl`)
- [ ] `loginFetch` never passes an AbortSignal to Electron (it cannot cross to the main process); it times out on its own
- [ ] No secrets in `data.json`, notes or logs; pasted sessions live in Obsidian secret storage; login window wins over a pasted session

## 6. Claude web [code: sync.ts]

- [ ] Chats to Chat folder, other platforms to Code Cloud folder; project subfolders; `Recent` for no project; per-project custom folders
- [ ] Include archived chats (`includeArchived`, off by default): also reads the list with `archived=true` after the normal one (`archived=false`), merged and deduplicated by chat ID; archived chats are filed like the others (project or `Recent`), no folder of their own; the project picker reads both lists too. Off = the archived list is never requested
- [ ] Raw `.json` saved byte for byte; transcript with `account:` property and raw link
- [ ] Files: `Artifacts/` and `Attachments/` per chat; chat-view files read too; size mismatch and 404 skipped and remembered; identical file under another ID not copied; all files fetched before anything is written
- [ ] Backfill of missing or deleted files for older chats, transcripts untouched
- [ ] Cloud sessions (claude.ai/code): per repo folder, saved when done, counted in totals

## 6a. Codex cloud [code: cloud/codex-app-server.ts, cloud/codex-cloud.ts, cloud/codex-sync.ts, covered by `npm run test:codex-cloud`]

- [ ] Off by default per ChatGPT account (`codexCloud`); runs after the chats inside the ChatGPT sync, same login key, delay, per-run limit and Stop; counted in the run's totals; the log always names it when on ("0 Codex cloud tasks" or "N Codex cloud tasks listed, M saved", plus "N still running")
- [ ] Connection: websocket `wss://codex-cloud-backend.chatgpt.com/`, sub-protocols `codex-app-server`, `codex-client.browser`, `openai-bearer.<access token>`; `initialize` (client name `obsidian-ai-chatbridge`, plugin version) then `initialized`; opened only when the sync reaches Codex, closed after it; 180 s per answer
- [ ] Read only: the client refuses any method but `thread/list`, `thread/turns/list` (without items) and `thread/items/list` (`sortDirection: "asc"`, 200 per page) before sending; thread IDs must be UUIDs; the login key never appears in an error
- [ ] Refused connection says to log in again; an error answer stops with its message; unexpected shape stops with "Unexpected Codex cloud task data", nothing more written
- [ ] Turns (newest first, paged back) and steps joined: turns oldest first, steps back in their turn, steps of an unnamed turn kept as a turn of their own
- [ ] **Keep Codex's steps** toggle (`codexCloudSteps`, off by default): off = raw keeps only `userMessage` and `agentMessage` items; each run of other steps between them becomes one `{ type: "stepsSkipped", count, kinds }` placeholder (reasoning dropped), so the note counts the same tool steps; no Changes section then. Long scheduled runs: 474 MB → a few MB for 21 tasks
- [ ] With steps kept: step texts other than your messages and Codex's answers cut to 50,000 characters each in the raw file, marked "…[cut N characters]" (long scheduled runs carry megabytes of command output); raw `.json` (`{ thread, turns }`) without indentation
- [ ] Folder `<Codex Cloud folder>/Tasks` (started on chatgpt.com/codex, `codex_cloud`) or `/Work` (started from ChatGPT, `codex_work_web` / `codex_work_mobile`), `Other` otherwise (with project subfolders on); name suffix = last 8 characters of the thread ID; raw mirrored under the raw files folder or the Codex Cloud JSON folder; older vaults get the folder beside their own `ChatGPT/Chat`
- [ ] Title: Codex's name unless it is just the first prompt cut off (then the prompt's first line, 80 characters); a scheduled run ("System instruction (automation runtime…") is named after its schedule's `- Title:`
- [ ] Note: `app: "Codex (cloud)"`, `session`, `model`, `started_from`, `source` (chatgpt.com/local/<id>), `account`; You / Codex turns, commands, tool calls and file edits counted as tool steps, reasoning left out; then Error (last turn's error, or "The last turn failed."; interrupted is no error) and Changes from file-edit steps (files, +/−, diff in a folded `[!diff]-` callout, fence longer than any backtick run; over 200,000 characters only in the raw file)
- [ ] Running (`status.type` "active" in the list, or newest turn in progress) waits and is counted; no prompt = remembered, nothing written; unchanged `updatedAt` = not fetched
- [ ] One note per task (follow-up rewrites it, earlier raw kept as version), restore from raw or by fetching, missing-guard, renames followed, Refresh index, raw-file move row, merge

## 6b. Merging copies from before one note per chat [code: merge.ts, merge-run.ts]

- [ ] Chats are grouped by the chat ID in the note properties (`uuid`, `session`, `session_id`); a chat is listed only if a note is named like a copy
- [ ] The first note (no copy ending) stays and gets the newest text; none left = the newest name without its ending, or the newest note's own name if that is taken
- [ ] Never touched: `(my edits …)` notes, a second note without a copy ending (named in the preview), chats whose history points at a note outside the group (skipped with the reason)
- [ ] Order per chat: earlier raw files renamed to `(version …)` (a `.jsonl` the newest starts with goes to the trash instead), main raw renamed to the note's name with its `(older N)` parts, saved files moved to the note's own `Artifacts/`/`Attachments/` (same file once, different file of the same name numbered), note written, links rewritten, history updated, other notes to Obsidian's trash
- [ ] Links: every `[[…]]`, `![[…]]`, `[..](..)` and property link to a merged note, moved file or renamed raw file is rewritten by the plugin itself (not dependent on "Automatically update internal links"); alias, heading and embed kept; unknown forms reported, never guessed
- [ ] Canvases [code: merge-canvas.ts]: file nodes get the staying note's full path (`subpath` kept), `[[…]]`, `![[…]]` and `[..](..)` in text nodes rewritten like in a note; ids, order, unknown keys, colours, positions and edges untouched, written back with the file's own indentation (Obsidian: tabs), nothing written if nothing changed; a canvas that moved with the chat is fixed at its new place; the preview counts canvas links like other links (it reads canvases from disk, so it opens with "Reading the vault…")
- [ ] A canvas that is not valid JSON Canvas, and any other non-note source (e.g. `.excalidraw`), is reported ("check by hand") and left as it is
- [ ] After the run: unresolved links naming a merged note (in notes and in canvas file nodes and text nodes) are added to the report; report note `AI ChatBridge merge report <stamp>` next to the sync log, plus a log line
- [ ] Stop between two chats works with the command **Stop the running sync** (and on unload); the rest can be merged by running it again. The Sync ribbon button, `pressSync()`, the status-bar click and **Stop all** do not stop a merge: they show "Merging chat copies: it finishes by itself in a few minutes. To stop it anyway, run the command 'Stop the running sync'."
- [ ] A stopped merge still writes its report (starts with "**Stopped after N of M chats.**") and log line ("…; stopped after N of M chats, run it again for the rest") and says so in its notice; an error outside one chat is reported the same way ("by an error")
- [ ] **Merge N chats** pressed while a sync runs [code: merge-wait.ts]: persistent notice "A sync is running. The merge starts by itself when it has finished.", then the merge starts as soon as that sync ends. While it waits, the automatic sync, sync on startup, ChatGPT retry and another device's request do not start (`busy` is true); a sync started by hand may go first and is waited for too
- [ ] A merge that does not start after all (another computer syncing and you chose to wait, plugin unloaded, …): notice "AI ChatBridge: The merge did not start. Nothing was changed."
- [ ] History after a merge: `md`, raw file, `older`, `versions`, `noteHash` set; ChatGPT `view` = `md`

## 7. Other providers [readme]

- [ ] ChatGPT: projects, pinned chats (own inventory lists, on by default; turning it off leaves them out of the inventory), archived optional, custom GPT chats to `Recent`, generated files and uploads, visual answers as HTML and pictures (nothing executed, no remote loads), voice chats as text, incremental sync with weekly full inventory, delayed-file retries
- [ ] Gemini: chats with shown reasoning, pictures as links. AI Studio: chats and prompts
- [ ] Gemini: a chat Google sends in an odd shape is skipped, named in the log under "could not read" and tried again next run; the third such chat in one run stops the sync ("could not be verified"), as a format change would
- [ ] Lumo: chats and projects decrypted in memory, saved readable, no attachments
- [ ] Claude Code local: folders follow sidebar groups or working folder, forks nested, `Attachments/` and `Artifacts/` (latest version, no source code or scratch files, vault notes linked), quiet wait, extra folders; sessions archived in the app (`isArchived` in its session file) are synced like the others, in their usual folder
- [ ] Codex local: per project or `Recent`, same file rules
- [ ] Desktop sessions assigned to accounts: extra folder, then organization or workspace ID, then first account; a saved session stays with its account
- [ ] A provider's desktop run (its command, no account): that app for every account with it on, filed as `desktop:<provider>:*`; the settings show the newest of the account's own run, this run and the all-desktop-apps run
- [ ] One account's desktop Sync: new or changed sessions of another (turned-on) account are not saved, but counted and named in the notice ("… belongs to <account>: sync that account or use Sync all.")
- [ ] Remote Control sessions left to Code Local, not saved twice
- [ ] Hermes: read-only snapshot via SQLite backup (built-in SQLite, else Python), per-profile folder, tool steps as collapsed callout (600 / 1,200 char cut), helper sessions optional, recently active skipped, `Private` never read, missing profiles skipped
- [ ] Vault layout `AI Chats/<Provider>/…`, raw files mirrored under the raw files folder, accounts share one folder per provider

## 7b. AI memory [code: src/memory, covered by `npm run test:memory`]

- [ ] Sources, each off by default: Codex local (`AGENTS.override.md`, `AGENTS.md`, `memories/`, `memories_v2/`, table `stage1_outputs` of `memories_*.sqlite` via read-only snapshot) and Claude Code local (`CLAUDE.md`, `projects/*/memory/`); `CODEX_HOME` and `CLAUDE_CONFIG_DIR` honoured
- [ ] Output `<memory folder>/<provider>/<account>/YYYY-MM-DD.md` plus `_latest.md`; local account = computer name
- [ ] Properties: `provider`, `account`, `source`, `synced`, `hash`, `files`, `unread: true`; `_latest.md` also `snapshot:` link
- [ ] Body: places read with what was found, then one H2 per memory file (its path below the AI's home) with the text in a code block whose fence is longer than any backtick run inside
- [ ] Text is never translated or corrected; Windows line ends (CRLF) are saved as LF, so the note still matches its `hash` after Obsidian has opened it
- [ ] Privacy filter [code: memory/redact.ts], on by default, switch in the Memory tab (user decision, 2026-11-16 afternoon; replaces the morning's "no redaction"): passwords, PINs, secret keys (by label, EN/DE/AF), 2FA seeds (`otpauth://`, labelled seeds), recovery codes (label line and the list below), ID numbers (by label, Swiss AHV by shape), card numbers (Luhn) and IBANs (mod 97) become `[REDACTED]`; only the value is replaced; runs before hashing and writing
- [ ] With a hit: intro sentence says how many values were replaced, property `redacted: N`, log line adds "replaced by [REDACTED]: <kind> in <provider> <file>" (never the value). Without a hit the note is identical with the filter on or off
- [ ] Snapshot only when the SHA-256 of the body differs from the last one (sync history in `data.json`, else the hash in `_latest.md`); unchanged writes nothing, not even `_latest.md`
- [ ] A dated snapshot is never written over: a second change that day is `YYYY-MM-DD (HHmm).md`; only `_latest.md` is replaced
- [ ] All snapshots of a source deleted = saved again on the next sync
- [ ] `Private`: a home inside one is refused, `Private` subfolders and Claude Code projects with `Private` as a name part are skipped (and named in the note), a memory folder inside one is refused
- [ ] Files over 2 MB or not text are named, not copied; Codex's use counters (`usage_count`, `last_usage`, `selected_for_phase2…`) are left out
- [ ] A source with no home folder writes nothing and is named in the result ("Nothing to read for: …")
- [ ] Runs through the normal sync guard: one at a time, last-run line (`memory`), notice, log line **AI memory:** only when something was written or it stopped
- [ ] ChatGPT web [code: memory/chatgpt-web.ts, chatgpt/api.ts], per account, off by default: memory summary (`POST /backend-api/memories/about_you/summary/stream`, always without a body; the only POST in the plugin, user decision 2026-11-16), saved memories (`GET /backend-api/memories?include_memory_entries=true`), custom instructions (`GET /backend-api/user_system_messages`); same login as the chat sync
- [ ] ChatGPT note: `source: web`, account = the account's label, H2s `/memory-summary` (ChatGPT's section titles as headings inside the block, sections without text left out), `/saved-memories` (`[date] text`, newest first, `status` left out), `/custom-instructions` (fields with text, short settings as lines)
- [ ] ChatGPT: an answer with an unknown shape or a missing login stops the run and writes nothing for that account; web sources run after the local ones; they need no file access
- [ ] Claude web [code: memory/claude-web.ts, api.ts], per account, off by default: memory files via the store's two read methods (`POST /api/organizations/<org>/melange/list` with `{}`, `POST …/melange/read` with `{path}`; only these two can be called), project names (`GET …/projects?uuids=…`), older single-text memory (`GET …/memory`, saved only when not empty), instructions (`GET /api/account_profile`: `conversation_preferences`, `cowork_global_instructions`); same login as the chat sync; 300 ms between file reads
- [ ] Claude note: `source: web`, account = the account's label, one H2 per memory file by its own path, a project's ID replaced by the project's name where known, then `/instructions-for-claude`; paths with `..` or an odd form are dropped, files under a folder named `Private` are not read and are counted in the note
- [ ] Not done yet: import from a data-export ZIP

## 8. Windows, macOS and Linux [code: platform.ts, folder-dialog.ts, computer.ts, desktop/scan.ts, hermes/profiles.ts]

Every item here must hold on all three. Path logic takes the platform or a fake file system as an argument, so `npm run test:desktop` and `test:hermes` cover macOS and Linux on any computer.

- [ ] **Browse…** opens at the current folder with the system's own separators; the pick is compared case-insensitively on Windows and macOS, exactly on Linux; a backslash in a macOS/Linux folder name is not a separator
- [ ] Session folders: `~/.claude/projects`, `~/.codex/sessions` and `archived_sessions` (or `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) on all three
- [ ] Claude desktop app data (titles, sidebar groups): `%LOCALAPPDATA%/Claude-Data`, `%LOCALAPPDATA%/Claude`, `%APPDATA%/Claude`; `~/Library/Application Support/Claude`; `$XDG_CONFIG_HOME/Claude` (absolute only), `~/.config/Claude`
- [ ] Hermes homes: `HERMES_HOME`, then `%LOCALAPPDATA%/hermes` (Windows only), then `~/.hermes`
- [ ] A leading `~` is the home folder in Extra session folders, Hermes **Add by path** and the Python setting
- [ ] Scratch files are skipped in every system's temp folder: `AppData/Local/Temp`, `/tmp`, `/var/tmp`, `/var/folders`, also under `/private`
- [ ] Computer folder name is the first part of the network name ("Walters-MacBook.local" gives "Walters-MacBook"); an IP address gives "This computer"
- [ ] Example paths in placeholders and hints match the system Obsidian runs on
- [ ] Vault lookups (`findFile` in vaultio.ts, used for every existence check) also find a name in the other Unicode form (NFC/NFD) on all three, and on Windows, macOS and iOS a name that differs only in letter case; so a name the file system already has is never treated as free (no "File already exists" stop). Linux and Android stay case-sensitive
- [ ] Python fallback tries `python3`, `python`, `py`; Hermes' bundled one as `python.exe` or `bin/python3`

## 9. Not user-visible but required

- [ ] Loads on phones and tablets (`isDesktopOnly: false`), Obsidian 1.11.4+. On mobile every sync of the device itself (manual, automatic, on startup, retry) is refused before it starts, manual ones with a notice; the settings, asking the computer (section 10) and **Test mobile connection** work there. No Node or Electron module is loaded at start-up (`main.js` requires only `obsidian`)
- [ ] No network calls outside the listed provider hosts; no telemetry
- [ ] Nothing changed or deleted on the provider side; files outside the vault only read
- [ ] File writes: `createNew` never overwrites; `writeOver` (replace content) is used only by versions.ts, after the earlier version is kept; nothing is deleted except by the merge command, into Obsidian's trash
- [ ] `npm run build`, `npm run lint` and `npm test` (every `test:*`) pass; CI runs `npm run test:ci` (all but `test:offline`, which needs the local `samples/`) on Linux, macOS and Windows

## 10. Sync from another device [code: src/remote, covered by `npm run test:remote`]

- [ ] Two files in the folder from the settings (default `00 Inbox/Mobile/ChatBridge`): `sync-request.json` (written only by a device that asks: `v`, `id`, `device`, `at`, `providers`) and `sync-status.json` (written only by the device that syncs: `requestId`, `device`, `requestedBy`, `state` running/done/refused, `startedAt`, `finishedAt`, `result` ok/problems/stopped/nothing/too-old/failed, counts and outcome per account, `message`). No other link between the devices
- [ ] Role (writer on a computer, requester on mobile; mobile is always requester until direct sync exists), device name, handled request IDs (last 50), time of the last requested run and the pending request live in `app.saveLocalStorage`, never in `data.json`
- [ ] Requester: the button writes the request and remembers it as pending; a second press within 2 minutes of an unanswered request writes nothing and says so; an unusable folder writes nothing
- [ ] Requester: one notice when the status for its own request says running, one when it is done or refused (which ends the wait); a status for another request is shown in the status line but not announced
- [ ] Writer: looks on vault `create`/`modify` of the two files, at start-up, every 60 s, when the window becomes visible and when a sync ends; a Requester waiting for an answer looks every 20 s
- [ ] Writer: each request ID runs once, also across restarts; a request older than the limit is refused once with a `too-old` status; while a sync or project-list fetch runs the request waits for its end (never interrupts); at most one requested run per 2 minutes (a later one waits for the rest of the time)
- [ ] Writer: a requested run is "Sync all" as the automatic sync does it (quiet, ChatGPT cooldowns respected, sources paused after an error stay paused); a notice names the asking device; the status is written before the run (running) and after it (done), with the runs recorded since its start; paused sources are named in the message ("Skipped until synced by hand on <device>: …") and make the result `problems`
- [ ] A status left at running by a closed Obsidian is closed as `failed` on the next look, so the asking device stops waiting
- [ ] Half-written or foreign JSON is ignored until the next look; nothing in the folder is ever deleted
- [ ] A file whose reported size is 0 right after it was written is written once more (Android reports a newly created file as empty, and Syncthing then delivers it empty)
- [ ] No login reaches the status file: notes are masked (`cleanNote`) and cut at 300 characters
- [ ] Remote status line (Overview hero, General tab): "Asked …, waiting for the computer" while a request is unanswered; "<device> is syncing"; "Last synced by <device> <when>: <message>", green/orange/red dot, plus "(asked by <device>)" on the Writer
- [ ] Writer: while another computer's busy marker is alive (section 11), a request is left alone; the next look takes it once that computer has finished

## 11. Several computers, one vault [code: src/computers, covered by `npm run test:computers`]

The vault (with `.obsidian`) may be synced between computers by a tool with no ignore list (Proton Drive). No file may be written by two computers.

- [ ] `data.json` holds only what you set (marked `storage: 2`) and is rewritten only when a setting changes, never after a chat
- [ ] `computers/<computer name>.json` in the plugin folder holds that computer's history: the web indexes (`index`, `fileIndex`, `cloudIndex`, `codexCloudIndex`, AI Studio `index`), ChatGPT cooldown, retry, captures, asset retries, inventories and progress, the project lists, each desktop app's extra folders, index, ignored files and group cache, the Hermes profiles and Python path, AI memory states, the last runs and the last Sync all. Only that computer writes it, and only when it changed. A phone writes none
- [ ] Before every sync and once after start-up, the other computers' files are read (a sync tool's clash copies too; half-written or foreign files ignored) and their web history combined into this one: chats, cloud sessions, downloaded files, the newer project list, web AI memory states, the newest last run per source. The same chat remembered differently: the one whose note is in the vault wins, then the newer, then ours. Combining only adds. Desktop apps, Hermes and cooldowns are never combined
- [ ] First start after the update: the old `data.json` is kept as `data.before-computers.json`, then split once. Desktop and Hermes history whose paths exist nowhere on this computer is put aside in `computers/_unclaimed.json` (with a notice) and taken back by the computer where they exist; the file is then emptied, never deleted
- [ ] History in `data.json` (an older build wrote it) never wins over the computer file
- [ ] No plugin folder known: everything stays in `data.json`, as before
- [ ] `data.json` changed by another computer: its settings are taken over and this computer's history kept; during a sync, once the sync has ended
- [ ] Busy marker `sync-busy.json` in the plugin folder: `running` (computer, start, a sign of life every 60 s) while a sync runs here, `idle` afterwards. Another computer's `running` marker with a sign of life in the last 30 minutes: a manual sync asks **Another computer is syncing** (Cancel / **Sync here anyway**); automatic, start-up and retry runs are skipped; our own marker never blocks
