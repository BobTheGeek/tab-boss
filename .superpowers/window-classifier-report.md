# Window classifier — observation-only instrument

Branch `feat/window-classifier`, two commits, not pushed. `TAB_WRITING_ENABLED`
is still `false` and untouched.

## What was built

**`src/windowClassifier.js`** — pure decision logic. No browser calls, no
imports that touch the browser at load time. Takes an observation, returns
`{ wouldClone, reasons }`. It evaluates all five conditions rather than
short-circuiting, so a record says why a window passed as well as why it
failed. Fails closed: any signal that is missing, malformed, or of the wrong
type is a veto.

**`src/windowObserver.js`** — the gathering half. Registers
`windows.onCreated`, `windows.onFocusChanged`, `runtime.onStartup` and
`runtime.onInstalled`; collects signals; asks the classifier; persists.

**`src/background.js`** — `installWindowDiagnostic` removed, replaced by
`installWindowObserver(chrome)` registered synchronously at the top level and
outside the `TAB_WRITING_ENABLED` block.

**`test/fakeChrome.js`** — gained `createManualClock`, a hand-driven clock
shaped to be injected as `{ now, wait }`. `advance(ms)` is deliberately
synchronous — it only resolves timers that have come due; the test then awaits
`observer.idle()`, which is far more reliable than flushing an unknown number
of microtask turns. Nothing existing changed.

## The stored record

Key `windowObservations` in `chrome.storage.local`. An array, oldest first,
capped at `MAX_OBSERVATIONS` (200), oldest dropped first. `snapshots` and
`meta` are never written — a test asserts every `storage.local.set` names only
this key.

A real record, generated from the code:

```json
{
  "version": 1,
  "createdAt": 1700000000000,
  "recordedAt": 1700000000429,
  "windowId": 2,
  "typeAtCreate": "normal",
  "typeAfterGrace": "normal",
  "incognito": false,
  "focusedAtCreate": true,
  "tabCount": 1,
  "tabUrls": ["chrome://newtab/"],
  "browserStartedAt": 1699999400000,
  "startupSeenAt": null,
  "msSinceBrowserStart": 600000,
  "windowsCreatedInLastTwoSeconds": 1,
  "becameFocused": true,
  "becameFocusedWithinMs": 28,
  "wouldClone": true,
  "reasons": [
    "ok:normal-window",
    "ok:one-blank-tab",
    "ok:sinceStart=600000ms",
    "ok:no-burst",
    "ok:focused-in=28ms"
  ]
}
```

Notes on three fields that are not in the brief:

- `typeAfterGrace` — the window's type re-read via `windows.get` after the
  grace period, `null` if the window has gone. This is the one real lead the
  diagnostic I deleted was carrying: the cloner's gate and the failure it
  produced disagreed about a window's type, so whether the type changes after
  creation is still open. `windows.get` is on the allowed-calls list.
- `browserStartedAt` — the raw value, so the log is replayable and staleness is
  diagnosable. See the concerns below.
- `startupSeenAt` — when this service worker saw `runtime.onStartup` or
  `onInstalled`, `null` if it has not. Recorded, never acted on. It is the
  signature that distinguishes "genuinely a long-running session" from "a stale
  timestamp from the previous session". See concern 1.

`reasons` strings are stable and greppable: `ok:` / `no:` prefix, then a short
tag. Vetoes carry their value — `no:burst=14`, `no:startup-quiet=1200ms`,
`no:focused-late=612ms`, `no:tabCount=3`, `no:type=popup`,
`no:msSinceBrowserStart-unknown`, `no:tabs-unknown`, `no:never-focused`,
`no:incognito-or-unknown`, `no:tab-not-blank`, `no:burst-unknown`.

## Thresholds

All exported named constants in **`src/windowClassifier.js`**, so tuning is one
file and the observer imports rather than redeclares them:

| Constant | Value | What it does |
| --- | --- | --- |
| `STARTUP_QUIET_MS` | `90_000` | Below this since browser start, nothing is a Cmd+N. The constant that kills the restore storm. |
| `FOCUS_GRACE_MS` | `400` | How fast a window must take focus. Also how long the observer waits before writing a record. |
| `BURST_WINDOW_MS` | `2_000` | Width of the burst counter's window. |
| `MAX_WINDOWS_IN_BURST` | `1` | More than this inside the burst window is a machine. |

