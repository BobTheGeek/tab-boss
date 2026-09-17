# Tab Boss — Saved Tabsets

Date: 2026-09-17
Status: Approved

## Purpose

Let the user save the current window's tabs and groups under a name (e.g.
"Daily Work", "Personal Projects") and open that named set into a new window
whenever they want. Manual and named, versus the automatic, rolling snapshots
that already exist.

This is the first feature in Tab Boss with a real user interface: a popup on
the toolbar icon.

## Relationship to what exists

Three features now share one core — capture a window's tabs into a plan, and
write a plan into a new window:

- **Snapshots** — automatic, every 2 minutes, all normal windows, rolling 20.
- **Duplicate this window** — explicit, copies the focused window into a new one.
- **Saved tabsets** — this feature. Explicit, named, one window, kept until
  deleted.

Saved tabsets reuses the hardened write path (`writeTabs` + the tb-084 abort
watch + the `restoredWindowIds` tag) and the per-window capture that
`planFromWindow` already performs. It does not reimplement either.

## What a tabset is

A plain JSON-serialisable object:

```js
{
  name: "Daily Work",
  savedAt: 1789600000000,   // epoch ms, for display and tie-breaking
  plan: [                    // the writeTabs plan shape
    { url, pinned, muted, active, groupKey }
  ],
  groups: [                  // the writeTabs groups shape
    { key, title, color, collapsed }
  ]
}
```

`plan` and `groups` are exactly the structures `writeTabs(api, watch, targetId,
plan, groups)` consumes, so opening a set is a direct call into the existing
writer. They are produced by the same `planFromWindow` the cloner and duplicate
use, so capture is one implementation.

`name` is the identity: names are unique within the store (see Overwrite).

## Storage

`chrome.storage.local`, under a new key `tabsets` — an array of the objects
above, independent of `snapshots`, `meta`, and `windowObservations`. The user's
automatic backup and their named sets cannot corrupt each other.

Reads follow the same fail-open/fail-closed asymmetry as `snapshotStore`: a
reader that cannot read reports "no sets" (`[]`); a write that builds on an
unverified read fails closed rather than overwriting the store with a partial
value. There is no cap on the number of sets — the user manages them by
deleting.

A second new key, `settings`, holds `{ snapshotsEnabled: boolean }`, default
`true`. This backs the popup toggle (see The toggle).

## Components

| File | Responsibility |
| --- | --- |
| `popup.html` / `popup.css` / `src/popup.js` | The UI. Lists/saves/deletes sets, renders the toggle, and messages the service worker for capture and open. |
| `src/tabsetStore.js` | Pure-ish storage layer for `tabsets`: read, upsert-by-name, delete-by-name. Same shape and safety rules as `snapshotStore.js`. |
| `src/settingsStore.js` | Read/write `settings` (`snapshotsEnabled`), default true. |
| `src/tabsetMessages.js` | The message contract constants shared by popup and background, so the two cannot drift. |
| `src/background.js` | Registers a `runtime.onMessage` handler for the two operations, and gates the snapshot scheduler on `snapshotsEnabled`. |
| `manifest.json` | Adds `action.default_popup`. The `action` already exists. |

`manifest.json`'s `action` currently has no popup; adding `default_popup`
changes the toolbar click from "restore newest" (which is disabled anyway) to
"open the popup". Restore, when the toggle is on, is reached by a button inside
the popup instead.

## The message contract

The popup is an extension page with full `chrome.*` access, so it does the
plain storage work itself: reading the set list, deleting a set, reading and
writing the toggle. Two operations go to the service worker, because they touch
live windows through the crash-hardened write path whose abort watch lives in
the worker's shared `state`:

- **Capture** — `{ type: "tabsets/capture", name }`. The worker reads the
  focused window with `planFromWindow`, builds `{ name, savedAt, plan, groups }`,
  upserts it into `tabsets`, and replies `{ ok, overwritten }`. If the focused
  window is incognito or not normal, it replies `{ ok: false, reason }` and
  saves nothing.
- **Open** — `{ type: "tabsets/open", name }`. The worker looks the set up,
  creates a new window, tags it, writes the plan with `writeTabs` under an abort
  watch, removes the placeholder if anything was written, and replies
  `{ ok, created }`.

**Shared helper.** Opening a set and duplicating a window are the same procedure
with a different source: create a new window, tag it, write a plan into it,
tidy the placeholder. `duplicateFocusedWindow` currently inlines that after
building its plan from the live focused window. This feature extracts the
"write a plan into a fresh tagged window" half into one function —
`writePlanIntoNewWindow(api, state, plan, groups)` — that both callers use:
`duplicateFocusedWindow` builds its plan from the focused window then calls it,
and the tabset open passes the stored plan. One implementation of the tagged,
abort-guarded new-window write, not two. This is a small, behaviour-preserving
refactor of `duplicateFocusedWindow`, verified by its existing tests.

