# Tab Boss — Tab Layout Snapshots

Date: 2026-09-16
Status: Approved
Depends on: the `tb-084` crash fix being merged to `main` first. See "Hard prerequisite".

## Purpose

Keep a rolling, automatic backup of the user's tab layout so a crash, a
dismissed session-restore prompt, or a corrupted profile does not lose it.

Chromium already restores sessions after a crash. It fails in ways the user has
no control over: the restore prompt gets dismissed, the profile is corrupted, or
the browser is force-quit. This is a second, independent copy the user owns.

## Shape of the feature

- Snapshots are taken automatically every 2 minutes. There is no manual save and
  no naming.
- Exactly one restore action: a toolbar icon that restores the newest snapshot
  into brand new windows.
- There is no snapshot list and no picker. This was chosen deliberately; see
  "Rejected alternatives".

## Hard prerequisite

This feature reuses the window cloner's tab-writing code, including its
abort-on-window-close protection. That protection is the fix for `tb-084`, a
P0 bug where closing a window mid-clone crashed the browser.

**Do not start this work until the `tb-084` fix is merged to `main`.** The
`src/tabWriter.js` extraction described below must match the final shape of the
abort watch, which is still being reviewed. Building against an earlier shape
would fork the safety-critical code.

## Snapshot data

One snapshot is a plain JSON-serialisable object:

```js
{
  version: 1,
  takenAt: 1789561234567,        // epoch ms
  windows: [
    {
      focused: false,
      groups: [
        { key: 0, title: "Research", color: "blue", collapsed: false }
      ],
      tabs: [
        {
          url: "https://example.com/",
          title: "Example",
          pinned: false,
          muted: false,
          active: true,
          groupKey: 0             // index into this window's groups, or null
        }
      ]
    }
  ]
}
```

`version` exists so a future shape change can be detected and an old snapshot
skipped rather than misread.

`groupKey` is an index local to the snapshot, **not** a live Chromium group id.
Chromium group ids do not survive a browser restart, so storing them would make
snapshots useless for exactly the case this feature exists for.

`title` is stored for a future snapshot list, and because a restored tab's title
is useful in a bug report. It is deliberately excluded from the fingerprint
below.

### What is captured

All windows where `type === "normal"` and `incognito === false`. Incognito
windows are never captured, never stored, and never restored.

Tabs are captured in index order. A tab's URL is read as
`tab.url || tab.pendingUrl || ""`, matching how the cloner handles a navigation
that has not committed.

### What is not captured

Per-tab back/forward history, scroll position, unsubmitted form input, and media
playback position. Chromium exposes no extension API for any of them. This is
the same limitation the window cloner documents.

## Storage

`chrome.storage.local`, under two keys:

- `snapshots` — an array, oldest first, capped at **20** entries. At 2-minute
  intervals that is roughly 40 minutes of history.
- `meta` — `{ browserStartedAt: number, consecutiveSuspectedLosses: number }`.

The whole `snapshots` array is rewritten on each save. At 20 snapshots of a few
hundred tabs this is well under `chrome.storage.local`'s 10 MB quota and the
write cost is negligible, so per-snapshot keys and an index are not worth the
complexity.

New permissions: `storage` and `alarms`. Combined with the existing `tabs` and
`tabGroups`, Tab Boss requests four. None grant page content access or network
access.

## Scheduling

A `chrome.alarms` alarm named `tab-boss-snapshot` with
`periodInMinutes: 2`. Alarms are used rather than `setInterval` because
Manifest V3 evicts the service worker when idle and a timer dies with it; an
alarm wakes the worker back up.

**Correction.** An earlier draft of this spec claimed `chrome.alarms.create` is
idempotent for a given name and that the alarm could therefore be created
unconditionally at the top level of the service worker. That is wrong, and it
would have stopped the feature working at all.

Chromium's documentation says the opposite: "If there is another alarm with the
same name (or no name if none is specified), it will be cancelled and replaced
by this alarm." It also says that when only `periodInMinutes` is set,
"`periodInMinutes` is used as the default for `delayInMinutes`" — so every
`create` call schedules the first fire at now + 2 minutes.

The service worker installer runs on every cold start, and Manifest V3 evicts
the worker after roughly 30 seconds idle. Tab Boss listens for
`tabs.onCreated`, `windows.onCreated`, `windows.onFocusChanged` and
`windows.onRemoved`, so ordinary intermittent browsing cold-starts it
constantly. Creating unconditionally would reset the alarm's clock each time
and it would never reach two minutes: no snapshots, no error, no log, and an
empty store the user only discovers when they need it.

So the alarm is created **only when `chrome.alarms.get` reports none**:

```js
if (!(await api.alarms.get(SNAPSHOT_ALARM))) {
  await api.alarms.create(SNAPSHOT_ALARM, {
    periodInMinutes: SNAPSHOT_PERIOD_MINUTES,
    persistAcrossSessions: true,
  });
}
```

Listener registration stays synchronous and above that check, because Manifest
V3 will not wake an evicted worker for a listener registered inside an awaited
callback. `persistAcrossSessions` is set explicitly rather than left to
Chromium's `true` default, so the alarm survives a browser restart on any
browser. No separate `onInstalled` / `onStartup` creation path is needed.

## Refusing to save

Three rules, evaluated in this order. Any rule that fires skips the save
entirely — nothing is written and nothing is pruned.

Ahead of all three sits a guard rather than a rule: a capture refuses outright
while `state.restoreInProgress` is set, returning `"restoring"`. Mid-restore the
browser holds a remnant plus a part-built window, and storing that would make it
the newest snapshot — so a click within the next two minutes would restore the
half-finished restore. The next tick self-heals, but a several-hundred-tab
restore runs longer than the two-minute period, which turns a possibility into a
certainty. The flag is checked at the top of the capture and again immediately
before the write, with no `await` in the gap, because the first check cannot see
a toolbar click that landed while the windows were being read.

When there is no stored snapshot yet, rules 2 and 3 do not apply — they both
compare against a previous snapshot that does not exist. Only the quiet period
can block the very first save.

### 1. Quiet period

`chrome.runtime.onStartup` writes `meta.browserStartedAt = Date.now()` **and
resets `meta.consecutiveSuspectedLosses` to 0**. A save is skipped while
`Date.now() - meta.browserStartedAt < 60_000`.

The counter reset matters as much as the clock. A fresh browser session is not a
continuation of yesterday's evidence that the user deliberately closed half
their tabs. Carried over, a counter sitting at 2 when the browser went down
would let the very first capture of the new session take the escape hatch below
and make a post-crash remnant the newest snapshot — collapsing the six-minute
buffer to nothing.

**Known gap.** The reset only helps once `onStartup` has actually run. A
persisted alarm that is already overdue can fire first, and a capture at that
moment still reads the previous session's counter *and* the previous session's
`browserStartedAt`, so it bypasses the quiet period and can take the escape
hatch immediately. Closing that properly needs the counter held somewhere the
browser clears on restart by itself — `chrome.storage.session` — rather than a
reset that races the alarm. Left open deliberately; see the final review notes.

Both writers patch only the fields they own, through a `updateMeta(api, patch)`
helper that re-reads immediately before writing, rather than writing back a
whole object read several `await`s earlier. Without that, an `onStartup` landing
inside a capture's `windows.getAll` had its `browserStartedAt` overwritten with
the stale value. It narrows the race to a single storage round trip rather than
eliminating it; a serialised lock is rejected, because a lock held by a worker
Manifest V3 can evict mid-hold is worse than the race it closes.

A browser that has just crashed and relaunched into a reduced set of tabs
therefore cannot overwrite good history during its first minute.

`chrome.runtime.onInstalled` writes the same field, so a fresh install has a
defined value. If `meta.browserStartedAt` is absent the quiet period does not
apply — a missing value must not block snapshots forever.

### 2. Suspected loss

Let `candidate` be the snapshot just built and `newest` the most recent stored
snapshot. If

```
totalTabs(candidate) * 2 < totalTabs(newest)
```

the tab count has more than halved and the save is skipped as a suspected loss.

**Escape hatch, and it is required.** If the user genuinely closes half their
tabs, this rule would block every future save forever. So each skip increments
`meta.consecutiveSuspectedLosses`. When it reaches **3** — six minutes of the
low count persisting — the save proceeds anyway and the counter resets to 0.

Any successful save resets the counter to 0.

A suspected-loss skip logs one line at `console.log` with the `[Tab Boss] `
prefix, including both counts, so the behaviour is explicable if the user ever
wonders why a snapshot is missing. It is routine, not a failure, so it is not a
`console.warn`.

### 3. No change

A fingerprint string is computed from the candidate and compared to the
fingerprint of the newest stored snapshot. Identical means skip.

The fingerprint covers: window order, and per window the ordered tabs with their
URL, pinned, muted, active, and `groupKey`, plus each group's title, colour, and
collapsed state.

It deliberately excludes `takenAt` and `title`. Titles change as pages load and
as sites update them, which would defeat deduplication entirely while telling us
nothing about layout.

A no-change skip is silent. It is the common case.

## Restore

A toolbar icon (`manifest.action`) with no popup. `chrome.action.onClicked`
triggers the restore.

