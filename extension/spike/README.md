# Browser link: Stage 0 spike

Throwaway test build (see `docs/plans/browser-link.md`, Stage 0). Not shipped, not the real extension.

It proves, in your real browser and with your own logins:

| Site | Check |
|---|---|
| Claude | fetch `/api/organizations`; which cookies the page can read; binary download |
| ChatGPT | fetch `/` and `/api/auth/session`; `oai-did` / `_account` readable; binary download |
| Gemini | the signed list-chats call, run as a packaged function (no eval, no debugger) |
| AI Studio | the signed list-prompts call, same way |
| Link | connection survives 5 minutes idle; `example.com` is refused |

The terminal shows only statuses, sizes and yes/no. Never chat content, cookies or tokens.

## Run it (about 8 minutes, mostly waiting)

1. Be signed in to claude.ai, chatgpt.com, gemini.google.com and aistudio.google.com in Chrome.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this `extension/spike` folder.
3. In a terminal, in this folder: `npm install` once, then `npm start`.
4. In Chrome: the extension's **Details** → **Extension options**. Paste the pairing code from the terminal, select **Pair**.
5. Background tabs open and close by themselves. Wait for "Done" in the terminal (about 6 minutes).
6. Remove the spike from `chrome://extensions` afterwards.

Results land in `spike-results.json` (git-ignored).
