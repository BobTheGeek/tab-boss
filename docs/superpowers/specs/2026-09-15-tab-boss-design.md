# Tab Boss — Design

Date: 2026-09-15
Status: Approved
Target browser: ego lite 0.5.0.32 (Chromium, bundle id `com.citrolabs.ego.lite`)

## Purpose

A personal Manifest V3 extension that enforces two tab-management habits the
browser does not offer:

1. Every new tab appears at the bottom of the tab strip.
2. Every empty new window opens pre-filled with a copy of the tabs from the
   window you were just in.

The extension has no user interface. It runs entirely in a background service
worker.

## Prerequisite

The user runs ego lite with **Show Tabs Vertically** enabled
(`vertical_tabs/enabled = true` in the profile Preferences file). This setting
only changes how the tab strip is drawn; tab ordering is the same integer index
order Chromium always uses. The extension therefore does not read or depend on
this pref. It is listed here only because "bottom" is meaningless in a
horizontal strip.

## Out of scope — pinned tab grid (3 per row)

The original third requirement — limit pinned tabs to 3 per row, wrapping into
additional left-justified rows — **cannot be implemented as a browser
extension**, and is excluded from this design.

Evidence gathered on 2026-09-15:

- ego lite's vertical tab strip is driven by the native pref namespace
  `vertical_tabs/*`. It is native Chromium Views code, not a web page.
- No `userChrome.css`, custom-CSS pref, or theme directory exists in
  `/Applications/ego lite.app` or
  `~/Library/Application Support/Citro Labs/ego lite`. The only
  ego-specific config file, `ego_config.json`, contains a single key
  (`not_first_run`).
- A `chrome://tab-strip.top-chrome` WebUI exists in the binary, but Chromium
  blocks all extension script and CSS injection into `chrome://` origins, so it
  is unreachable regardless.

This requirement is tracked as a separate blocked ticket. It can only be
unblocked by ego lite shipping a chrome-styling hook or the feature itself.

## Architecture

```
tab-boss/
  manifest.json
  src/
    background.js         service worker entry; wires modules to the live chrome API
    state.js              shared mutable state (focus history, clone suppression)
    newTabPlacement.js    requirement 1
    windowCloning.js      requirement 2
  test/
    fakeChrome.js         in-memory stand-in for the chrome API
    newTabPlacement.test.js
    windowCloning.test.js
```

### Dependency injection

Neither feature module references the global `chrome` object. Each exports a
single installer:

```js
export function installNewTabPlacement(api, state) { ... }
export function installWindowCloning(api, state) { ... }
```

`api` is any object exposing the subset of `chrome.tabs`, `chrome.windows`, and
`chrome.tabGroups` the module uses. `background.js` passes the real `chrome`;
tests pass `fakeChrome`. This is the only seam needed to make the logic testable
without a browser.

### Shared state (`state.js`)

A single module-scoped object, created by a factory so tests get a fresh one:

- `previousWindowId` — the normal, non-incognito window focused before the
  current one. This is the clone source.
- `currentWindowId` — the window focused now.
- `suppressedWindowIds` — a `Set` of window ids currently being populated by the
  cloner. While a window id is in this set, `newTabPlacement` ignores tab
  creation events for it, so the two features cannot fight over ordering.

Focus history is maintained by a `chrome.windows.onFocusChanged` listener
registered in `background.js`. On each change to a normal non-incognito window
id, `currentWindowId` shifts into `previousWindowId` and the new id becomes
`currentWindowId`. `WINDOW_ID_NONE` (focus leaving the browser entirely) is
ignored so alt-tabbing away and back does not destroy the history. A repeat
focus event for the id already in `currentWindowId` is also ignored, so
clicking around inside one window does not erase the previous id.

### Choosing the clone source

Chromium does not guarantee the ordering of `windows.onCreated` relative to
`windows.onFocusChanged` for the same new window. Both orderings must yield the
same source, so `windowCloning` derives the source id rather than reading one
field:

