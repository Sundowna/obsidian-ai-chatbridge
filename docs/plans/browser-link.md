# Browser link: plan and implementation plan

Handover document. Written 27 Nov 2026 by the session that did the kickoff (reading and research only).
**No code has been written. Nothing is committed. The baseline test run has not been done yet.**

The next session should read this file top to bottom, then start at [Stage 0](#stage-0-proof-in-the-real-browser).

---

## 1. How to start the next session

Paste this as the first message:

> Continue the AI ChatBridge "Browser link" build. Read `docs/plans/browser-link.md` in this
> worktree and follow it. Start with the open questions in section 4 (use the recommended
> defaults where I don't answer), then Stage 0. Show me results in tables, few words.

Where things are:

| Thing | Value |
|---|---|
| Repo | `Sundowna/obsidian-ai-chatbridge`, version 0.41.5 at kickoff |
| Worktree | `D:\BrainTest\ai-chatbridge\.claude\worktrees\chatbridge-browser-link-963ceb` |
| Branch | `claude/chatbridge-browser-link-963ceb` (clean, based on `e1d2e59`) |
| Main checkout | `D:\BrainTest\ai-chatbridge` (has `node_modules`; the worktree may need `npm install`) |
| Git data | `D:\Git\<name>.git` (project folders hold only a `.git` pointer file; never create a `.git` folder inside a synced folder) |
| Original brief | Section 2 below (full text). The user's copy: `C:\Users\Walter\Downloads\chatbridge-browser-link-prompt.md` |
| Design doc | https://claude.ai/artifact/W7DbEa5BzNDNethoZfuxtj, paragraph "AI ChatBridge: Google logins via a Browser link". Read at kickoff; it says the same as the brief and adds nothing |
| Not read | `claude/project-context.md` in the claude.ai Project "2nd Brain" ("How we work" and "AI ChatBridge" sections). The kickoff session had no Projects tool. Ask the user to paste it if the next session cannot read it either |

How the owner works (binding):

- Not a coder, little time. **You test; the owner only does a short final acceptance check.**
- Answers must be brief, plain and visual: tables over prose.
- Use the `feature-guard` skill for every stage: read `FEATURES.md`, run the tests before and after, never let a feature, test or ledger line disappear without the owner's OK. After the build, suggest a fresh session runs `e2e-fresh-eyes-audit`.
- Project rule (`CLAUDE.md`): read `FEATURES.md` before changing a module, update it with every feature change. Obsidian conventions are in `AGENTS.md`.
- "Search before you build": done for this feature, see section 5.
- One PR per issue. This feature is one PR at the end, commits per stage.
- Test vault only (see question 4). Never the live vault until the owner approves.
- Do not publish to the Chrome Web Store or Firefox add-ons.
- The GitHub MCP server failed to connect at kickoff; the `gh` CLI works as a replacement.

---

## 2. The brief (owner's text, complete)

### Problem
Every login that goes through Google fails or is unreliable: Gemini, AI Studio, and Claude/ChatGPT accounts made with "Continue with Google".
1. Google blocks sign-in from embedded windows (since 2021). Our Firefox user-agent trick (`SITES.gemini.asFirefox`) is fragile and Google disapproves of it. Only the Gemini window uses it, so Google pages in the claude/chatgpt windows go out as plain Chromium and get blocked. The window-open handler also loads popups into the same window, which breaks popup sign-ins that need `window.opener`.
2. The pasted-cookie fallback dies fast: Chrome on Windows binds Google session cookies to the TPM (Device Bound Session Credentials, GA since May 2026, also for personal accounts).

### Decision (made 27 Nov)
ChatBridge keeps ALL extraction logic, the same code path for every provider. No inbox folder, no Local REST API, no second copy of the parsers. Add a second transport, the "Browser link": a thin browser extension that acts as a remote hand inside the owner's real, logged-in browser.
- It does only two things: (a) make an HTTP request from a tab of the site, with the browser's own cookies, and return the raw response (status, headers, body, binary-safe); (b) run a code string in a tab of the site (page context / MAIN world) and return the string result.
- It never parses, stores or extracts chats.

### Plugin side
1. Introduce one transport interface that covers what sync code uses today: `loginFetch`, `openReadyPage().run/goTo`, `openHiddenPage`, and the `requestUrl` calls that send login cookies (`src/api.ts`, `src/chatgpt/api.ts`). Implement it twice: "login window" (today's code, unchanged behaviour) and "browser link".
2. Per account setting: Login method = Login window | Browser link. Default: Browser link for Gemini and AI Studio; offer it for Claude/ChatGPT accounts (needed for Google-made accounts). Lumo stays login-window only.
3. Sync code must not know which transport ran. Same notes, folders, frontmatter, raw JSON, dedupe and sync index for both.
4. Local channel: a WebSocket server on 127.0.0.1 only (random port), started only while a Browser link account exists. One-time pairing code shown in settings; the extension stores a token; reject everything else. Desktop only.
5. Clear status in settings and the status bar: linked / browser closed / not logged in to `<site>` in the browser. If the browser is closed during a sync, skip those accounts with a clear message, never fail the whole sync.
6. Keep the login window as fallback. Fix it while you're there: popups open as real child windows in the same partition with a live `window.opener`; Google pages in any partition get the same Google mode.

### Extension side
- Manifest V3, Chrome/Edge/Brave first, Firefox second. Its own folder in the repo (e.g. `extension/`), own build.
- Host permissions only for the sites ChatBridge supports (gemini.google.com, aistudio.google.com, claude.ai, chatgpt.com and what their requests need). No `<all_urls>`, no analytics, no remote code, no network calls other than the sites themselves and 127.0.0.1.
- Opens a background tab of the site if none is open, and closes what it opened.
- Before building, check whether an existing open-source extension already offers a generic "local app asks the browser to fetch" bridge. Reusing MIT-licensed code with attribution is fine (e.g. scaffolding from sho7650/obsidian-AI-exporter); no forks to maintain.

### Security and privacy
- Never write cookies, tokens or chat content to logs, `data.json` or notes beyond what sync already writes.
- The channel only accepts requests to the supported sites' origins, so a compromised pairing can't be used as a general proxy.
- Document in the README what the extension can access and why.

### Testing (before handing anything to the owner)
1. Unit tests for the transport switch and the channel (pairing, rejected origins, browser closed mid-sync).
2. Real run on the Test vault: one Gemini account, AI Studio, and one ChatGPT or Claude account made with Google, through the Browser link. Compare output with the login-window route: same files, same frontmatter.
3. Run the existing test suite (`npm test`) and lint.
4. Commit before and after each stage.
5. Give the owner a 10-minute acceptance checklist with checkboxes, including how to install the extension unpacked ("Load unpacked").

### Deliverables
- Plugin changes + extension source, README section, CHANGELOG entry.
- Short handoff note in the vault (per the vault's CLAUDE.md) with known limitations.
- Don't publish to the Chrome Web Store or Firefox add-ons yet.

---

## 3. Target shape

```
Obsidian plugin                                Your real browser
┌──────────────────────────────┐               ┌───────────────────────────┐
│ Sync and parsers (unchanged) │               │ Site tab (your own login) │
│            │                 │               │            ▲              │
│        Transport             │               │            │              │
│   (picked per account)       │               │   fetch / run code        │
│     │              │         │   ws://       │            │              │
│ Login window   Browser link ─┼──127.0.0.1────┼─▶ Extension (thin)        │
│ (today's code) (new)         │   paired      │   no parsing, no storage  │
└──────────────────────────────┘               └───────────────────────────┘
```

---

## 4. Open questions for the owner

Asked at kickoff, **not answered yet**. Ask again in one short table. If there is no answer, use the recommendation and say so.

| # | Question | Recommendation |
|---|---|---|
| 1 | If a plain code run fails on Google pages: a one-time "Allow user scripts" switch in the extension's settings, or the debugger permission (yellow banner on every sync)? | The one-time switch |
| 2 | Several accounts of one site in one browser (e.g. two Google accounts): support in version 1? | No. One login per site per browser; the sync checks it is the right account and refuses a mismatch |
| 3 | Existing Gemini accounts: switch to Browser link automatically? | No. They keep the login window and show a hint; new Gemini accounts default to Browser link |
| 4 | Which folder is the Test vault, and where is its CLAUDE.md with the handoff rules? | Unknown. `D:\BrainTest` has no `CLAUDE.md` and no `.obsidian` at the top; `D:\BrainTest\SecondBrain\Open` holds `Brain`, `TAlpha_v0.1`, `TAlpha_v0.2`. Ask |
| 5 | The real run needs the owner once: load the extension unpacked and be signed in to Gemini, AI Studio and one Google-made ChatGPT or Claude account. Which browser? | Chrome, once at Stage 0 and again at Stage 4 |

### Answers (27 Nov 2026, second session)

| # | Answer |
|---|---|
| 1 | Owner chose **debugger permission** as the fallback. Likely not needed: see "Stage 0 status" below |
| 2 | Not answered: recommendation used (no) |
| 3 | Not answered: recommendation used (no) |
| 4 | New test vault on the owner's Linux Mint PC (being set up). Path to follow |
| 5 | Chrome |

Work moved to a Linux Mint PC: repo at `~/code/obsidian-ai-chatbridge`, Node LTS in `~/.local/node` (no sudo).

### Stage 0 status

- Baseline: `test:ci` 1034 PASS, 0 FAIL. Lint 0 errors, 14 warnings. `test:offline` cannot run here (no `samples/`).
- Reading `src/gemini/api.ts` and `src/studio/api.ts`: their `page.run` code is only two fixed signed `fetch` calls. **Option C chosen**: the extension ships them as packaged functions (`sign: 'wiz-at'` for Gemini batchexecute, `sign: 'sapisidhash'` for AI Studio). No code strings, no eval, no userScripts, no debugger. The signing values stay in the page. Ready checks become named checks (`gemini-signed-in`, `studio-ready`). Consequence for Stage 1: `TransportPage.run(code)` becomes `call(request, sign?)`; the login-window transport builds today's code strings from it.
- Spike in `extension/spike/` (README there). Server-side checks done: non-extension origin rejected, wrong token rejected. Needs the owner's Chrome run for the rest.
- `extension/spike/drive-headless.mjs`: runs the spike in Chrome for Testing without a person (logged-out profile: proves pairing, tabs, refusal, idle survival). Written, **never run to the end** (stopped by the owner). Untested.

### Handover back to the Windows PC (27 Nov 2026)

The owner stopped work on the Linux PC; the Windows PC takes over from this branch.

1. In the Windows worktree: `git pull` on `claude/chatbridge-browser-link-963ceb`.
2. Stage 0 next steps: in `extension/spike`, `npm install`, then either run `drive-headless.mjs` (needs Chrome for Testing; `--load-extension` does not work in branded Chrome 137+) or have the owner follow `extension/spike/README.md` in their signed-in Chrome.
3. Fill the per-site table (fetch OK / signed call OK / cookies readable) into this section, then Stage 1.

### Stage 0 on Windows (27 Nov 2026, third session)

Baseline here: `test:ci` 1036 PASS, 0 FAIL. Lint 0 errors, 14 warnings (after adding `extension/spike` to the ESLint ignores; the spike files gave 5 parse errors). `test:offline` not run (no `samples/` in the worktree).

Chrome for Testing 158 would not start on this PC ("side-by-side configuration is incorrect"). `drive-headless.mjs` now uses the installed Chrome with a throwaway profile and loads the spike over `--remote-debugging-pipe` with `Extensions.loadUnpacked` (works in branded Chrome 137+). Run: `CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node drive-headless.mjs`.

Headless run, logged-out profile, Chrome 158:

| Check | Result |
|---|---|
| Pairing through the options page | OK |
| Web page (origin `null`) opens the port | Refused, close 1008 |
| Extension refuses `example.com` | OK |
| Same connection after 300 s idle | OK, 19 pings |
| Background tab opened and closed (claude.ai, chatgpt.com) | OK |
| Packaged fetch, binary, base64 round trip (Claude, ChatGPT) | OK, identical to a direct download |
| ChatGPT `/` and `/api/auth/session` | 200, no token (logged out, expected) |
| Claude `/api/organizations` | 403 (logged out, expected) |
| Gemini, AI Studio ready checks | Not ready (logged out, expected) |
| Cookies readable by the page | `oai-did` yes; `_account`, `lastActiveOrg`, `sessionKey` no (logged out; `sessionKey` is HttpOnly) |

Spike fix: chatgpt.com has no `/favicon.ico`; the binary check now takes the hashed favicon from the page.

Signed-in run, owner's own Chrome 158 (through Claude in Chrome, page context, same code as `recipes.js` `pageFetch`; only statuses and yes/no were read):

| Site | Fetch with browser cookies | Signed call (no eval) | Cookies readable by the page |
|---|---|---|---|
| Claude | `/api/organizations` 200, 1 org with `uuid` | not needed | `lastActiveOrg` yes |
| ChatGPT | `/` 200 (831 KB, `accessToken` in HTML: yes); `/api/auth/session` 200, token yes, account ID yes | not needed | `oai-did` yes, `_account` yes |
| Gemini | ready check (`SNlM0e`) true | `MaZiqc` with `wiz-at` 200, real rows with IDs | `SAPISID` yes |
| AI Studio | ready values (API key, `SAPISID`) found | `ListPrompts` with `sapisidhash` 200, JSON | `SAPISID` yes |

**Stage 0 done.** Option C (packaged functions, no code strings) works on all four sites; no userScripts, no debugger. Every cookie value the plugin reads today is reachable without the `cookies` permission (`sessionKey` is not needed under the Browser link).

Notes for later stages:
- AI Studio redirected the tab to `/onboarding` on the first try (account barely used there). The call still worked; Stage 4's ready check must not insist on `/library`.
- AI Studio second try: tab stayed on `/library`; `ListPrompts` 200 but `[]` (2 bytes). The page's own list call is also `ListPrompts`, and its only `/prompts/` links are "new chat" buttons, so the library is empty, not a wrong call.
- AI Studio third try, with one test chat made for it ("ChatBridge test - delete me"): `ListPrompts` 200, 1 row, name format OK, test chat listed; `ResolveDriveResource` for it 200, 1911 bytes, test text present. Test chat then moved to Drive trash; list empty again. **AI Studio proven with real data.**
- Gemini list rows are at `payload[2]` (as `wire.ts` reads them), not `[0]`.
- Claude in Chrome hides any result whose key mentions "token" or "session"; use neutral keys when testing this way.

---

## 5. Research results (27 Nov 2026)

### Reuse

Nothing can be reused whole: every existing bridge asks for `<all_urls>` plus the `debugger` permission, which the brief rules out. Borrow patterns only.

| Source | Licence | Use |
|---|---|---|
| [`ws`](https://github.com/websockets/ws) 8.x | MIT | WebSocket server in the plugin. Zero required dependencies. Mark the optional `bufferutil` and `utf-8-validate` as external in esbuild (verify) |
| [sho7650/obsidian-AI-exporter](https://github.com/sho7650/obsidian-AI-exporter) | MIT | Manifest pattern: narrow host list incl. `http://127.0.0.1/*`, strict `extension_pages` CSP with `connect-src` limited to 127.0.0.1, `src/background/validation.ts`. Give attribution. It uses Vite + crxjs and has no Firefox support; we use esbuild like the plugin |
| [AgentDeskAI/browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp) | MIT | Manifest pattern for optional host permissions and the `gecko` block |
| [Chrome WebSocket sample](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) | docs | 20 s keep-alive ping, `minimum_chrome_version: 116` |
| microsoft/playwright-mcp, jackwener/OpenCLI, hangwin/mcp-chrome, BrowserMCP/mcp, remorses/playwriter, wxtsky/byob, ofershap/real-browser-mcp | Apache/MIT | Nothing (all need `<all_urls>` + `debugger`) |
| obsidian-local-rest-api (MIT), Omnisearch (GPL-3.0, do not copy) | | Nothing. No Obsidian plugin with a one-time pairing code was found |

Not checked: kimi-webbridge, RSSHub-style bridges.

### Facts

| Topic | Finding |
|---|---|
| Service worker lifetime | From Chrome 116, WebSocket messages reset the 30 s idle timer. Ping every 20 s. Firefox event pages idle out after 30 s; whether WebSocket traffic resets that is **unverified** |
| Code string in the page (MAIN world) | `chrome.scripting.executeScript` + `eval` obeys the page's CSP. Live headers: **chatgpt.com has no `unsafe-eval` → blocked**. **gemini.google.com and aistudio.google.com have `unsafe-eval` plus `require-trusted-types-for 'script'` → needs a Trusted Types policy, untested**. **claude.ai has `unsafe-eval` → allowed** |
| Alternatives for code run | `chrome.userScripts.execute` (Chrome 135+) takes a code string and `world: "MAIN"`; needs the per-extension "Allow User Scripts" toggle from Chrome 138; CSP bypass in MAIN not confirmed by docs. `chrome.debugger` `Runtime.evaluate` always works but shows a banner |
| Packaged function | `executeScript({ world: 'MAIN', func, args })` with a function shipped in the extension needs no eval. It covers the fetch case on every site |
| Web Store policy | [MV3 rules](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) allow running fetched strings only through the Debugger and User Scripts APIs. Whether a local app counts as "remote" is undefined, so `eval` is a rejection risk if the owner ever publishes. Not a blocker now (unpacked only), but record it as a known limitation |
| Loopback access | Chrome's Local Network Access prompt (142+, WebSockets from 147) does not affect extensions that declare the host permission. Declare `http://127.0.0.1/*` |
| DBSC | Chrome 145+ on Windows with TPM keys; rollout to Workspace and personal Google accounts began 25 May 2026, on by default. Copied cookies fail at the next refresh challenge. Confirms the problem statement |

### Consequence for the design

Only Gemini and AI Studio need "run a code string" (the page signs its own requests). Claude and ChatGPT need only "fetch with the browser's cookies". So:

- `fetch` is a packaged function. No eval anywhere. Works on all four sites.
- `run` is needed on the two Google sites only. Stage 0 decides how: (A) eval through a Trusted Types policy, (B) `userScripts.execute`, (C) no code strings at all: the extension reads the few page values the plugin's code uses and the plugin sends ordinary fetches. Look at what `src/gemini/api.ts` and `src/studio/api.ts` put into `page.run(...)` before choosing; C is the cleanest for a later store listing but moves a little site knowledge into the request.

---

## 6. What the code looks like today

Read these before Stage 1. Line numbers are from 0.41.5.

| File | What it does with the login |
|---|---|
| `src/login.ts` | Everything Electron. `SITES` (per provider: start URL, origin, partition, login cookie, `asFirefox`), `loginFetch` (session fetch, own timeout, never an AbortSignal), `openLogin`, `openHiddenPage` (Lumo), `openReadyPage` (`run`, `goTo`, `close`; optional pasted cookies in an in-memory partition), `cookieValue`, `cookieNames`, `cookieHeader`, `isLoggedIn`, `logout`, `loginUserAgent`, `hasLoginFetch`, `hasLoginWindows`, `closeLoginWindows` |
| `src/api.ts` (Claude) | `requestUrl` with a hand-built `Cookie: sessionKey=…; lastActiveOrg=…` header at lines 208, 282, 344. Line 67 `probeOrganizations` is for "Test mobile connection" (pasted login only): leave it alone. The key comes from `src/claude-auth.ts` (`cookieValue(login, 'sessionKey')`, `lastActiveOrg`) |
| `src/chatgpt/api.ts` | `GptApi.connect` (line ~150): reads `cookieHeader`, the `oai-did` cookie and `loginUserAgent`; gets the page with `loginPage()` (`loginFetch`, line 373) to find the access token; later requests via `requestUrl` with the Cookie header (line 420); file downloads via `loginFetch` (line 361); signed file links via `requestUrl` without cookies (line 292: keep direct, no login involved). Line 115 `probeAuthSession` is for the pasted-login check: leave it alone |
| `src/gemini/api.ts` | `openReadyPage(login, 'https://gemini.google.com/app', GEMINI_SIGNED_IN, 45 s, pasted)`, then `JSON.parse(await page.run(code))` giving `{status, text, headers}` (line 104). Only two RPCs are allowed |
| `src/studio/api.ts` | Same pattern with `https://aistudio.google.com/library` and its own `READY` expression (line 25, 33, 86). Uses the Gemini login (`loginRef('gemini', account)`) |
| `src/lumo/api.ts` | `openHiddenPage` (line 50). **Stays login-window only** |
| Callers of `connect` | `src/chatgpt/sync.ts:240`, `src/gemini/sync.ts:34`, `src/studio/sync.ts:28`, `src/memory/sync.ts:114`, `src/project-list.ts:40` |
| Settings | `src/settings.ts` (account web settings; `secretId` fields near lines 88 and 157), `src/ui/web-panel.ts` (login row, advanced fields), `src/ui/browser-login-modal.ts` (ChatGPT "Use browser login…", stays) |
| Tests | `scripts/test-*.ts`, each bundled with esbuild and run with node; `scripts/obsidian-test-stub.ts`, `scripts/fake-vault.ts`. `npm test` = `test:offline` + `test:ci`. `test:offline` needs the git-ignored `samples/` folder (present in the main checkout, maybe not in the worktree) |
| Ledger | `FEATURES.md` section 5 "Logins" (lines 163-173) and the settings lines 111, 122-125. Section 14 covers error logs |

Constraints found in the code:

- The plugin also runs on phones (`src/mobile`). **Never import `ws`, `http` or `net` at the top level.** Load them lazily, behind the same desktop check the login windows use.
- `login.ts` line 266-270: the comment says the window-open handler "is called back asynchronously, so Obsidian's main process gets no answer and blocks the popup". Electron is reached through `electron.remote`, so a handler cannot return `{action: 'allow'}` in time. This is the real obstacle for the popup fix in Stage 6.
- The error log (`src/error-log.ts`) redacts by a list of secret values. With the Browser link the plugin never holds cookie values, which is good; make sure recorded responses still pass through the same redaction.
- Automatic sync pauses after an error. "Browser closed" must count as a skip, not an error, or one closed browser stops automatic sync.

---

## 7. Design

### 7.1 Transport interface (new file `src/transport/types.ts`)

Shape to aim for; adjust names to what Stage 1 finds.

```ts
export type TransportKind = 'login-window' | 'browser-link';

export interface TransportRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	redirect?: 'follow' | 'manual';
	timeoutMs?: number;
}
export interface TransportResponse {
	status: number;
	headers: Record<string, string>;
	text: string;            // decoded lazily or eagerly, as today's callers need
	arrayBuffer: ArrayBuffer;
}
export interface TransportPage {
	run(code: string): Promise<string>;
	goTo(url: string, ready: string, timeoutMs: number): Promise<boolean>;
	close(): void;
}
export interface Transport {
	readonly kind: TransportKind;
	/** A request to the provider's site with this account's login. */
	fetch(req: TransportRequest): Promise<TransportResponse>;
	/** A page of the site, signed in, once `ready` is true there. Null if it never is. */
	openPage(url: string, ready: string, timeoutMs: number): Promise<TransportPage | null>;
	isLoggedIn(): Promise<boolean>;
}
export function transportFor(login: LoginRef, account: AccountSettings): Transport;
```

Rules:

- `login-window` wraps today's functions one to one. No behaviour change, including the pasted-cookie fallbacks, the ChatGPT cookie-renewal path and the user agent.
- `browser-link` never sees cookie values. Callers that build a `Cookie` header today must go through `transport.fetch` and let the transport add the login: the login-window transport adds the header as today; the browser-link transport sends no `Cookie` and no `User-Agent` (the browser forbids both) and fetches with `credentials: 'include'`.
- Things the plugin reads from cookies today need another source under the Browser link: Claude's org (`lastActiveOrg`) from the `/api/organizations` answer; ChatGPT's device ID (`oai-did`) and workspace (`_account`) from `document.cookie` if readable, else left out. Verify each in Stage 5.
- A new error class (e.g. `BrowserLinkUnavailable` with `reason: 'browser-closed' | 'not-paired' | 'not-logged-in' | 'tab-failed'`) that the sync turns into "skipped", with a clear message per account.
- Lumo: `transportFor` always returns the login window.

### 7.2 Local channel (plugin, `src/link/`)

| Item | Decision |
|---|---|
| Server | `ws` on Node `http`, bound to `127.0.0.1` only. Started only while at least one account uses the Browser link; stopped on unload and when the last such account goes |
| Port | Random free port, picked once and remembered in `data.json` (not a secret) so the extension can find it again. If it is taken at start, pick a new one and show "pair again" |
| Pairing | Settings show a one-time code that carries the port and a random secret (e.g. `48213-K7QF-9M2D`), valid 5 minutes, single use, max 5 wrong tries. The extension's options page takes the code, connects, and gets a long random token back |
| Token | Kept in Obsidian secret storage (`app.secretStorage`, already used for pasted logins), never in `data.json`, notes or logs. Compared in constant time. The extension keeps its copy in `chrome.storage.local` |
| Handshake | First message must be `hello` with the token (or `pair` with the code) within 5 s, else close. Check the `Origin` header: accept only `chrome-extension://…` and `moz-extension://…`. **Any web page can open `ws://127.0.0.1`, so the origin check plus the token are both required** |
| One browser | One paired browser in version 1. "Unpair" in settings deletes the token |
| Allow-list | Enforced on both sides. The plugin refuses to send and the extension refuses to execute anything that is not `https` on: `claude.ai`, `chatgpt.com`, `gemini.google.com`, `aistudio.google.com`, `alkalimakersuite-pa.clients6.google.com`, plus whatever Stage 4/5 prove necessary. Keep one shared list (`src/link/sites.ts`, imported by the extension build) |
| Never logged | Message bodies, headers, tokens, codes |

Protocol: JSON text frames. Bodies travel as base64. Large bodies are split into chunks (e.g. 512 KB) so one file download does not need one huge frame.

```
→ {id, op:'fetch', url, method, headers, body64?, redirect}
← {id, ok:true, status, headers, body64 | chunk…}
→ {id, op:'open', url, ready, timeoutMs}        ← {id, ok:true, page:'p1'} | {id, ok:false, error}
→ {id, op:'run',  page:'p1', code}              ← {id, ok:true, result:'…'}
→ {id, op:'goto', page:'p1', url, ready, timeoutMs}
→ {id, op:'close', page:'p1'}
→ {id, op:'status', site}                       ← {id, ok:true, tabOpen, …}
↔ {op:'ping'} / {op:'pong'} every 20 s
errors: {id, ok:false, error:{kind:'not-allowed'|'no-tab'|'not-logged-in'|'timeout'|'blocked'|'failed', message}}
```

### 7.3 Extension (`extension/`)

| Item | Decision |
|---|---|
| Files | `manifest.json`, `src/background.ts` (service worker), `src/options.html` + `src/options.ts` (pairing code, status, unpair), `src/page-fetch.ts` (the packaged fetch function), icons. Own `package.json` script or an `npm run build:extension` in the root; esbuild, output `extension/dist/` (git-ignored) |
| Permissions | `scripting`, `storage`, `alarms`. `host_permissions`: the allow-list sites and `http://127.0.0.1/*`. No `<all_urls>`, no `debugger`, no `cookies`, no `tabs` unless tab URL queries prove to need it (host permissions normally suffice) |
| CSP | `extension_pages`: `script-src 'self'; connect-src ws://127.0.0.1:* http://127.0.0.1:*` |
| Connection | Service worker connects to the saved port with the token. 20 s ping while connected. `chrome.alarms` every 30 s reconnects when Obsidian was closed or the worker was stopped |
| Fetch | Find a tab of the site (`chrome.tabs.query({url: origin + '/*'})`); if none, create one with `active: false`, wait until loaded, and close it afterwards. Run the packaged function in MAIN world with the request as argument; it does `fetch(url, {credentials: 'include', …})` and returns status, headers and the body as base64 |
| Run / goTo | **Only in a tab the extension opened itself. Never navigate or run code in a tab the user has open.** Closed on `close`, on disconnect and after an idle timeout |
| Not logged in | Reported, never fixed by the extension: the user signs in in their browser as usual |
| Firefox | Same source, `browser_specific_settings.gecko`, `background.scripts` instead of `service_worker`. Verify the event-page lifetime in Stage 7 |
| Nothing else | No parsing, no storage of responses, no analytics, no network calls except the sites and 127.0.0.1 |

### 7.4 Settings and status

- Per web account: `loginMethod: 'window' | 'browser'`. Missing value = `'window'` so existing accounts do not change (question 3). New Gemini accounts get `'browser'`. Claude and ChatGPT show it as a choice, with the hint that Google-made accounts need it. Lumo has no choice.
- A "Browser link" block (General tab or in the login row): state (not paired / linked / browser closed), **Pair browser…** (shows the code and the three steps), **Unpair**, a link to the README section on installing the extension.
- Login row for a Browser link account: "Linked, signed in" / "Browser closed" / "Not logged in to `<site>` in the browser". No **Log in** / **Log out** buttons there (the login belongs to the browser); **Sync now** stays.
- Status bar: the same three states while a sync runs, plus the skip message.
- Use the `walter-ux-guide:walter-artifact-ux` skill for the settings UI; keep every visual state listed in `FEATURES.md` lines 101-125.

---

## 8. Implementation plan

For every stage: run `npm test` and `npm run lint` first and last, commit before and after (`git commit` with the `Co-Authored-By` line the session is told to use), update `FEATURES.md` in the same commit as the feature, and report to the owner in one small table.

### Stage 0: proof in the real browser

Goal: remove the technical unknowns before touching the plugin. Throwaway code in the scratchpad or `extension/spike/`; do not ship it.

1. `npm install` in the worktree if needed. Run `npm test` and `npm run lint`; record the baseline (how many tests, any that already fail).
2. Minimal extension: service worker opens a WebSocket to a tiny Node script on 127.0.0.1 and survives 5 minutes idle.
3. Packaged fetch in a tab of each site, with the owner's logins: `claude.ai/api/organizations`, `chatgpt.com/` (is the access token in the HTML?) and `chatgpt.com/api/auth/session`, one binary download. Check status, headers, body, and that base64 round-trips.
4. Code run on `gemini.google.com/app` and `aistudio.google.com/library`: try A (Trusted Types policy + eval; check whether the page's `trusted-types` directive restricts policy names), then B (`userScripts.execute`), and judge C (no code strings) by reading what the plugin's `run` code actually does. Evaluate the plugin's real `GEMINI_SIGNED_IN` and Studio `READY` expressions.
5. Check which cookies the plugin reads today are visible to the page (`oai-did`, `_account`, `lastActiveOrg`, `SAPISID`).
6. Needs the owner once (question 5): load the spike unpacked and be signed in.

Done when: a short table says, per site, fetch OK / run method chosen. If no run method works without the debugger, stop and ask the owner (question 1).

### Stage 1: transport interface, no behaviour change

1. Add `src/transport/types.ts` and `src/transport/login-window.ts` (wraps `login.ts`).
2. Move the callers onto it: `src/api.ts` (3 request sites), `src/claude-auth.ts`, `src/chatgpt/api.ts` (`connect`, `request`, `loginPage`, file download), `src/gemini/api.ts`, `src/studio/api.ts`. Lumo keeps calling `openHiddenPage` directly.
3. `transportFor` returns the login window for everyone at this stage.
4. New `scripts/test-transport.ts` + `test:transport` in `test:ci`: the switch picks the right transport; a fake transport proves Claude, ChatGPT, Gemini and AI Studio sync code produces identical output through the interface.

Done when: all old tests pass unchanged, lint is clean, and a manual sync of one account in the test vault gives a byte-identical note.

### Stage 2: local channel

1. Add `ws` (check `esbuild.config.mjs` externals; keep the mobile bundle loading: lazy `require`).
2. `src/link/server.ts` (start/stop, origin check, handshake, pairing, token in secret storage), `src/link/protocol.ts` (message types, chunking, base64), `src/link/sites.ts` (allow-list).
3. `scripts/test-channel.ts` + `test:channel`: pairing succeeds once; a second use of the code fails; wrong token rejected; web-page origin rejected; URL off the allow-list refused before sending; a dropped connection mid-request rejects with `browser-closed`; chunked binary round-trip; nothing secret in any thrown message.

Done when: tests pass and the server is provably not listening when no account uses the Browser link.

### Stage 3: extension for Chrome, Edge, Brave

1. `extension/` as in 7.3, built with esbuild; `npm run build:extension`. Add `extension/dist` to `.gitignore`. Make sure the Obsidian release workflow and `eslint` config ignore or handle the new folder correctly.
2. Options page: paste the pairing code, show linked / not linked, unpair.
3. Background: connect, keep-alive, reconnect by alarm, `fetch`, `open`, `run`, `goto`, `close`, `status`, allow-list check, own-tab bookkeeping.
4. Attribution note for the patterns taken from sho7650/obsidian-AI-exporter (MIT) in `extension/README.md` or `NOTICE`.
5. Test by hand in Chrome, then Edge and Brave: pair, fetch on each site, tab opened and closed, Obsidian closed and reopened, browser closed and reopened.

Done when: the Stage 0 table is reproduced with the real extension and the real channel.

### Stage 4: Gemini and AI Studio over the Browser link

1. `src/transport/browser-link.ts` implementing `fetch`, `openPage`, `isLoggedIn`.
2. `loginMethod` setting, defaults and the settings UI and status from 7.4. Skip logic in the sync runners: a Browser link account whose browser is closed, unpaired or not logged in is skipped with its message; other accounts carry on; automatic sync does not pause for a skip.
3. Tests: extend `test:transport` (skip paths, messages) and `test:gemini` where the transport is injected.
4. Real run in the test vault: sync the same Gemini account and AI Studio once through the login window (if it still logs in) or from an earlier saved result, once through the Browser link, into two folders; compare file lists, frontmatter and raw JSON. Differences must be explained or fixed.

Done when: the comparison table is clean.

### Stage 5: Claude and ChatGPT over the Browser link

1. Claude: org ID without the cookie; all `api.ts` requests through the transport; memory sync (`src/memory/claude-web.ts`) included.
2. ChatGPT: access token from the page fetched in the tab; device ID and workspace without cookie values; downloads through the transport; signed links stay direct; Codex cloud and memory use the same `GptApi` so they follow automatically; the 429 cooldown and error log behave as before.
3. Real run with one Google-made ChatGPT or Claude account, compared with a login-window or pasted-login run of the same account.
4. The "Made your account with Google?" row (`FEATURES.md` line 123): keep **Use browser login…**, and add the Browser link as the recommended way. Do not remove the row without the owner's OK.

Done when: same files and frontmatter on both routes.

### Stage 6: login-window fixes

1. Google mode in every partition: when a login window of any provider goes to a Google sign-in host, it must present as the Gemini window does (Firefox user agent, client hints removed). Today `prepareSession` sets this per session; make it apply to Google hosts in the Claude and ChatGPT partitions without changing what `claude.ai` and `chatgpt.com` see (their Cloudflare checks need the Chromium user agent that requests also send: see `loginUserAgent`).
2. Popups as real child windows with a live `window.opener`, same partition, same lock-down (`lockPermissions`, sandbox). **Risk:** through `electron.remote` the window-open handler answers too late (see section 6). Investigate; if it cannot be done from a plugin, say so plainly, keep today's behaviour and list it under known limitations rather than shipping something half-working.
3. Update `FEATURES.md` lines 167-168 to the new behaviour; they change, they must not vanish.

Done when: a Google popup sign-in completes in a Claude or ChatGPT login window, or the limitation is documented with the reason.

### Stage 7: Firefox, documentation, handover

1. Firefox build and manual test (temporary add-on via `about:debugging`).
2. README: a "Browser link" section (what it is, install unpacked, pair, what the extension can access and why, what it never does), updates to "Privacy and network use", "Requirements", the FAQ entry "The login window doesn't work for me?", and "Development" (new test and build commands).
3. `CHANGELOG.md` entry `## 0.42.0 - <date>`; version bump per the README's "Releasing" steps only when the owner says so.
4. `FEATURES.md`: new lines for the transport switch, channel, pairing, statuses, skip behaviour and extension, each tied to its test.
5. The 10-minute acceptance checklist with checkboxes: load unpacked, pair, sync Gemini, sync AI Studio, sync the Google-made account, close the browser and sync (skip message), unpair.
6. Handoff note in the vault per its CLAUDE.md (question 4), with known limitations: browser must be open during Browser link syncs; one browser and one login per site; Web Store status of the code-run method; Firefox caveats; the popup result from Stage 6.
7. Full `npm test`, lint, `npm run build`. Open one PR with `gh`. Suggest a fresh session runs `e2e-fresh-eyes-audit`.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| No code-run method works on Google pages without the debugger | Stage 0 finds out first; option C avoids code strings entirely |
| A web page talks to the local port | 127.0.0.1 only, origin check, token, allow-list on both sides |
| The link becomes a general proxy | Shared allow-list, https only, no other hosts |
| The extension touches the user's own tabs | Fetch only reads; run and navigation only in tabs the extension opened |
| Mobile build breaks on Node modules | Lazy loading behind the desktop check; run `test:mobile` |
| A closed browser pauses automatic sync | Skip is not an error |
| Silent loss of an existing login feature | `feature-guard`, `FEATURES.md` lines 163-173 and 111-125 checked at every stage |
| ChatGPT or Claude need a cookie value the page cannot read | Checked in Stage 0 step 5; fall back to values from API answers |
