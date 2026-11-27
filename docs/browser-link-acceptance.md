# Browser link: 10-minute acceptance check

For the owner. Everything here has been tested by Claude already; this is the short check by hand. Use a test vault, not the live one.

## 0. Before you start (1 min)

- [ ] Obsidian has AI ChatBridge 0.48.1 or later (Settings → Community plugins)
- [ ] In a terminal, in the plugin's repository folder: `npm install`, then `npm run build:extension`
- [ ] Chrome is open, and you are signed in there to Gemini, AI Studio and the Claude or ChatGPT account you made with "Continue with Google"

## 1. Install the extension (2 min)

- [ ] Chrome: open `chrome://extensions`, switch on **Developer mode** (top right)
- [ ] **Load unpacked** → choose the `extension\dist` folder of the repository
- [ ] **AI ChatBridge Browser link** appears in the list, switched on
- [ ] A tab opens by itself: the extension's page with "Not paired" and a code field

(Edge or Brave: the same, at `edge://extensions` or `brave://extensions`. Firefox: `about:debugging` → **This Firefox** → **Load Temporary Add-on…** → `extension\dist-firefox\manifest.json`. If its page shows **Allow site access**, select it and allow.)

## 2. Pair (1 min)

- [ ] Obsidian → Settings → AI ChatBridge → **Gemini** → your account → **Login method** = **Browser link**
- [ ] The login row says "not paired yet"; select **Pair browser…**
- [ ] Select **Copy**, switch to the extension's tab, paste into the code field, press **Enter** (or select **Pair**)
- [ ] The extension says **Linked to Obsidian**; Obsidian's window says "Linked." and closes itself
- [ ] The login row now says "linked to your browser"; the Overview card's Gemini dot is on

## 3. Sync through the browser (3 min)

- [ ] Gemini → **Sync now**. A Gemini tab may open in the background in Chrome and closes again
- [ ] New Gemini notes appear in the Gemini chat folder, as with the login window (same name, same properties)
- [ ] AI Studio (if on): the same
- [ ] Claude or ChatGPT tab → your Google-made account → **Login method** = **Browser link** → **Sync now**: its chats arrive (no new pairing needed)

## 4. A closed browser is skipped, not failed (2 min)

- [ ] Close Chrome completely
- [ ] **Sync all** in Obsidian: the Browser link accounts say "skipped: Your browser is closed…"; your other accounts sync as usual
- [ ] The account's "Last sync" line says "waiting. Your browser is closed…" (orange), not "failed"
- [ ] Open Chrome again; within a minute the extension reconnects by itself; **Sync now** works again

## 5. Unpair (1 min)

- [ ] On the account's login row select **Unpair**: the row says "not paired yet"; the extension's page says it was refused, or "Not paired" after you select **Unpair** there too

If any box fails, note which one and what you saw; nothing else is needed.
