# Tab Boss

A personal Manifest V3 extension for Chromium browsers, built for ego lite
with **Show Tabs Vertically** turned on.

## What it does

1. **Every new tab goes to the bottom.** Cmd+T, Cmd+clicked links, and links
   that open themselves in a new tab all land at the end of the strip, never
   beside their parent tab.
2. **Duplicate this window, on demand.** A keyboard shortcut (default
   Cmd/Ctrl+Shift+Y, rebindable at `chrome://extensions/shortcuts`) and a
   right-click "Duplicate this window" menu item open a new window that is a
   copy of the one you are in — same tabs, order, pinned tabs, muted tabs,
   groups, and selected tab, with background tabs left unloaded.
3. **Saved tabsets.** Click the Tab Boss toolbar icon to open the popup. Save
   the current window under a name ("Daily Work"), and open a saved set into a
   new window whenever you want. Saving an existing name asks to replace it;
   deleting asks to confirm.
4. **Automatic layout backup.** Every 2 minutes Tab Boss snapshots all your
   normal windows — tab order, pinned tabs, muted tabs, groups with their names
   and colours, and the selected tab — keeping the last 20 (about 40 minutes).
   The popup has a toggle to turn this off, and a **Restore last backup** button
   that opens the newest snapshot into brand new windows. Your existing windows
   are never touched.

   Snapshots are skipped during the first minute after the browser starts, when
   the tab count has more than halved since the last one, and when nothing has
   changed — so a crash cannot poison the backup with a post-crash remnant. A
   genuine halving is accepted after about six minutes.

   Everything is stored on this machine only. Nothing is synced. Incognito
   windows are never captured, duplicated, or restored.

### Not enabled: auto-clone on every new window

An earlier version cloned your current window into every newly opened window
automatically. That cannot work on ego lite: creating a Space is
indistinguishable from pressing Cmd+N, so it cloned your tabs into every
restored Space and piled up hundreds of duplicates. It is disabled
(`TAB_WRITING_ENABLED = false` in `src/background.js`) and replaced by the
explicit "Duplicate this window" command above.

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
