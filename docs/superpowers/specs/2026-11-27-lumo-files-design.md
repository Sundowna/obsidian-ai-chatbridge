# Lumo: save artifacts and uploads

Date: 2026-11-27. Status: approved by the user and built the same day.

## Why

Lumo now makes artifacts (files it writes for you) and takes uploads. The plugin saves the chat text only and writes "*(1 attachment, not saved)*". Claude and ChatGPT chats already come with their files; Lumo should too.

## What was found

- Proton's published client (ProtonMail/WebClients, `applications/lumo`): every file is an "asset" owned by a space. `GET /api/lumo/v1/assets/<ID>` returns `{ Asset: { ID, SpaceID, AssetTag, AssetType, CreateTime, DeleteTime, Encrypted } }`.
- `Encrypted` is AES-GCM with the space key (the key the chats already use), associated data `{"app":"lumo","id":"<AssetTag>","type":"attachment"}`, and the plain bytes are MessagePack: `filename`, `data` (the file's bytes), `markdown` (text conversion), `mimeType`, `rawBytes`, `role`, `generatedArtifactAsset { conversationId, artifactId, artifactType, artifactTitle }`.
- The space list the plugin already reads names each space's assets (`Assets: [{ ID, AssetTag, AssetType, DeleteTime, Encrypted: null }]`). AssetType 0 = upload, 1 = generated image, 3 = generated document.
- Checked on a live test account (2026-11-27): one upload (a picture, type 0, about 52 KB) and one artifact (a CSV, type 3). The asset address answers 200 in the shape above.
- A message names its uploads in `attachments: [{ id, … }]` (id = AssetTag). An artifact is also in the chat itself, as a `create_artifact` tool step with the whole text (`id`, `title`, `type`, `language`, `content`).
- Not checked live: decryption of an asset (done by the plugin, verified in the offline test the way the chat decryption is), generated images (type 1), artifacts edited later.

## Goals

- Uploads go to `Attachments/`, files Lumo made go to `Artifacts/`, beside the chat note, as for Claude.
- The note links each file where it belongs in the conversation.
- Chats saved before this get their files too.
- Same safety as today: read only, keys in memory only, nothing guessed.

## Not in scope

- Files of a project that no chat message uses.
- Files auto-fetched from Proton Drive (`autoRetrieved`): skipped, named in the log.
- Changing or deleting anything at Lumo.

## Approaches

1. **Assets from Lumo, chat text as fallback (chosen).** Fetch and decrypt each asset a chat uses. For an artifact with no asset, write the text from its `create_artifact` step. Covers uploads, pictures and artifacts; one request per file.
2. Artifacts from the chat text only. No new request, but no uploads and no pictures. Rejected: the user wants everything.
3. Assets only. Simpler, but an artifact whose asset is missing or unreadable would be lost although its text is in the chat.

## Design

- **Request:** one new read-only address in the Lumo allow-list, `/api/lumo/v1/assets/<id>`, through the same single GET, same delay, same error log.
- **Which files belong to a chat:** assets named in its messages' `attachments`, plus assets whose decrypted `generatedArtifactAsset.conversationId` is this chat. Deleted assets are skipped.
- **Decrypting:** existing AES-GCM helper with the space key and the attachment associated data. A small built-in MessagePack reader (no new dependency; my call, to keep the plugin free of extra packages). A file that cannot be decrypted or read is skipped, named in the log ("will retry"), and never stops the sync.
- **What is saved:** `data` under `filename` (made safe, numbered on a name clash). No `data` but `markdown`: the text as `<filename>.md`. Pictures: Lumo keeps a reduced copy, so that is what is saved.
- **Artifact fallback:** title plus an ending from the language or type (`csv`, `md`, `html`, …; unknown = `.txt`). Several versions of one artifact: the newest is the file; older ones stay in the raw file.
- **Note:** under the message, `![[…]]` for pictures and `[[…]]` for other files, instead of "not saved". A file that could not be saved keeps a plain line saying so.
- **Index:** `fileIndex` (asset ID → vault path) per Lumo account, so each file is fetched once; it follows renames and moves like Claude's.
- **Setting:** "Download files and images" on the Lumo tab, on by default, like Claude and ChatGPT. Off: today's behaviour.
- **Older chats:** a saved chat whose files are missing is fetched again and its note rewritten in place (counted as changed), within the per-run limit, newest first.
- **Raw file:** unchanged; no file bytes go into it.

## Left to the builder

File naming details, the exact log wording, and where the helper functions live.

## Tests and ledger

- `npm run test:lumo`: an asset encrypted the way Proton's client does it (MessagePack + AES-GCM + associated data) is decrypted and saved; wrong associated data is skipped; upload and artifact land in the right folder; artifact fallback from the chat text; a file is fetched once; setting off = no request; older chat gets its files.
- FEATURES.md: new lines for Lumo files, the setting and the allow-listed address; README and changelog updated ("no attachments" no longer true).
