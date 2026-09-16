# Tab Boss

A personal Manifest V3 extension for Chromium browsers, built for ego lite
with **Show Tabs Vertically** turned on.

## What it does

1. **Every new tab goes to the bottom.** Cmd+T, Cmd+clicked links, and links
   that open themselves in a new tab all land at the end of the strip, never
   beside their parent tab.
2. **Every empty new window clones the window you came from.** Press Cmd+N and
   the new window opens with the same tabs, in the same order, with the same
   pinned tabs, muted tabs, tab groups, and selected tab. Background tabs are
   left unloaded so a large clone does not stall the browser.

Dragging a tab out, popup windows opened by a page, incognito windows, and
session restore on startup are all left alone.

### What cannot be copied

Chromium gives extensions no way to read or write per-tab back/forward history,
scroll position, unsubmitted form input, or media playback position. Cloned
tabs start fresh. You stay signed in to sites, because cookies are shared
across windows of the same profile.

Tabs whose URL an extension is not allowed to reopen are skipped, with a count
logged to the service worker console. That covers `about:` (except
`about:blank`), `chrome://`, `chrome-untrusted://`, `devtools://`, `edge://`,
`ego://`, and `view-source:` URLs, and `file://` URLs. If a window holds
nothing but such tabs — a lone `chrome://extensions` tab, say — the new window
is simply left empty.

### The first Cmd+N after a long idle

The extension keeps no stored state. When the browser has been idle long
enough for Chromium to shut its service worker down, the very first Cmd+N can
land before the extension has re-learned which window you came from, and that
window opens empty. A second Cmd+N clones as usual.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.

## Run the tests

```bash
npm test
```

No dependencies to install. This runs Node's built-in test runner.

## Not implemented: pinned tabs 3 per row

Limiting pinned tabs to 3 per row is impossible from an extension. The tab
strip is native browser code, and Chromium blocks extensions from injecting
script or CSS into `chrome://` pages. See
`docs/superpowers/specs/2026-09-15-tab-boss-design.md` for the full evidence.