The worker's `onMessage` handler returns `true` to keep the message channel open
for the async reply, per Manifest V3.

The **Replace?** confirm for an existing name happens in the popup before the
capture message is sent: the popup already has the list, so it knows the name
exists and asks first. The worker's upsert is still last-writer-wins by name, so
a capture is safe even without the confirm.

## The toggle

A checkbox in the popup, "Automatic snapshots & restore", bound to
`settings.snapshotsEnabled` (default true).

- **On:** the snapshot scheduler captures every 2 minutes as today, and the
  popup shows a **Restore last backup** button that sends the existing
  `restoreNewest` path (re-enabled behind this toggle).
- **Off:** `captureNow` returns early without reading or writing anything, so no
  snapshots are taken, and the Restore button is hidden.

The scheduler reads `snapshotsEnabled` at the top of `captureNow`. The alarm
still fires; it just does nothing while disabled. Toggling in the popup writes
`settings` and updates the button's visibility; the next alarm tick honours the
new value.

This toggle is also the resolution of the currently-disabled restore button and
the always-on scheduler: the user owns whether the automatic system runs.

## Opening a set — safety

Identical guarantees to duplicate-window, because it is the same code:

- Creates a brand new window; never reads, moves, or removes a tab in an
  existing window.
- The new window is tagged in `restoredWindowIds` (so nothing clones onto it)
  and in `suppressedWindowIds` (so new-tab placement stays off it while it
  fills), cleared on window close.
- Every browser call in the write is preceded by an abort check with no `await`
  in the gap; closing the new window mid-open stops the write silently.
- Tabs the browser forbids an extension from reopening (`chrome://`, `file://`,
  etc.) are dropped; a set that is entirely such tabs opens a window with a
  single blank tab rather than an empty or vanishing one.

## The popup UI

Plain HTML/CSS/JS, no framework, matching the zero-dependency codebase. Layout:

- A single-line **save row**: a text input (placeholder "Name this window's
  tabs") and a **Save** button. Enter in the input also saves.
- A **list** of saved sets, newest first, each row showing the name, its tab
  count, an **Open** button, and a **✕** delete (with a one-tap confirm on the
  row, not a modal).
- A footer with the **toggle** and, when it is on, the **Restore last backup**
  button.
- Empty, saving, and error states are shown inline as a short line of text, not
  as alerts. The popup never uses `alert`/`confirm` dialogs — those block the
  service worker channel; confirms are inline two-step buttons.

The design is functional and clean; it is the project's first UI and does not
need to be more than legible and obvious.

## Error handling

Consistent with the rest of the project. Storage read failures read as empty.
An open that races a user closing the new window is silent. Unexpected failures
`console.warn` with the `[Tab Boss] ` prefix. A capture of an incognito or
non-normal window is a defined, user-visible "can't save this window" state in
the popup, not an error. A message that arrives malformed, or names a set that
no longer exists, replies `{ ok: false }` and the popup shows a short line.

## Testing

Node's `node:test`, no dependencies, as everywhere else. `npm test`; never
`node --test test/`.

- `tabsetStore.js` — read empty; upsert new; upsert existing name replaces in
  place and does not duplicate; delete by name; a malformed stored value reads
  as empty; a rejected pre-write read aborts the upsert rather than clobbering.
- `settingsStore.js` — default `snapshotsEnabled: true` when absent; round-trips;
  a malformed value reads as the default.
- The message handler — capture of a normal window stores the right shape and
  replies ok; capture of incognito replies not-ok and stores nothing; open
  creates a window with the set's tabs and groups; open of a missing name
  replies not-ok and creates nothing; open reuses the tagged, abort-guarded
  write (assert the new window is tagged and no existing window is touched).
- `captureNow` — returns early and writes nothing when `snapshotsEnabled` is
  false; behaves as today when true. The alarm still fires either way.
- The popup's pure logic — name validation, the list view-model built from a
  raw `tabsets` array, and the two-step-confirm state machine — is factored into
  a `src/popupModel.js` with no DOM access and unit-tested directly. `src/popup.js`
  keeps only the thin DOM wiring (query elements, attach handlers, call the
  model, message the worker), which the manual smoke test covers. The store,
  settings, message, and model layers carry the automated coverage.

Manual smoke test (added to `README.md`): save the current window as a name;
reopen the popup and see it listed; open it into a new window and confirm tabs,
order, pinned, and groups; overwrite it and confirm the count changes; delete
it; toggle snapshots off and confirm no new snapshot appears, then on and
confirm one does and Restore works.

## Non-goals

- No editing a set's contents after saving; to change one, save over it.
- No reordering, folders, or tags for sets — just a flat named list.
- No syncing between machines; `chrome.storage.local` only.
- No import/export file.
- No drag-and-drop or multi-select in the popup.
- Saved tabsets do not capture per-tab history, scroll, or unsubmitted form
  input — the same limitation every write path in Tab Boss documents.
