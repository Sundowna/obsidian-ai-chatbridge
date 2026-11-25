# Error logs tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every failed request of every provider is saved (whole answer, secrets removed) per account, shown in a new **Error logs** settings tab with Copy / Copy all / Clear.

**Architecture:** One module `src/error-log.ts` holds the entries in memory, cleans them, caps them and saves them to `<plugin dir>/error-log.json`. Provider request functions call one function, `recordError(source, entry)`, when an answer is not one they accept. The tab only reads the store.

**Tech Stack:** TypeScript, Obsidian API (`DataAdapter`, `Setting`), esbuild test scripts with the existing `expect` style.

**Spec:** `docs/superpowers/specs/2026-11-25-error-logs-design.md`

## Global Constraints

- File: `<manifest.dir>/error-log.json`, written with `app.vault.adapter`; never `data.json`, never a note.
- Last **20** entries per account; body cut at **64 KB** (65 536 chars) with the line `… cut, N KB more`.
- Tab label **Error logs**, placed after General, icon `bug`.
- Warning at the top, verbatim: "Remove all personal data (email addresses, names, chat titles and chat text) before you paste this into a GitHub issue. Cookies and login keys are removed automatically."
- Empty state, verbatim: "No errors saved for this account."
- Saving never throws into a sync and never awaits on the sync's path (fire and forget, errors swallowed).
- Request headers are never saved. Response headers `set-cookie`, `authorization`, `cookie` → value `[hidden]`.
- Every check in `npm run test:ci` that passes today (911 PASS) still passes.

## Review Focus

1. A ChatGPT `/api/auth/session` answer or page HTML containing `accessToken` / a JWT → saved without the key (test in Task 1).
2. A Claude answer that echoes `sessionKey=…` or the raw session key → saved as `[hidden]` (Task 1).
3. Writing the file fails (read-only folder, mobile adapter error) → sync result unchanged, no exception (Task 1).
4. Account removed or renamed → entries of a removed account dropped on next save; rename keeps entries (keyed by id) and shows the new label (Task 1, Task 4).
5. Body is binary/protobuf (`application/proto`) → saved as `[binary, N bytes]`, not mojibake (Task 1).

---

### Task 1: Error log store and cleaning

**Files:**
- Create: `src/error-log.ts`
- Create: `scripts/test-error-log.ts`
- Modify: `package.json` (add `test:error-log`, same esbuild line as `test:computers`; append `&& npm run test:error-log` to `test:ci`)