`src/windowObserver.js` holds only storage-shaped constants:
`OBSERVATIONS_KEY`, `MAX_OBSERVATIONS` (200), `MAX_RECORDED_TAB_URLS` (5).

`FOCUS_GRACE_MS` is measured signed, and the classifier tests its magnitude.
Chromium does not promise whether `onCreated` or `onFocusChanged` is delivered
first — `state.js` already derives the clone source that way rather than
trusting one of them — so a focus that lands 20ms *before* the create event is
recorded as `-20` and still counts.

## Proof that nothing mutating was added

```
$ git diff a6f9964..HEAD -U0 | grep -E "^\+" | grep -vE "^\+\+\+" \
    | grep -nE "tabs\.(create|move|remove|update|group|discard)|windows\.(create|remove)"
none — clean

$ grep -nE "tabs\.(create|move|remove|update|group|discard)|windows\.(create|remove)" \
    src/windowObserver.js src/windowClassifier.js
none — clean
```

Every `api.*` call site in the two new source files, exhaustively:

```
src/windowObserver.js:41   api.storage.local.get(
src/windowObserver.js:59   api.storage.local.get(
src/windowObserver.js:63   api.storage.local.set(
src/windowObserver.js:130  api.runtime.onStartup.addListener(
src/windowObserver.js:131  api.runtime.onInstalled.addListener(
src/windowObserver.js:133  api.windows.onFocusChanged.addListener(
src/windowObserver.js:148  api.windows.onCreated.addListener(
src/windowObserver.js:188  api.tabs.query(
src/windowObserver.js:206  api.windows.get(
```

`src/windowClassifier.js` has none — it never receives an `api`.

This is also enforced by a test rather than only by a grep: *"the observer never
asks the browser to change anything"* asserts the fake's call log against an
allowlist of `tabs.query`, `windows.get`, `storage.local.get`,
`storage.local.set`. Mutation M6 below confirms that test bites.

No manifest change; `storage` was already granted.

## Test evidence

**Baseline**: 167 pass.

**RED, observer**: the observer's test file was written before
`src/windowObserver.js` existed and failed on the missing module —
`✖ test/windowObserver.test.js ... ℹ pass 0 ℹ fail 1`.

**GREEN**: 209 pass, 0 fail (167 existing + 20 classifier + 22 observer).

The classifier's implementation was written before its tests, so it has no
honest RED. In its place I mutation-tested the whole new suite — each mutation
applied alone to a clean tree, then reverted:

| Mutation | Result |
| --- | --- |
| M1 appends not serialised | 2 fail |
| M2 unknown `browserStartedAt` no longer vetoes | 3 fail |
| M3 burst counter never ages out | 1 fail |
| M4 startup quiet period ignored | 4 fail |
| M5 focus no longer required | 5 fail |
| M6 observer calls `tabs.create` | 1 fail |
| M7 log cap removed | 1 fail |
| M8 a failed `tabs.query` reads as empty instead of unknown | 1 fail |
| M9 a failed log read starts fresh instead of skipping the write | 1 fail |
| M10 non-`normal` window type accepted | 1 fail |

Every guard in the brief has at least one test that fails when the guard is
removed. Restored tree: 42 pass, 0 fail.

Scenarios the brief asked for, all covered and all passing: each of the five
conditions independently vetoing; the happy Cmd+N; a twenty-window storm inside
a second shortly after startup with only one window focused (every one `false`,
and all twenty records persisted — M1 proves that assertion is real); a genuine
Cmd+N arriving during a storm (still `false`); missing `browserStartedAt`
(`false`); the burst counter ageing out so two Cmd+N a minute apart both read
`windowsCreatedInLastTwoSeconds: 1`; the 200-record cap dropping oldest first.

## What I think is wrong with the proposed rule

Three things. None of them can hurt anyone while this is observation-only, and
all three are visible in the log, which is why I built the rule as specified and
recorded the extra evidence rather than quietly changing it.