```
source = (currentWindowId !== newWindowId) ? currentWindowId : previousWindowId
```

If focus fired first, `currentWindowId` is the new window and
`previousWindowId` is the window we came from. If creation fired first,
`currentWindowId` is still the window we came from. Either way the expression
resolves to the correct source.

## Requirement 1 — new tabs go to the bottom

Listener: `chrome.tabs.onCreated`.

On each created tab:

1. If `state.suppressedWindowIds.has(tab.windowId)` → do nothing.
2. Look up the tab's window. If `window.type !== "normal"` → do nothing.
   (Skips popups, app windows, and devtools windows.)
3. Otherwise call `api.tabs.move(tab.id, { index: -1 })`.

Notes:

- `index: -1` means "last position". Chromium refuses to place an unpinned tab
  above a pinned one, so pinned tabs are unaffected without a special case.
- A newly created tab is never pinned, so no pinned check is required.
- Errors from `tabs.move` are caught and ignored. A tab can be closed between
  the event firing and the move landing; that is normal and not worth logging.
- This applies to all new tabs, including tabs opened by Cmd+click on a link and
  tabs opened by a page via `target="_blank"`. Chromium's default
  "open next to parent" behaviour is intentionally overridden.

## Requirement 2 — new windows clone the previous window

Listener: `chrome.windows.onCreated`, registered with
`{ windowTypes: ["normal"] }`.

### Gate

The clone runs only if **all** of these hold. Any failure is a silent no-op:

1. `newWindow.incognito === false`.
2. `newWindow.type === "normal"`.
3. The new window contains exactly one tab, and that tab is blank.
   `windows.onCreated` delivers a `Window` with no `tabs` array, so this is
   checked with `api.tabs.query({ windowId: newWindow.id })`, not by reading
   `newWindow.tabs`.
4. The derived source id (see "Choosing the clone source") is set, is not the
   new window's id, and the window still exists (`api.windows.get` succeeds).
5. The source window is not incognito and its type is `"normal"`.

Gate 3 is what keeps the feature safe. A window created by dragging a tab out
already holds a real page, so it fails. A `window.open()` popup already holds a
URL, so it fails. A session restore at startup holds many tabs, so it fails.
Only a deliberate Cmd+N passes.

### Blank tab detection

A tab counts as blank when its `url` (falling back to `pendingUrl`, then to the
empty string) is one of:

- `""`
- `about:blank`
- any URL whose origin-ish prefix matches `chrome://newtab`,
  `chrome://new-tab-page`, or `ego://newtab`

The list is a single exported constant so it is trivially extendable if ego lite
uses a new-tab URL not covered above. During implementation the actual value is
confirmed by logging it once from the running browser and, if new, added to the
constant.

### Clone procedure

1. Add the new window's id to `state.suppressedWindowIds`.
2. Read the source window's tabs via `api.tabs.query({ windowId: sourceId })`,
   sorted by `index`.
3. Remember the blank placeholder tab's id from the new window.
4. For each source tab, in order, call
   `api.tabs.create({ windowId: newId, url, pinned, active: false })`.
   - Tabs whose URL cannot be recreated by an extension (`chrome://`,
     `devtools://`, `file://`, `about:` other than `about:blank`) are skipped.
     The count of skipped tabs is logged.
   - After creation, if the source tab was muted, call
     `api.tabs.update(newTabId, { muted: true })`.
   - After creation, unless this tab is the one that will become active, call
     `api.tabs.discard(newTabId)` so the page is not loaded now. Failures are
     ignored — discard is a best-effort optimisation, not a correctness
     requirement.
5. Rebuild tab groups. For each distinct `groupId` in the source that is not
   `TAB_GROUP_ID_NONE`:
   - Read the source group with `api.tabGroups.get(groupId)`.
   - Call `api.tabs.group({ tabIds: [...clones in that group],
     createProperties: { windowId: newId } })`.
   - Call `api.tabGroups.update(newGroupId, { title, color, collapsed })`.