**Interfaces:**
- Produces:
  - `type ErrorProvider = 'claude' | 'chatgpt' | 'lumo' | 'gemini' | 'studio' | 'codex'`
  - `interface ErrorSource { provider: Provider; accountId: string }` (`Provider` from `login.ts`; AI Studio and Codex entries use their account's provider and set `service`)
  - `interface ErrorInput { service: string; method: string; url: string; status: number | null; headers?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string; message?: string; secrets?: (string | null | undefined)[] }` — `status: null` = network error / no HTTP answer
  - `interface ErrorEntry { at: string; service: string; method: string; url: string; status: number | null; headers: Record<string, string>; body: string; bodyBytes: number; message: string; env: string }`
  - `function cleanText(text: string, secrets: (string | null | undefined)[]): string`
  - `function recordError(source: ErrorSource | undefined, input: ErrorInput): void` — no-op without source or before `initErrorLog`
  - `function initErrorLog(adapter: DataAdapter, dir: string | undefined, env: string): Promise<void>`
  - `function errorEntries(source: ErrorSource): ErrorEntry[]` (newest first)
  - `function clearErrors(source: ErrorSource): Promise<void>`
  - `function pruneErrors(keep: ErrorSource[]): Promise<void>`
  - `function entryMarkdown(e: ErrorEntry, accountTitle: string): string`
  - `function onErrorLogChange(cb: () => void): () => void`

- [ ] **Step 1: Write failing tests** in `scripts/test-error-log.ts` (`expect(label, ok)` style as `test-computers.ts`, in-memory adapter stub with `exists/read/write`):
  - `cleanText` hides: a passed secret (`'sk-abc…'` → `[hidden]`), `sessionKey=xyz` → `sessionKey=[hidden]`, a JWT `eyJ…`, `"accessToken":"…"` value, `Bearer abc…`; keeps a UUID `0b3c…-…` and `cf-ray: 8f2a1c3b9d4e5f60-FRA` unchanged.
  - `recordError` with headers `{ 'Set-Cookie': 'a=b', 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' }` saves `set-cookie: [hidden]`, keeps the other two.
  - 25 records for one account → 20 kept, newest first; another account unaffected.
  - body of 70 000 chars → `body.length` ≤ 65 536 + marker, ends with `… cut, 5 KB more`, `bodyBytes === 70000`.
  - `ArrayBuffer` body with `contentType: 'application/proto'` → body `[binary, N bytes]`.
  - adapter whose `write` throws → `recordError` does not throw, entry still in memory.
  - `initErrorLog` on a second adapter reading the written file restores entries; a corrupt file → starts empty.
  - `pruneErrors([a])` drops account b.
  - `entryMarkdown` contains `GET https://chatgpt.com/backend-api/conversations → **403**`, a fenced headers block and a fenced body block (`json` fence for JSON content type, `html` for HTML, plain otherwise); a status `null` entry shows `→ **no answer**` plus the message.

- [ ] **Step 2: Run** `npm run test:error-log` — expected: build error / FAIL (module missing).

- [ ] **Step 3: Implement `src/error-log.ts`.** Secrets cleaning: split-join every passed secret (length ≥ 8), then regexes for `sessionKey=`, `__Secure-next-auth.session-token[^=]*=`, JWT (`eyJ[\w-]+\.[\w-]+\.[\w-]+`), `"(accessToken|access_token|token|sessionToken|refresh_token)"\s*:\s*"[^"]*"`, `Bearer\s+\S+`. Do not use `maskSecrets`' blanket 24-char rule (it would hide IDs needed for a report). Save debounced (500 ms) with `adapter.write(path, JSON.stringify(file))`, `file = { version: 1, accounts: { "<provider>:<id>": ErrorEntry[] } }`. `env` = `AI ChatBridge <version> · Obsidian <apiVersion> · <OS>` built by the caller.

- [ ] **Step 4: Run** `npm run test:error-log` — all PASS.

- [ ] **Step 5: Commit** `Error log store: whole answers per account, secrets removed, capped`.

### Task 2: Claude and ChatGPT record their failed answers

**Files:**
- Modify: `src/api.ts` (`ClaudeApi` constructor gets optional 3rd param `source?: ErrorSource`; record in `request`, `rpc` (non-200), `memory`; record network errors), `probeOrganizations` unchanged (test only, no account)
- Modify: `src/chatgpt/api.ts` (`GptApi.connect(login, fallback)` sets `source = { provider: 'chatgpt', accountId: login.id }`; record in `request`, `loginPage`, `sandboxBytes`, `fileBytes` non-200; `secrets` = cookie values + token)
- Modify: callers of `new ClaudeApi(` in `src/sync.ts`, `src/memory/sync.ts`, `src/project-list.ts`, `src/diagnose.ts` to pass `{ provider: 'claude', accountId: account.id }`
- Modify: `src/main.ts` `onload`: `await initErrorLog(app.vault.adapter, manifest.dir, env)`; after settings saves that remove an account, `pruneErrors(...)`
- Test: `scripts/test-claude-sync.ts`, `scripts/test-chatgpt-sync.ts`

**Interfaces:**
- Consumes: `recordError`, `ErrorSource`, `errorEntries` from Task 1.

- [ ] **Step 1: Failing tests.** In `test-claude-sync.ts`: stubbed `requestUrl` answering 403 with JSON body `{"code":"permission_denied", …}` to `ReadConversation` → after the run `errorEntries({provider:'claude',accountId})` has 1 entry, status 403, body contains `blocked_by_org_tier`, no session key text. In `test-chatgpt-sync.ts`: 403 with `content-type: text/html`, `cf-mitigated: challenge`, body `<title>Just a moment...</title>` on `/backend-api/conversations` → entry with those headers and body; the existing stop message is unchanged; a 200 run records nothing; a 404 with `notFoundOk` records nothing.
- [ ] **Step 2: Run** `npm run test:claude && npm run test:sync` — new checks FAIL.
- [ ] **Step 3: Implement** the `recordError` calls just before each existing `throw`/`return null` for a non-accepted status. Stop texts stay exactly as they are.
- [ ] **Step 4: Run** `npm run build && npm run test:ci` — all PASS (911 + new).
- [ ] **Step 5: Commit** `Claude and ChatGPT: failed answers go to the error log`.

### Task 3: Gemini, AI Studio, Lumo and Codex cloud record theirs

**Files:**
- Modify: `src/gemini/api.ts`, `src/studio/api.ts`, `src/lumo/api.ts`: page code returns `headers: Object.fromEntries(r.headers)` too; `connect` keeps `source` from `login`; record on every non-accepted status, on the network-error catch (`status: null`) and on "did not open signed in" (`status: null`, message). Studio uses `service: 'AI Studio'`, provider `gemini`.
- Modify: `src/cloud/codex-sync.ts` (or where Codex cloud errors become a stop): `recordError` with `status: null`, `service: 'Codex cloud'`, message only.
- Test: `scripts/test-gemini.ts`, `scripts/test-lumo.ts`, `scripts/test-codex-cloud.ts`

- [ ] **Step 1: Failing tests:** a fake page answering `{status:403,text:'…',headers:{…}}` → one entry per provider with status 403 and the body; Lumo body `{"Error":"…"}` kept whole; Codex cloud refused connection → entry with status `null` and the stop message.
- [ ] **Step 2: Run** the three test scripts — new checks FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build && npm run test:ci` — all PASS.
- [ ] **Step 5: Commit** `Gemini, AI Studio, Lumo, Codex cloud: failed answers go to the error log`.

### Task 4: Error logs settings tab

**Files:**
- Create: `src/ui/error-logs-tab.ts` — `export function errorLogsTab(ctx: PanelContext, el: HTMLElement, state: { key: string }): void`
- Modify: `src/ui/settings-tab.ts` (`Tab` gains `'errors'`; button after General, label "Error logs", icon `bug`; keeps selected subtab in `state` across redraws; subscribes `onErrorLogChange` while open and redraws only this tab)
- Modify: `styles.css` (warning callout `ccs-errorlog-warning`, entry block `ccs-errorlog-entry`, monospace `pre` with max-height 20em and scroll; light and dark)
- Test: `scripts/test-error-log.ts` (`errorLogAccounts(settings)` helper)

**Interfaces:**
- Produces: `function errorLogAccounts(s: Settings): { source: ErrorSource; title: string; count: number }[]` in `src/error-log.ts` — every account of every provider in settings order, title `"<Provider> · <label>"`.

- [ ] **Step 1: Failing test:** `errorLogAccounts` lists Claude, ChatGPT, Lumo, Gemini accounts in order with counts; renamed label shows new title with old entries.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the helper and the tab: warning callout (verbatim text) at top; account pills (`ccs-account-pill`, `is-active`, `aria-selected`, count badge); per account **Copy all** (all entries' Markdown joined, newest first) and **Clear** (ConfirmModal, warning tone); per entry: summary line `time · METHOD url → status`, `env`, collapsible `<details>` with headers and body `pre`, **Copy** button; copy via `navigator.clipboard.writeText` with Notice "Copied – remove personal data before pasting."; empty state verbatim.
- [ ] **Step 4: Run** `npm run build && npm run test:ci && npm run lint` — PASS, no new lint warnings.
- [ ] **Step 5: Commit** `Error logs tab: per account, whole answers, copy for GitHub issues`.

### Task 5: Ledger, changelog, PR

**Files:** `FEATURES.md` (new section "14. Error logs" with lines for store, cleaning, cap, each provider's recording, tab, copy, clear, warning; tab list line in section 4 gains "Error logs"), `CHANGELOG.md` "## Unreleased", the spec and plan files.

- [ ] **Step 1:** Write the ledger lines, each naming `npm run test:error-log` or the provider test that covers it.
- [ ] **Step 2: Run** `npm run build && npm run test:ci && npm run lint`; compare PASS count with baseline 911 (must be ≥ 911 + new, no FAIL, no ledger line removed: `git diff origin/main -- FEATURES.md | grep '^-- \['` is empty).
- [ ] **Step 3: Commit**, push `claude/error-logs`, open PR against main ("Refs #48, #46"; body says it needs a manual look in Obsidian for the tab's look in light and dark).
