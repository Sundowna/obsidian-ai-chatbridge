# Changelog

## 0.45.0 - 2026-11-27

### Added
- **ChatGPT: optional reasoning in the note** - a new switch per account, **Show reasoning in the note**, off by default. When on, the reasoning ChatGPT shows sits folded above each answer; saved notes follow on the next sync.

### Fixed
- **ChatGPT: one odd chat no longer stops the sync** - a chat that arrives in an unexpected shape is skipped, named in the log and tried again next time, as for the other providers. A third one in the same run still stops the sync.

## 0.44.0 - 2026-11-27

### Added
- **Claude: starred chats are marked in the note** - a `starred` property, as Lumo notes have. Where claude.ai's chat list says so, a later star or unstar is followed without fetching the chat again.
- **Claude: optional reasoning in the note** - a new switch per account, **Show reasoning in the note**, off by default. When on, Claude's reasoning sits folded above each answer, for chats saved from then on. It is in the raw file either way.

### Fixed
- **Gemini and Lumo: an unpinned or unstarred chat no longer keeps its old mark** - when a chat changed and lost its pin or star at the same time, the note kept the old property. It is now removed.

## 0.43.0 - 2026-11-27

### Added
- **The model is named in every chat note** - Claude, ChatGPT and Lumo notes get a `model` property, as Gemini and AI Studio notes already had. A chat that used several models lists each once. Existing ChatGPT notes get it on the next sync; Claude and Lumo notes get it when the chat next changes.
- **Pinned and starred stay up to date** - when you pin or unpin a Gemini chat, or star or unstar a Lumo chat, the note's property follows on the next sync, without fetching the chat again.

### Fixed
- **A brief network hiccup no longer stops Claude, Gemini, AI Studio and Lumo syncs** - a request that gets no answer is tried again after a few seconds, up to three times, as ChatGPT has done since 0.41.3.
- **One odd chat no longer stops the sync** - for Claude, AI Studio and Lumo, a chat that arrives in an unexpected shape is skipped, named in the log and tried again next time, as Gemini already did. A third one in the same run still stops the sync.
- **Gemini and AI Studio: the same Google login used twice is noticed** - two accounts in the plugin signed in with one Google login would have saved every chat twice. The sync now stops and says so.

## 0.42.0 - 2026-11-27

### Added
- **Lumo: files are saved too** - your uploads (pictures, documents) go to `Attachments/` and what Lumo made (artifacts, pictures) to `Artifacts/`, next to the chat, as for Claude and ChatGPT. The note shows pictures and links the other files instead of saying "not saved". Files are unlocked on your computer with the same key as the chat, one read-only request per file. Chats you saved earlier get their files over the next syncs. Turn it off under Lumo → Content → **Download files and images**. Lumo keeps a reduced copy of a picture, so that is what you get.

### Fixed
- **Gemini, AI Studio, Lumo and Hermes: safety stop when many chats are missing** - if many saved chats are not where the plugin expects them (for example after moving folders outside Obsidian), the sync now stops with a hint to use "Refresh index" instead of fetching them all again. Claude and ChatGPT already did this.
- **Gemini, AI Studio and Lumo: a deleted note comes back without a download** - when you delete a chat note but its raw file is still in the vault, the note is written again from that file. It no longer asks the provider and no longer uses up the "max chats per run" limit.

## 0.41.8 - 2026-11-27

### Fixed
- **ChatGPT: older photos are saved again** - chatgpt.com now serves some older photos only as a smaller, resized copy. These waited for ever as "size mismatch"; the resized copy is now saved. Other files of the wrong size are still skipped

## 0.41.7 - 2026-11-27

