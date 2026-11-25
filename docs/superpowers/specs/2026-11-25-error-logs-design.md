# Error logs tab – design (short)

Date: 2026-11-25. Size: a small feature, one PR.

## Why

Bug reports like #48 ("ChatGPT answered 403") arrive with only the one-line stop reason. The plugin throws the answer away, so nobody can tell a Cloudflare check page from ChatGPT refusing the account, or which request was refused. The owner wants users to be able to copy the full answer and paste it into a GitHub issue.

## What the user sees (owner's decisions)

- A new settings tab **Error logs**, after General, with one subtab (pill) per account, grouped by provider, e.g. "Claude · Work", "ChatGPT · Default".
- At the top of the tab, a clear note: *Remove all personal data (email addresses, names, chat titles and text) before pasting this into a GitHub issue.* Plus: *Cookies and login keys are removed automatically.*
- For each failed request the **whole answer** is kept: time, provider and account, method and address, status, response headers, response body, plugin version, Obsidian version and OS.
- Buttons: **Copy** per entry, **Copy all** and **Clear** per account. Copied text is Markdown with the body in a fenced block, ready for an issue.
- Empty state: "No errors saved for this account."

## Storage (owner's decision: a file in the plugin folder)

- `<vault>/.obsidian/plugins/ai-chatbridge/error-log.json`, written through the vault adapter, like the computer files. Not a note, not in `data.json`.
- Kept: the last 20 entries per account; a body is cut at 64 KB (marked "… cut, N KB more").
- An account that is removed loses its entries.

## What counts as an error (my call)

- Every answer that stops or skips something: 401, 403, 429, 5xx and any other unexpected status, plus network errors and timeouts.
- Not saved: answers the plugin already treats as normal (404 where allowed, 200).
- Hooked in at the single request functions per provider: claude.ai (`src/api.ts`), ChatGPT (`src/chatgpt/api.ts`, both `requestUrl` and `loginFetch` paths), and the page-side requests of Gemini, Lumo and AI Studio where status and text come back. Codex cloud and desktop sources only log their error message (no HTTP answer to keep).

## Safety (my call, not optional)

"Whole answer" still never includes secrets: before saving, the existing cleaners (`redact`, `maskSecrets`) remove cookies, session keys, bearer tokens and login keys from body and headers; `Set-Cookie` and `Authorization` header values are replaced with `[hidden]`. Request headers are not saved. A unit test checks that a session answer carrying an access token is saved without it.

## Approaches considered

1. Plugin-folder file (chosen): survives restarts, stays out of search, graph and notes, does not bloat settings.
2. Notes in `_ai-chatbridge-diagnostics`: visible without settings, but full answers would land in search, graph and sync.
3. `data.json`: simplest, but big HTML pages would be rewritten on every settings save, against the "no secrets in data.json" rule.

## Non-goals

- No automatic upload to GitHub, no sending anywhere.
- No change to sync behaviour: logging never stops or slows a sync; a failure to write the log is ignored.
- Not on phones for providers that cannot sync there anyway; the tab still shows what the device has.

## Left to the builder

Exact tab icon, module names, the entry layout in the tab, test placement (a new `npm run test:error-log` joined into `test:ci`), FEATURES.md lines (new section) and CHANGELOG "Unreleased".
