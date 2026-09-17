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
3. **Your layout is backed up.** Every 2 minutes Tab Boss saves a snapshot of
   all your normal windows — tab order, pinned tabs, muted tabs, tab groups
   with their names and colours, and which tab was selected. It keeps the last
   20, about 40 minutes of history. Click the Tab Boss toolbar icon to restore
   the newest one into brand new windows. Your existing windows are never
   touched.

   Snapshots are skipped in three cases: during the first minute after the
   browser starts, when the tab count has more than halved since the last one,
   and when nothing has changed. The first two exist so a crash cannot poison
   the backup with a post-crash remnant. If you genuinely close half your tabs,
   the low count is accepted after about six minutes.

   If there is nothing to restore, the toolbar icon shows a `!` for a moment.

   Snapshots are stored on this machine only. They are never synced and never
   leave the browser. Incognito windows are never captured or restored.

Dragging a tab out, popup windows opened by a page, incognito windows, and
session restore on startup are all left alone. This extension requires four
permissions: `tabs` and `tabGroups` to manage window and tab state, `storage`
to keep snapshots, and `alarms` to schedule automatic saves.

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

## Manual smoke test

The tests run against a fake browser. These five steps check the things only a
real browser can tell you. Keep the service worker console open throughout:
`chrome://extensions` → Tab Boss → **service worker**.

1. **Snapshots survive intermittent browsing.** This is the important one, and
   it has to be done with gaps. Open a few tabs, then leave the browser alone
   for about 45 seconds — long enough for Chromium to shut the service worker
   down — then open one more tab. Repeat for five minutes or so. Then run
   `chrome.storage.local.get("snapshots").then(r => console.log(r.snapshots.length))`
   in the service worker console. It must be greater than zero.

   Checking this under *continuous* use proves nothing. The failure it exists
   to catch is the alarm being rescheduled on each cold start, and a worker
   that never goes idle never cold-starts. If the count is zero, the two-minute
   alarm is being reset before it can ever fire.
2. **A layout comes back.** Open several tabs including a pinned one, a muted
   one, and two tab groups with different names and colours. Wait two minutes.
   Click the Tab Boss icon. A new window appears matching the layout, and every
   window you already had is untouched.
3. **Nothing to restore says so.** Run `chrome.storage.local.clear()` in the
   service worker console, then click the icon. The badge shows `!` for about
   three seconds and no window opens.
4. **A big drop is refused, then accepted.** Close half your tabs. The console
   logs `[Tab Boss] skipped a snapshot` on the next few ticks, and about six
   minutes later a snapshot is taken anyway.
5. **A fresh start is quiet.** Quit the browser and relaunch it. No snapshot is
   taken during the first minute.

## Not implemented: pinned tabs 3 per row

Limiting pinned tabs to 3 per row is impossible from an extension. The tab
strip is native browser code, and Chromium blocks extensions from injecting
script or CSS into `chrome://` pages. See
`docs/superpowers/specs/2026-09-15-tab-boss-design.md` for the full evidence.

## Saved tabsets — manual smoke test

1. Open a window with a few tabs, a pinned tab, and a group. Click the Tab Boss
   toolbar icon; the popup opens.
2. Type "Test Set" and Save. It appears in the list with its tab count.
3. Click Open. A new window appears with the same tabs, order, pinned tab, and
   group. Your original window is untouched.
4. Change the window, save "Test Set" again — the button says "Replace?"; click
   again. The list's tab count updates.
5. Click ✕ on the row — it says "Sure?"; click again. The set is gone.
6. Turn the "Automatic snapshots & restore" toggle off. In the service worker
   console, confirm no new snapshot is written for a few minutes. Turn it back
   on and confirm one is, and that "Restore last backup" appears and works.