### Added
- **Claude: setting "Long pasted text"** - choose how pastes longer than 5 lines are saved: **File, with a 5-line preview** (the default) or **All of it in the note**. Changing it updates your saved notes on the next sync (issue #64)

### Changed
- **Claude: pasted text in the note is shorter** - only pastes of up to 5 lines go into the note in full (was about two pages). A longer paste is saved as a file, and the note shows its first 5 lines with a link to it

### Fixed
- **Claude: chats synced before 0.41.6 get their pasted text too** - on the next sync, each saved chat is checked once from its saved file (nothing is asked of claude.ai). Notes with pasted text are redrawn; your edits are handled as set under "When an edited note gets an update"

## 0.41.6 - 2026-11-27

### Fixed
- **Claude: pasted text is no longer missing** - when you paste a long text into claude.ai it shows a "Pasted" card, and these cards were left out of synced chats. Short pastes (up to about two pages) now appear in the note as a quote. Longer ones are saved as "Pasted text.md" in the chat's Attachments folder and linked from the note, or folded into the note when Download files is off. Text files you added to a chat are handled the same way. Chats synced before get their pasted text the next time they change (issue #64)

## 0.41.5 - 2026-11-27

### Fixed
- **ChatGPT: one file that will not download no longer stops the whole sync** - when chatgpt.com refused to hand over a single file (seen: a generated script file answered "415"), the sync stopped there. Now only that file is skipped and tried again later, and the rest of the sync goes on. A missing login still stops the sync, as before
- **ChatGPT: deleted files are named as such** - files chatgpt.com no longer has (old uploads, and files made with code that have expired) were listed as "unexpected file response" or "JSON without a download link". They now show as "download unavailable", which is what they are

## 0.41.4 - 2026-11-27

### Fixed
- **ChatGPT: pasted text from your Library is saved too** - 0.41.2 fetched Library files, but long pastes (the "Pasted text(…).txt" files ChatGPT makes when you paste a lot of text) were still skipped as "not a file download": chatgpt.com sends these to be shown rather than downloaded. They are the exact pasted text, with their file name and size, so the plugin now saves them like the other Library files. An answer that does not name a file is still never saved

## 0.41.3 - 2026-11-27

### Fixed
- **ChatGPT: a brief network hiccup no longer stops the sync** - when a connection to chatgpt.com broke for a moment (for example "Network error: net::ERR_SSL_BAD_RECORD_MAC_ALERT"), the whole sync stopped. The plugin now tries that request again after a few seconds, up to three times, and only stops if every try fails. The error then says how often it was tried and is listed in the Error logs tab (#48)

## 0.41.2 - 2026-11-26

### Fixed
- **ChatGPT: files from your Library are saved again** - uploads and long pastes that ChatGPT keeps in its Library (for example "Pasted markdown.md", project files, zips and spreadsheets) were never saved: the sync skipped them every time as "chatgpt.com/api/library/…" and kept them waiting. chatgpt.com now hands out a Library address for these files; the plugin fetches them there with your ChatGPT login, the same way as other uploads, and checks the size as usual. A Library file chatgpt.com cannot serve (it answered "Could not resolve file URL" for one pasted item) is skipped and tried again later and no longer stops anything. Files already waiting are fetched as their next try comes due

## 0.41.1 - 2026-11-26

### Fixed
- **ChatGPT: one refused file no longer stops the whole sync** - when chatgpt.com refused a single file in a chat (403 "Forbidden"), the sync stopped there, so later chats and newer messages were not saved. Now only that file is skipped (it shows as "[image – not downloaded]" and is tried again on a later sync), and the rest of the sync goes on. The refusal is still listed in the Error logs tab. A Cloudflare check page or a 403 on a chat itself still stops the sync, as before (#48)

## 0.41.0 - 2026-11-26

### New
- **New: changing a chat folder moves your saved notes too.** Before, only new chats went to the new folder.
- **New: you're asked first.** The move starts when you press Enter, leave the field, pick a suggestion or use **Browse…**. Cancel keeps the old folder.
- **New: everything comes along.** Subfolders, raw files and earlier versions move with the notes, and links and the index are updated.
- **New: tidy clean-up.** Old folders left empty go to the trash. Custom project folders, a separate JSON folder and other notes stay put.
- **New: safe if something goes wrong.** A missing file or a taken destination stops the move before it starts, and a move that fails partway puts the files back.
- **New: no stray folders.** Typing a folder name no longer creates folders letter by letter.
- Works for Claude, ChatGPT, Lumo, Gemini, AI Studio, Claude Code, Codex (cloud and local) and Hermes, on desktop. Thanks @The-Aries (#50)

## 0.40.1 - 2026-11-26

### Fixed
- **Claude-made files are saved again on accounts without the chat view** - on account plans where claude.ai does not offer the chat view (403 "blocked_by_org_tier"), the files Claude creates in a chat (download cards) were left out. The plugin now finds them by their paths in the chat's tool calls and downloads them the way claude.ai's own chat page does, into the chat's `Artifacts/` folder, linked from the note. A file claude.ai no longer has is skipped and remembered; any other refusal is tried again on the next sync and never stops it (#46)
- **ChatGPT files made with code are saved again** - files ChatGPT creates with Python (the download cards in a chat, such as a CSV or text file) were skipped as "generated-file download returned 200 or a preview". chatgpt.com now answers that download with a short note that points to the file instead of the file itself; the plugin follows that link the same way it does for uploads and pictures
- **Gemini: pictures Gemini made no longer show as a dead link** - where Gemini generated a picture, the note showed a placeholder address (`googleusercontent.com/image_generation_content/…`) that leads nowhere. It now shows "Generated image" with a link to the picture on Google's servers, which opens while you are signed in to Google. The picture itself is still not downloaded. Notes saved before are updated the next time their chat changes

## 0.40.0 - 2026-11-25

### New
- **Use browser login for ChatGPT** - Google blocks its sign-in inside apps ("This browser or app may not be secure"), so "Continue with Google" cannot work in the login window. A new **Use browser login…** button under the ChatGPT login walks you through bringing over the login from your own browser: open chatgpt.com, find the session cookie with **Copy name**, and paste its value - both the `.0` and `.1` parts when ChatGPT splits it. The plugin checks it with ChatGPT once and only saves it when it works, in Obsidian's secret storage on this computer, never in your vault (#52)

## 0.39.0 - 2026-11-25

### New
- **Separate archived chats** - for ChatGPT and Claude web accounts that include archived chats, a new switch (off by default) files archived chats in an `Archived/` folder of their own, with the same project layout as the active ones. **Separate now** moves the chats you already have; turning it off moves them back. A chat you archive or unarchive on the website moves on the next sync, with its raw files and versions. Thanks to The-Aries (#49)
- **Error logs** - a new settings tab keeps the last 20 failed answers of each account (Claude, ChatGPT, Gemini, AI Studio, Lumo, Codex cloud) in full: address, status, response headers and body. **Copy** gives a ready-made block for a GitHub issue. Cookies, session keys and login keys are removed automatically; remove personal data (email addresses, names, chat titles and text) yourself before pasting. Saved in the plugin's folder, not in your notes

### Fixed
- **claude.ai sync no longer stops with "403 (forbidden) to ReadConversation" on some accounts** - on some account plans claude.ai does not offer the chat view the plugin reads for download cards. The sync now saves those chats without the chat-view files and goes on, and the log says so once. Any other 403 still stops the sync (#46)

## 0.38.0 - 2026-11-25

### Changed
- **Unchanged chats are not reread on every sync** - after a check that found nothing to do, a Claude or ChatGPT chat remembers its raw files' size and time, its note, its saved files and the plugin build. While those stay the same, the next sync skips the chat without opening its files. Anything different (a deleted or edited file, a moved note, a plugin update) brings the full check back, so the results are the same as before. Fewer reads on every sync, most noticeable on slower devices
- **System files start with "_"** - the sync log is now `_ai-chatbridge-log.md`, reports are `_ai-chatbridge-merge-report-….md` and the diagnostics folder is `_ai-chatbridge-diagnostics`, so they are easy to leave out of the graph. Your existing ones are renamed once when you update, through Obsidian, so links keep working; a log you named yourself keeps its name

### New
- **Active Context** - for a vault with a handover note, **General → Active Context** (off until you turn it on; choose a handoff folder, the note is made there if you have none) keeps it up to date: after every sync a **Live sessions** list of the chats active in the last 48 hours, with a link and your last request; once a day the 7-day archive pass into `Handoff archive/_YYYY-MM.md`; and a question under "Waiting for …" for a "Now" line that stayed 3 days. New commands **Update Active Context now** and **Hand over a chat to another AI**, which copies a ready message for the next AI; also on the right-click menu of a synced chat note

## 0.37.0 - 2026-11-24

### New
- **Include archived chats for Claude** - a switch in the Claude account settings, like the one ChatGPT has. Off by default. Turned on, the sync also reads claude.ai's archived chats, which claude.ai lists apart, and saves them in their normal folder (their project, or `Recent`). A chat archived after it was saved stays where it is

### Docs
- **Archived desktop sessions** - the README now says that sessions archived in the Claude or Codex desktop app are synced as before, in their usual folder

## 0.36.1 - 2026-11-20

### Fixed
- **Merge chat copies waits for a running sync** - pressing **Merge N chats** while a sync was running (an automatic sync can start while the preview is open) quietly did nothing apart from a short notice. Now a notice stays up, "A sync is running. The merge starts by itself when it has finished.", and the merge starts as soon as that sync ends. While it waits, the automatic sync, a retry and a phone's request wait their turn. If the merge does not start after all (for example another computer is syncing and you choose to wait), a notice says "The merge did not start. Nothing was changed."
- **A running merge is not stopped by the Sync button** - the Sync ribbon button, a click on the status bar and **Stop all** used to stop a running merge part-way. Now they only show how to stop it: with the command **Stop the running sync**, which still stops it between two chats
- **A stopped merge says where it stopped** - the report note starts with "Stopped after N of M chats", the log line says the same, and so does the notice. An error outside a single chat is reported the same way instead of leaving no report

## 0.36.0 - 2026-11-20

### New
- **Include pinned chats** - a switch in the ChatGPT account settings, next to **Include archived chats** ([#32](https://github.com/Sundowna/obsidian-ai-chatbridge/issues/32)). On by default, so pinned chats are synced like the others, as in 0.35.2. Turned off, the pinned lists are not read and pinned chats are left out of the sync; turning it back on reads them in full once

## 0.35.2 - 2026-11-20

### Fixed
- **Pinned ChatGPT chats are synced** - ChatGPT leaves pinned chats out of its normal chat list, so they were never saved, with no error in the log ([#32](https://github.com/Sundowna/obsidian-ai-chatbridge/issues/32)). The inventory now reads the pinned chats as two more lists of their own (normal and TPP), checked incrementally like the others. The first sync after the update reads them in full once. A chat that is unpinned later stays one note

## 0.35.1 - 2026-11-19

### Changed
- **Merging chat copies also fixes links in canvases** - **Merge chat copies into one note** now rewrites a canvas's cards that show a merged note: a file card points at the note that stays (a card showing one heading keeps it), and links written in a text card are rewritten like links in a note, alias, heading and embed kept. Nothing else in the canvas changes, and a canvas without such a link is not written at all. The preview counts these links like any other. Before, a canvas was only named in the report to check by hand. A canvas that cannot be read, and other files that are not notes (such as Excalidraw drawings), are still only reported

## 0.35.0 - 2026-11-19

### New
- **One vault on several computers** - the vault can now be synced between computers by a file syncing app that copies everything, `.obsidian` included (Proton Drive, Syncthing, Obsidian Sync), and whichever computer you are on syncs everything itself. No computer has to stay switched on for the others
  - `data.json` now holds only what you set. It is rewritten only when you change a setting, never after a chat, so two computers no longer write over each other's copy
  - What a computer synced goes to a file of its own, `computers/<computer name>.json` in the plugin folder: what has been saved per chat, downloaded files, ChatGPT cooldowns and retries, project lists, the last runs. So do its own folders: Claude Code and Codex extra session folders, Hermes profiles and the Python path. No other computer writes that file
  - Before each sync, what the other computers saved is read and combined, so a chat Tower saved yesterday is not fetched again on the laptop and no second note is written. The same chat remembered differently on two computers: the one whose note is in the vault wins (the other may still name the note from before a rename), then the newer. Combining only adds. Claude Code, Codex and Hermes sessions stay with the computer they are on
  - **Busy marker** - while a sync runs, `sync-busy.json` says which computer is syncing. If you start a sync on another computer meanwhile, it asks whether to wait or sync anyway; the automatic sync, the sync on startup, a retry and a phone's request wait. A marker with no sign of life for 30 minutes (lid closed, Obsidian ended) no longer counts
  - The last-sync lines name the computer when another one ran it ("today 10:02 on Tower"). **General → Computers** shows this computer's name and when the others last synced
  - A settings change made on another computer (it arrives as a new `data.json`) is taken over without losing this computer's history

### Good to know
- On the first start the settings are split once, and the old `data.json` is kept as `data.before-computers.json`. Claude Code and Hermes history that belongs to another computer (its folders do not exist here) is put aside in `computers/_unclaimed.json` and taken back by that computer when it opens the vault
- Each computer signs in to each account once: logins live in that computer's Obsidian, not in the vault
- Let the file syncing app finish copying the vault to a new computer before its first sync. A chat whose note has not arrived yet would otherwise be written again
- The plugin's own files travel with the vault too, so every computer runs the same version once the sync has delivered it

## 0.34.1 - 2026-11-18

### Fixed
- **macOS: "File already exists" no longer stops the sync** - the plugin looked files up by their exact name, but macOS and Windows treat names that differ only in letter case as the same file, and file names synced by tools such as Syncthing can be stored in another Unicode form (accented letters written as two characters). Such a file looked missing, so creating it failed and the sync stopped there every time. Now the existing file is found: a changed chat updates it, and a new file whose name differs only in case gets a number (`… 2.png`). Linux keeps names that differ in case apart, as its file system does ([#25](https://github.com/Sundowna/obsidian-ai-chatbridge/issues/25))
- **Gemini: one unreadable chat no longer stops the whole sync** - a chat Google sends in an unexpected shape (for example a turn without prompt text) is now skipped, named in the log under "could not read" and tried again next run, and the other chats keep syncing. If three chats in one run fail that way, the sync still stops, since Google may have changed its format ([#26](https://github.com/Sundowna/obsidian-ai-chatbridge/issues/26))

## 0.34.0 - 2026-11-18

### New
- **Codex cloud tasks** - tasks that Codex ran in OpenAI's cloud can now be saved with the ChatGPT sync, into the new **Codex Cloud folder**: `ChatGPT/Codex-Cloud/Tasks/` for those started on chatgpt.com/codex, `Work/` for those started from ChatGPT on the web, the phone or a schedule. Each note holds every prompt and Codex's answers with the steps counted, the error of a failed turn and the files changed as a folded diff, and links back to the task; the raw `.json` holds the conversation, and with the new **Keep Codex's steps** toggle every step too (very long command output cut at 50,000 characters). Scheduled runs are named after their schedule. A running task is saved once it is done, and a follow-up updates its one note while the version before stays as raw `.json`. The plugin reads Codex over the same live connection the Codex page uses, and only reads. Off until you turn it on per account with **Codex cloud tasks** in the ChatGPT tab. The ChatGPT log line always says how many Codex cloud tasks it found
- **Sync from your phone, run by your computer** - the plugin now loads in Obsidian on Android and iOS. Its sync button there writes a small request file into the vault; your computer picks it up once your vault sync has delivered it, runs **Sync all** and writes back what it did. The phone tells you when the computer has started and finished, and the Overview shows "Last synced by …". No connection between the devices is needed besides the vault sync you already use. Set the shared folder under **General → Sync from another device**; whether a device syncs or asks is saved on the device itself. The computer runs each request once, at most one every two minutes, never interrupts a running sync, and ignores requests older than 12 hours (a setting). New command **Sync: here, or ask the computer**, for the mobile toolbar
- **Test mobile connection** - a first step towards syncing on the phone itself. The new command **Test mobile connection** checks whether that device can reach claude.ai and ChatGPT with a pasted session key or cookie: it shows the status, the content type and whether a Cloudflare check page came back. Nothing is saved, and no key is shown or logged

### Changed
- The plugin is no longer marked desktop only. A phone or tablet does not sync by itself yet: there the sync button and **Sync all chats** ask your computer instead
- The ribbon icon reads "Ask the computer to sync" on a device that asks

## 0.33.0 - 2026-11-16

### New
- **AI memory** - a new **Memory** tab saves what an AI keeps about you between chats as dated snapshots: its memory files and your global instructions. First sources, both on this computer and both off until you turn them on: **Codex** (`AGENTS.md`, `memories/`, `memories_v2/` and the per-thread notes in its memory database) and **Claude Code** (`CLAUDE.md` and every project's memory folder). A snapshot is written only when something changed, `_latest.md` always holds the current state, and the text is never translated or corrected. A **privacy filter** (on by default, with a switch) replaces passwords, recovery codes, 2FA seeds, ID numbers, card numbers and IBANs with `[REDACTED]` before anything is written, and names the kind and the memory file in the sync log. New command **Sync AI memory**, with its own optional interval; **Sync all** does not include it
- **Claude memory** - the **Memory** tab can now save what Claude keeps about you on claude.ai, per Claude account and off until you turn it on: every memory file (profile, topics, areas, people, and each project's own memory under the project's name) and your instructions for Claude, as one dated snapshot that is written only when something changed. It uses the login the chat sync already has and changes nothing on claude.ai
- **ChatGPT memory** - the **Memory** tab can now save what ChatGPT keeps about you, per ChatGPT account and off until you turn it on: the memory summary with its own section headings, the saved memories and your custom instructions, as one dated snapshot that is written only when something changed. It uses the login the chat sync already has and changes nothing on chatgpt.com. The summary is asked for the way ChatGPT's settings page asks for it, so ChatGPT may write a fresh summary first if its stored one is out of date

### Changed
- **The Claude and ChatGPT commands sync everything from that provider** - **Sync Claude** (was "Sync Claude chats") now syncs every claude.ai account and then Claude Code on this computer; **Sync ChatGPT** (was "Sync ChatGPT chats") syncs every ChatGPT account and then Codex. Before, they synced only the web chats, so a toolbar button named "Claude" never picked up Claude Code sessions. Command IDs are unchanged, so buttons and hotkeys bound to them keep working

### Fixed
- **Sync all no longer stops at the first source that fails** - before, an error in one source (for example ChatGPT asking you to log in again) ended Sync all there, so Claude Code, Codex and Hermes, which come last, were never synced. Now each source runs; a failing one shows its notice and the next one runs
- **One error no longer pauses all automatic syncing** - before, any error paused the automatic sync for every source until you synced by hand. Now only the source that failed waits; the status bar names it (`next sync 11:30 · waiting for you: ChatGPT`). It joins the automatic sync again once it has synced without an error
- **A one-account Claude Code or Codex sync says when another account has sessions waiting** - a session belongs to the account whose login made it. Syncing one account used to report "0 new" while new sessions of another account were waiting; the notice now names them (`3 new or changed sessions belong to B - Yearly: sync that account or use Sync all.`)

## 0.32.1 - 2026-11-16

### Fixed
- **ChatGPT login no longer goes stale** - chatgpt.com renews its login cookie as you use it, but the sync threw the renewed cookie away. After some days the stored login stopped counting and the sync stopped with "chatgpt.com did not hand out a login key". The sync now reads chatgpt.com through the login window's own storage, which keeps the renewed cookie
- **ChatGPT generated files can download again** - files ChatGPT made in a chat (for example `.docx` or `.xlsx` from code) always failed with "generated-file request failed", because the request carried a timeout Obsidian's main process refuses. The timeout is now handled in the plugin

## 0.32.0 - 2026-11-16

One note per chat. A chat that continues no longer gets a second `(updated …)` note.

### New
- **One note per chat** - when a chat continues after it was synced, its note is now updated to the whole current chat instead of getting a second `(updated …)` note next to it. The note keeps its name and place, so links stay valid. This goes for every provider: Claude, Claude Code (cloud and local), ChatGPT, Codex, Gemini, AI Studio, Lumo and Hermes
- **Earlier versions stay as raw files** - before a chat's raw file is replaced, the one from before is kept beside it as `<name> (version <date>).json`. The note says how many there are (`earlier_versions:`) and links them (`earlier_raw:`)
- **Your edits are safe** - properties you added to a note are always carried over. If you changed the note's text, your version is saved first as `<name> (my edits <date>).md`. **General → When an edited note gets an update** can instead leave such notes alone or overwrite them
- **Merge chat copies into one note** - for vaults that already hold `(updated …)` notes: **General → Merge chat copies into one note** (also a command) shows a preview of what merges into what and changes nothing until you confirm. Then each chat's first note gets the newest text, earlier versions become `(version …)` raw files, saved files move to the note's own folder, links are rewritten, and the merged notes go to Obsidian's trash. A report note lists everything, including any link that could not be fixed. ChatGPT `(transcript …)` copies and `(recovered)` notes can be merged too
- **Hermes raw files** - each Hermes session now also gets a raw `.json` in the raw files folder, linked from its note

### Changed
- **"Nothing is overwritten" no longer holds for the notes themselves** - the note of a continued chat is rewritten. What you lose: an earlier version is no longer a readable note, only raw JSON in the raw files folder
- ChatGPT no longer writes `(transcript …)` copies when a chat is shown differently (for example once its files are downloaded): the chat's one note is brought up to date
- A chat whose files you deleted comes back under its own name; `(recovered)` notes are no longer made
- A continued chat stays in the folder its note is in, even if you moved the chat to another project on the provider's side. Its raw file stays where it is too; **Move … files** in the settings moves raw files to where the settings put them now
- Desktop sessions: with **Keep the raw session file** on, the `.jsonl` copy is rewritten as the session grows; an earlier copy is kept only if the app rewrote the session file

## 0.31.0 - 2026-11-16

Better on macOS and Linux. Nothing changes on Windows.

### New
- **`~` for your home folder** - on macOS and Linux you can type `~/…` in **Extra session folders**, in Hermes **Add by path** and in the Hermes **Python** setting

### Fixes
- **Browse… on macOS and Linux** - the folder dialog opened in the wrong place (the start folder was written the Windows way) and now opens at the current folder. On macOS the dialog also says what it is for. On Linux, where `Notes` and `notes` are two folders, the pick is compared exactly
- **Claude desktop titles and groups on Linux** - also looked for in `$XDG_CONFIG_HOME/Claude`, not only `~/.config/Claude`
- **Scratch files on macOS** - temporary files Claude wrote for itself under `/var/folders/…` and `/private/tmp` are no longer saved as artifacts, as on Windows and Linux
- **Computer name on macOS and Linux** - the folder for local sessions was named after the full network name ("My-MacBook.fritz.box"), which changes with the network. New installs use the computer's own name ("My-MacBook"). Folders you already have keep their name

### Changed
- Example paths in the settings match the system you are on
- The tests now also run on macOS and Linux for every change

## 0.30.0 - 2026-11-14

### New
- **How the last sync went** - each account now says when it last synced and what that run did, without waiting for a notice. The Overview's account cards and Hermes card show a **Last sync** line, e.g. "today 14:02: 3 new, 1 changed, 240 unchanged", and so does the sync row in each tab (Web, Desktop app, AI Studio, Hermes). A green dot means it went fine; orange means you stopped it, it is waiting for a ChatGPT cooldown, no projects were selected or Hermes profiles were not found; red means it failed, with the reason. Automatic syncs are marked "(automatic)"
- **Last Sync all** - under "… saved so far" on the Overview, one line sums up the last **Sync all** and names any account that had a problem

## 0.29.0 - 2026-11-13

### New
- **Claude Code cloud sessions** - sessions that ran in Anthropic's cloud (claude.ai/code, also started from the phone app) are now saved with the claude.ai sync, into the **Code Cloud folder**, one subfolder per GitHub repository. The note says `app: "Claude Code (cloud)"`, names the repository and links back to the session on claude.ai; the raw `.json` holds every event. A session that is still running is saved once it is done, and a session that goes on later gets an "(updated …)" note next to the old one. Pasted images and files Claude wrote in full go to `Attachments/` and `Artifacts/`. Sessions you steered from claude.ai but that ran on your computer (Remote Control) are left to **Code Local**, so nothing is saved twice. Turn it off per account with **Claude Code cloud sessions** in the Claude tab

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