6. Activate the clone of whichever source tab had `active: true`.
7. Remove the placeholder blank tab.
8. Remove the new window's id from `state.suppressedWindowIds`, in a `finally`
   block so a thrown error cannot leave the suppression stuck on.

### What is and is not copied

Copied: tab URLs, tab order, pinned state, muted state, which tab is active,
tab group membership, and each group's title, colour, and collapsed state.
Logged-in sessions carry over for free because cookies are shared across windows
of the same profile.

Not copied, because Chromium exposes no extension API for any of it: per-tab
back/forward history, scroll position, unsubmitted form input, and media
playback position. This is stated explicitly so the behaviour is not later
mistaken for a bug.

## Permissions

`manifest.json` requests exactly:

```json
"permissions": ["tabs", "tabGroups"]
```

`tabs` is required to read `tab.url`. `tabGroups` is required to read and write
group titles and colours. No host permissions, no content scripts, no network
access, no storage.

## Error handling

Every call into the browser API is wrapped so a rejection cannot kill the
service worker. Two tiers:

- **Expected races** (a tab closed mid-operation, a window closed mid-clone,
  `discard` refused): swallowed silently.
- **Unexpected failures**: logged with `console.warn` prefixed `[Tab Boss]`, so
  they are findable in the service worker console without adding a UI.

The clone procedure's suppression cleanup lives in a `finally` block. If the
source window disappears mid-clone, the partially populated new window is left
as-is rather than being torn down; a half-cloned window is less surprising than
a window that empties itself.

## Testing

**Unit tests** run under Node's built-in `node:test` runner. No npm
dependencies. Invoked with `node --test test/`.

`test/fakeChrome.js` provides an in-memory browser: a tab table, a window table,
a group table, working `onCreated` / `onFocusChanged` event emitters, and a
recorded call log. It implements only the methods the modules use.

Cases to cover:

*newTabPlacement*
- A tab created in a normal window is moved to index `-1`.
- A tab created in a popup window is not moved.
- A tab created in a suppressed window is not moved.
- A `tabs.move` rejection does not throw.

*windowCloning*
- A one-blank-tab normal window clones the previous window's tabs in order.
- An incognito new window is ignored.
- A new window holding a real page (dragged-out tab) is ignored.
- A new window holding several tabs (session restore) is ignored.
- A new window with no known source window is ignored.
- The correct source is chosen when `onFocusChanged` fires before `onCreated`.
- The correct source is chosen when `onCreated` fires before `onFocusChanged`.
- Pinned, muted, and active flags are reproduced.
- Groups are recreated with matching title, colour, and collapsed state.
- Unclonable URLs (`chrome://settings`) are skipped, and the rest still clone.
- The placeholder blank tab is removed.
- The window id is removed from `suppressedWindowIds` even when the clone throws.

**Manual smoke test** in ego lite, run once after loading the unpacked
extension:

1. Cmd+T three times → each tab lands at the bottom.
2. Cmd+click a link → the tab lands at the bottom, not beside its parent.
3. Pin two tabs, open a new tab → the new tab is still last, pinned tabs
   undisturbed.
4. With a window holding pinned tabs, a group, and a muted tab, press Cmd+N →
   the new window matches, background tabs show as unloaded, the same tab is
   selected.
5. Drag a tab out of a window → a plain one-tab window, no clone.
6. Cmd+Shift+N → a plain incognito window, no clone.
7. Quit and relaunch ego lite → the restored session is not cloned.

## Non-goals

- No options page, popup, toolbar icon, or keyboard shortcuts.
- No persistence. All state is in-memory and rebuilt from focus events. If the
  service worker is evicted, the next window focus restores enough state; a
  clone attempted before any focus event is simply skipped.
- No syncing, telemetry, or Chrome Web Store publication. This is a personal
  unpacked extension.