### 1. `msSinceBrowserStart` can be stale in exactly the situation it exists for

This is the one I would fix before enabling writing.

`meta.browserStartedAt` lives in `chrome.storage.local`, which survives a
restart, and it is written by `runtime.onStartup`. If a Space-restore storm
reaches the observer *before* `onStartup` does, `readMeta` returns the
**previous** session's timestamp. `msSinceBrowserStart` is then hours, condition
3 passes, and the guard that exists to kill the restore storm is inert during
the restore storm.

This is not hypothetical. The project already has a test documenting the same
race for the snapshot scheduler: *"an alarm that fires before onStartup cannot
save a halved candidate"* in `test/snapshotScheduler.test.js`, whose comment
says outright that the persisted alarm fires before `onStartup` so
`browserStartedAt` is still the previous session's value. The scheduler was
restructured to stop depending on winning that race. Condition 3 depends on
winning it.

Conditions 4 and 5 still stand in the way, so the rule does not collapse — but
the layer specifically designed for this failure is the one that can silently
vanish, and a slow restore (Spaces arriving more than two seconds apart, each
taking focus as it is rebuilt) would then pass all five.

`startupSeenAt` in the record is there to measure this. A record with a large
`msSinceBrowserStart` and `startupSeenAt: null` is the fingerprint. If the log
shows that pattern during a restart, the fix is to treat `browserStartedAt` as
unknown until this worker has seen `onStartup` — or to keep a session-storage
marker for the current session, the same move the scheduler already made for
the loss counter.

### 2. Condition 3 assumes Spaces are only created at launch

The user's requirement is *"I only care about actual windows, launched either by
CMD+N or File > New Window."* A Space created by hand at 3pm is not one of
those. But it presumably arrives as a normal window with one blank tab, alone,
taking focus, long past `STARTUP_QUIET_MS` — all five conditions hold, and the
classifier says clone. That is the same user-visible disaster as the original
bug, just one window at a time instead of ten.

I could not find a signal in the extension API that distinguishes "new Space"
from "new window". If the log shows manually-created Spaces coming out
`wouldClone: true`, no amount of threshold tuning fixes it and the feature needs
a different trigger entirely — a `commands` keyboard shortcut the user presses
deliberately, for instance, rather than inferring intent from `onCreated`.

Worth checking on the live browser before a day of logging: create a Space by
hand and see what the record says.

### 3. The burst counter does not survive service worker eviction

`windowsCreatedInLastTwoSeconds` is in-memory and resets to 1 whenever MV3
evicts the worker. During a launch storm the worker is busy and unlikely to be
evicted mid-storm, so this is probably fine, but it is a guard that can be
switched off by something outside our control. The log will show it: a record
with `windowsCreatedInLastTwoSeconds: 1` sitting between two records with a
high count is an eviction. If that turns out to be common, the counter belongs
in `chrome.storage.session`, which survives eviction and is cleared on shutdown
— again the move the scheduler already made.

### Two smaller notes

- **Condition 5 has a false-negative mode I have not been able to rule out.** A
  Cmd+N pressed while the machine is loaded may not deliver
  `windows.onFocusChanged` within 400ms, and the user simply loses that clone.
  The log answers it directly: `becameFocusedWithinMs` is recorded even when it
  fails the threshold, so a day of real presses shows the actual distribution
  and `FOCUS_GRACE_MS` can be set from data.
- **The 400ms grace delays every record by 400ms.** Irrelevant for an
  instrument. It would matter for a cloner, which currently races to fill the
  window before the user types in it — worth knowing before this rule is wired
  into the real gate.

### One thing in the brief I did not follow literally

`AGENTS.md` mandates `git push` to finish a session. The brief says explicitly
**do not push**. I followed the brief. Two commits sit unpushed on
`feat/window-classifier`.

## How to read the log

In the service worker console:

```js
(await chrome.storage.local.get("windowObservations")).windowObservations
```

Or filter the live console on `[Tab Boss dx]`. The interesting queries are: any
record with `wouldClone: true` that was not a deliberate Cmd+N (a false
positive — the expensive kind), and any record with `wouldClone: false` whose
`reasons` are all near-misses (a false negative — the cheap kind).