1. Read `snapshots`. If it is empty, or the newest entry's `version` is not 1,
   or its `windows` is not an array, show `!` in the action badge for 3 seconds
   and stop. Restore must never fail silently. The `windows` check is not
   belt-and-braces: the store validates only that the stored value is an array,
   so a stored `{version: 1}` from a corrupted profile — one of the three
   scenarios this feature exists for — otherwise threw
   `snapshot.windows is not iterable` out of the `action.onClicked` listener as
   an unhandled rejection, and the icon did nothing at all. For the same reason
   the window loop is wrapped, so an unanticipated throw mid-restore still
   flashes the badge instead of escaping the listener. The 3-second clear is a `setTimeout` and therefore best-effort — an
   evicted service worker may leave the badge up. A lingering `!` is harmless
   and is cleared by the next successful restore, so this does not warrant an
   alarm.
2. Set `state.restoreInProgress = true` (see "Interaction with the cloner").
3. For each window in the snapshot, in order:
   - `chrome.windows.create({})`, which opens with a single blank placeholder
     tab. Record the new window id in `state.suppressedWindowIds` immediately.
   - Write the window's tabs with the shared writer.
   - Remove the placeholder **only if at least one tab was written**. Removing a
     window's last tab closes the window; an all-unclonable snapshot window must
     leave a plain empty window rather than vanishing.
4. Clear `state.restoreInProgress` in a `finally` block.

Restore never modifies, reorders, or closes any window the user already has
open. It only creates new ones.

URLs an extension may not reopen are skipped using the cloner's existing
`isClonableUrl`. Background tabs are discarded after creation, exactly as in the
cloner, so restoring a large snapshot does not load every page at once.

### Interaction with the cloner

Restore calls `chrome.windows.create`, which fires `windows.onCreated`, which is
what the window cloner listens for. Without a guard, every restored window would
itself be cloned.

`state.suppressedWindowIds` cannot solve this on its own: the window id is not
known until `windows.create` resolves, and `onCreated` can fire first.

So `cloneIntoWindow` gains one synchronous check as its first statement, before
any `await`:

```js
if (state.restoreInProgress) return false;
```

`state.restoreInProgress` is a boolean on the shared state object, set
synchronously before the first `windows.create` and cleared in a `finally`.
Because both the set and the check are synchronous, no event can interleave
between them.

`newTabPlacement` needs no new mechanism. The per-window entry in
`suppressedWindowIds` covers the restored tabs. The placeholder tab's own
`onCreated` may fire before the id is recorded, but moving the sole tab of a
one-tab window to index `-1` is a no-op.

## Extracting the shared tab writer

`src/windowCloning.js` is already the largest file in the project and a prior
review flagged it for extraction. Restore needs the same tab-writing behaviour,
including the abort-on-window-close protection from `tb-084`.

Writing that twice would fork safety-critical code. So the tab-writing half of
`copyTabs` moves into a new `src/tabWriter.js`, and both the cloner and restore
call it.

The writer takes a normalised description of what to write rather than live
Chromium tab objects, so its two callers can share it:

```js
/**
 * @param {object} api          the chrome API
 * @param {object} watch        the abort watch from the tb-084 fix
 * @param {number} targetId     the window to write into
 * @param {Array}  plan         [{ url, pinned, muted, active, groupKey }]
 * @param {Array}  groups       [{ key, title, color, collapsed }]
 * @returns {Promise<Array>}    the written pairs, for the caller to act on
 */
export async function writeTabs(api, watch, targetId, plan, groups)
```

The cloner converts live tabs into a `plan` and its live groups into `groups`.
Restore converts a stored snapshot window into the same two structures. Neither
caller reimplements ordering, muting, grouping, activation, or discarding.

The exact signature of `watch` is intentionally not pinned here — it must match
whatever the `tb-084` fix lands with. The implementation plan resolves it
against the merged code.

Ordering inside the writer is unchanged from the cloner and remains
load-bearing: create → mute → group (title and colour only) → activate →
collapse → discard, with an abort check immediately before every browser call
and no `await` in the gap.

## Files

| File | Responsibility |
| --- | --- |
| `src/snapshot.js` | Pure. Build a snapshot from window/tab data, fingerprint it, judge a suspected loss. No browser calls. |
| `src/snapshotStore.js` | Read, write, and prune `snapshots` and `meta` in `chrome.storage.local`. |
| `src/snapshotScheduler.js` | The alarm, the startup clock, and the three refusal rules. |
| `src/tabWriter.js` | Shared tab writing, extracted from `src/windowCloning.js`. |
| `src/restore.js` | Action click, newest snapshot, new windows, badge on failure. |
| `src/windowCloning.js` | Loses its tab-writing half; gains the `restoreInProgress` check. |
| `src/state.js` | Gains `restoreInProgress`, and `installAbortTracking` — the one event-driven writer of `abortedWindowIds`, installed by every feature that builds an abort watch rather than by one on another's behalf. |
| `src/background.js` | Wires the two new installers. Still no branching. |
| `manifest.json` | Adds `storage` and `alarms` permissions, and an `action`. |

Every new `src/` module follows the existing rule: no module touches the global
`chrome`. Each exports an installer or pure functions taking the API as an
argument, so tests pass `test/fakeChrome.js` instead.

`test/fakeChrome.js` gains `storage.local`, `alarms`, `action`, `runtime`
events, and `windows.create`.

## Error handling

Unchanged from the rest of the project. Expected races — a window or tab closing
mid-operation, a discard refused — are swallowed silently. Unexpected failures
use `console.warn` with the `[Tab Boss] ` prefix. Routine information, such as a
suspected-loss skip, uses `console.log` with the same prefix.

A storage read that fails or returns malformed data is treated as "no snapshots"
rather than throwing. A backup feature must never be the thing that breaks the
browser.

## Testing

Node's built-in `node:test`, no dependencies, as with the rest of the project.
Run with `npm test`. Never `node --test test/` — Node 26 misparses the bare
directory argument.

*snapshot.js (pure, no fake needed)*
- Builds the documented shape from window and tab input.
- Remaps live group ids to snapshot-local `groupKey` values.
- Reads `pendingUrl` when `url` is empty.
- Excludes incognito and non-normal windows.
- Fingerprint ignores `takenAt` and `title`.
- Fingerprint differs on a reorder, a pin change, a mute change, a group rename,
  a colour change, a collapse change, and an active-tab change.
- Suspected-loss judgement at, just above, and just below the halving threshold.

*snapshotStore.js*
- Caps at 20, dropping oldest first.
- Returns the newest correctly.
- A malformed or absent value reads as empty rather than throwing.
- `meta` round-trips.

*snapshotScheduler.js*
- Skips inside the quiet period; saves outside it.
- A missing `browserStartedAt` does not block a save.
- Skips on suspected loss and increments the counter.
- Saves on the third consecutive suspected loss and resets the counter.
- A successful save resets the counter.
- Skips an unchanged layout silently.
- The alarm fires the save.

*tabWriter.js*
- Every test currently covering `copyTabs` moves here unchanged in meaning,
  including the full abort-on-window-close suite from `tb-084`.
- Both callers produce the same written result from equivalent input.

*restore.js*
- Restores windows in order with tabs, pinned, muted, groups, and active tab.
- Creates new windows; never touches existing ones.
- Skips unclonable URLs.
- Leaves the placeholder alive when a snapshot window yields zero written tabs.
- Shows the badge and stops when there is nothing to restore.
- Shows the badge and stops on an unknown `version`.
- Sets and clears `restoreInProgress`, including when the restore throws.
- A restored window is not cloned by the window cloner.

*windowCloning.js*
- `cloneIntoWindow` returns `false` immediately when `restoreInProgress` is set,
  making no browser calls at all.

Manual smoke test, added to `README.md`:
1. Confirm snapshots are taken under *intermittent* browsing: browse in bursts
   with 45-second idle gaps, so the service worker is evicted and cold-started
   repeatedly, then check `snapshots.length` is greater than zero. Continuous
   use proves nothing here — a worker that never goes idle never cold-starts,
   and the cold start is what used to reset the alarm.
2. Open several tabs including a pinned one, a muted one, and two groups. Wait
   two minutes, then click the Tab Boss icon. A new window appears matching the
   layout. Existing windows are untouched.
3. With no snapshots stored, click the icon. The badge shows `!`.
4. Close half the tabs. Confirm from the service worker console that snapshots
   are skipped, then that one is taken about six minutes later.
5. Quit and relaunch. Confirm no snapshot is taken in the first minute.

## Rejected alternatives

**A snapshot list with a picker.** Offered and declined in favour of one-click
restore of the newest. The risk this creates — the newest snapshot being a
post-crash remnant — is what the quiet period and the suspected-loss rule exist
to prevent. If those rules prove insufficient in use, a picker is the fix, and
the stored data already supports one without a migration.

**Named, manually saved layouts.** A session manager is a different product.
Considered and deferred; the safety net comes first.

**Event-driven snapshots on every tab change, debounced.** Rejected: under
Manifest V3 the service worker is evicted between events, so a debounce timer is
unreliable. The alarm is the mechanism Chromium provides for exactly this.

## Non-goals

- No syncing between machines. `chrome.storage.local` only.
- No export or import file.
- No settings page. The 2-minute interval, the 20-snapshot cap, the 60-second
  quiet period, and the 3-strike escape hatch are constants in code.
- No restore into existing windows.
