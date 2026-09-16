# Window classifier — observation-only instrument

Branch `feat/window-classifier`, four commits, not pushed. `TAB_WRITING_ENABLED`
is still `false` and untouched.

> **Update — concern 1 is closed.** Condition 3 no longer keys off
> `meta.browserStartedAt`. It keys off a marker in `chrome.storage.session`,
> which the browser clears on shutdown. See
> [Closing concern 1](#closing-concern-1-the-session-marker) for the change, its
> tests, and its RED/GREEN. Concern 2 is deliberately left open and the record
> was reshaped so the log can settle it. Concern 3 is left as it was, by
> agreement, for the same reason: it has not been measured yet.

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
  "at": "2025-12-01T14:40:00.000Z",
  "createdAt": 1764600000000,
  "recordedAt": 1764600000429,
  "msSincePreviousWindow": null,
  "windowId": 2,
  "typeAtCreate": "normal",
  "typeAfterGrace": "normal",
  "incognito": false,
  "focusedAtCreate": true,
  "tabCount": 1,
  "tabUrls": ["chrome://newtab/"],
  "sessionStartedAt": 1764599400000,
  "msSinceSessionStart": 600000,
  "browserStartedAt": 1764599400000,
  "startupSeenAt": null,
  "msSinceBrowserStart": 600000,
  "windowsCreatedInLastTwoSeconds": 1,
  "becameFocused": true,
  "becameFocusedWithinMs": 28,
  "wouldClone": true,
  "reasons": [
    "ok:normal-window",
    "ok:one-blank-tab",
    "ok:sinceSessionStart=600000ms",
    "ok:no-burst",
    "ok:focused-in=28ms"
  ]
}
```

`msSinceSessionStart` is the signal condition 3 actually uses. Everything else
below it in that block is evidence, not input.

Notes on the fields that are not in the brief:

- `at` and `msSincePreviousWindow` — for reading, not for deciding. See
  [Making concern 2 answerable](#making-concern-2-answerable).
- `typeAfterGrace` — the window's type re-read via `windows.get` after the
  grace period, `null` if the window has gone. This is the one real lead the
  diagnostic I deleted was carrying: the cloner's gate and the failure it
  produced disagreed about a window's type, so whether the type changes after
  creation is still open. `windows.get` is on the allowed-calls list.
- `browserStartedAt`, `msSinceBrowserStart`, `startupSeenAt` — kept after the
  fix, deliberately, and no longer decisive. They are how we check that
  `storage.session` behaves on ego lite the way the documentation claims.
  A record with a large `msSinceBrowserStart`, a small `msSinceSessionStart`
  and `startupSeenAt: null` is the old bug caught in the act: a restart where
  the `storage.local` timestamp was stale and the session marker caught it.
  If `msSinceSessionStart` is ever the *larger* of the two after a restart, the
  session marker is not being cleared and the whole fix is void.

`reasons` strings are stable and greppable: `ok:` / `no:` prefix, then a short
tag. Vetoes carry their value — `no:burst=14`, `no:startup-quiet=1200ms`,
`no:focused-late=612ms`, `no:tabCount=3`, `no:type=popup`,
`no:sessionStart-unknown`, `no:tabs-unknown`, `no:never-focused`,
`no:incognito-or-unknown`, `no:tab-not-blank`, `no:burst-unknown`.

`chrome.storage.session` holds one key, `sessionStartedAt`, and a test asserts
that is the only key the observer ever writes there.

## Thresholds

All exported named constants in **`src/windowClassifier.js`**, so tuning is one
file and the observer imports rather than redeclares them:

| Constant | Value | What it does |
| --- | --- | --- |
| `STARTUP_QUIET_MS` | `90_000` | Below this since the **session** marker, nothing is a Cmd+N. The constant that kills the restore storm. |
| `FOCUS_GRACE_MS` | `400` | How fast a window must take focus. Also how long the observer waits before writing a record. |
| `BURST_WINDOW_MS` | `2_000` | Width of the burst counter's window. |
| `MAX_WINDOWS_IN_BURST` | `1` | More than this inside the burst window is a machine. |

`src/windowObserver.js` holds only storage-shaped constants:
`OBSERVATIONS_KEY`, `SESSION_START_KEY`, `MAX_OBSERVATIONS` (200),
`MAX_RECORDED_TAB_URLS` (5).

`FOCUS_GRACE_MS` is measured signed, and the classifier tests its magnitude.
Chromium does not promise whether `onCreated` or `onFocusChanged` is delivered
first — `state.js` already derives the clone source that way rather than
trusting one of them — so a focus that lands 20ms *before* the create event is
recorded as `-20` and still counts.

## Proof that nothing mutating was added

```
$ git diff a6f9964..HEAD -U0 -- 'src/*.js' 'test/*.js' | grep -E "^\+" \
    | grep -vE "^\+\+\+" \
    | grep -nE "tabs\.(create|move|remove|update|group|discard)|windows\.(create|remove)"
none — clean

$ grep -nE "tabs\.(create|move|remove|update|group|discard)|windows\.(create|remove)" \
    src/windowObserver.js src/windowClassifier.js
none — clean
```

The diff grep is scoped to `src/` and `test/` on purpose: run over the whole
diff it matches this very report, on the line describing mutation M6. That is
the only hit in the branch, and it is prose.

Every `api.*` call site in the two new source files, exhaustively:

```
src/windowObserver.js:59   api.storage.local.get(
src/windowObserver.js:98   api.storage.session.get(
src/windowObserver.js:102  api.storage.session.set(
src/windowObserver.js:110  api.storage.local.get(
src/windowObserver.js:114  api.storage.local.set(
src/windowObserver.js:202  api.runtime.onStartup.addListener(
src/windowObserver.js:203  api.runtime.onInstalled.addListener(
src/windowObserver.js:205  api.windows.onFocusChanged.addListener(
src/windowObserver.js:220  api.windows.onCreated.addListener(
src/windowObserver.js:274  api.tabs.query(
src/windowObserver.js:301  api.windows.get(
```

`src/windowClassifier.js` has none — it never receives an `api`.

`storage.session.set` is the one genuine write outside the log, and it is the
session marker. Two tests pin it down: it names only `SESSION_START_KEY`, and
it happens exactly once — at the install that finds the key absent.

This is also enforced by a test rather than only by a grep: *"the observer never
asks the browser to change anything"* asserts the fake's call log against an
allowlist of `tabs.query`, `windows.get`, `storage.local.get/set` and
`storage.session.get/set`. The allowlist grew two entries for the session
marker, so I re-ran mutation M6 afterwards to confirm it still catches a writer.
It does.

No manifest change; `storage` was already granted, and it covers the `session`
area as well as `local`.

## Test evidence

**Baseline**: 167 pass.

**RED, observer**: the observer's test file was written before
`src/windowObserver.js` existed and failed on the missing module —
`✖ test/windowObserver.test.js ... ℹ pass 0 ℹ fail 1`.

**GREEN**: 218 pass, 0 fail (167 existing + 20 classifier + 31 observer).

The classifier's implementation was written before its tests, so it has no
honest RED. In its place I mutation-tested the whole new suite — each mutation
applied alone to a clean tree, then reverted:

| Mutation | Result |
| --- | --- |
| M1 appends not serialised | 2 fail |
| M2 unknown start time no longer vetoes | 3 fail |
| M3 burst counter never ages out | 1 fail |
| M4 startup quiet period ignored | 4 fail |
| M5 focus no longer required | 5 fail |
| M6 observer calls `tabs.create` | 1 fail |
| M7 log cap removed | 1 fail |
| M8 a failed `tabs.query` reads as empty instead of unknown | 1 fail |
| M9 a failed log read starts fresh instead of skipping the write | 1 fail |
| M10 non-`normal` window type accepted | 1 fail |

Every guard in the brief has at least one test that fails when the guard is
removed. Restored tree: 42 pass, 0 fail at that point.

One mutation is worth calling out because it does not produce a number. Making
the observer call `windows.create` does not fail the suite, it **hangs** it: the
fake re-emits `onCreated` for the window it just made, so the observer observes
its own window and creates another, forever. An instrument that writes windows
cannot terminate. That is a fair description of the original bug.

Scenarios the brief asked for, all covered and all passing: each of the five
conditions independently vetoing; the happy Cmd+N; a twenty-window storm inside
a second shortly after startup with only one window focused (every one `false`,
and all twenty records persisted — M1 proves that assertion is real); a genuine
Cmd+N arriving during a storm (still `false`); a missing start time (`false`);
the burst counter ageing out so two Cmd+N a minute apart both read
`windowsCreatedInLastTwoSeconds: 1`; the 200-record cap dropping oldest first.

## Closing concern 1: the session marker

### The change

Condition 3 now keys off `msSinceSessionStart`, derived from a
`sessionStartedAt` marker in `chrome.storage.session`. `meta.browserStartedAt`
is still recorded, and decides nothing.

The observer claims the marker at install: read the key, and write `now()` only
if it is absent. Claiming at install rather than lazily on the first window
anchors the marker to when the worker came up, which is usually before the
storm rather than in the middle of it. The claim is kicked off without being
awaited, because every listener must still be registered synchronously at the
top level or MV3 will not wake an evicted worker for the event.

The storage area is the entire mechanism. `storage.local` survives a restart,
so a marker kept there is exactly as stale as the value it replaced.
`storage.session` is cleared by the browser on shutdown, so "absent" means
"first worker start since the browser came up" as a property of the storage
area rather than as a race against `runtime.onStartup` that we have to win.
This is the same move the snapshot scheduler's loss counter already made, for
the same reason, and `src/snapshotStore.js` already documents the reasoning at
length.

Three details worth recording:

- **Get-then-set-if-absent, not serialised.** MV3 cold-starts this worker many
  times per session, and only the run that finds the key absent writes it. Two
  near-simultaneous cold starts could both find it absent and both write; that
  race is harmless, because they would write timestamps milliseconds apart and
  the value is only ever compared against a 90-second threshold.
- **A mid-session claim is possible and safe.** A transient storage failure, or
  an extension reload — which also clears session storage — makes the session
  look brand new and suppresses cloning for `STARTUP_QUIET_MS`. That is the
  direction this rule is built to fail in.
- **One failure does not blind the worker for its lifetime.** If the claim
  resolves to `null`, the next observation re-attempts it rather than caching
  the failure.

### Tests, and RED/GREEN

Seven new tests, all in `test/windowObserver.test.js`:

| Test | What it pins |
| --- | --- |
| a fresh session claims the marker and puts its windows inside the quiet period | empty `storage.session` ⇒ marker claimed at `now()`, `msSinceSessionStart: 0`, `wouldClone: false` |
| a session marker two hours old puts its windows outside the quiet period | the happy case still works |
| a browserStartedAt that outlived its browser no longer passes the quiet period | **the bug itself** |
| a cold start that finds the marker leaves it exactly where it was | zero `storage.session.set` calls; an eviction cannot reset the quiet period |
| an unreadable session marker is a no, not a yes | fails closed |
| a session marker claim is attempted again after a storage failure | one glitch does not blind the worker |
| the session marker is the only thing ever written to session storage | written once, at install, one key |

**RED** for this fix is not a missing module — it is a revert. Mutation N1
points condition 3 back at `browserStartedAt`, which is precisely the code as I
first shipped it, and the suite goes red:

```
ℹ pass 45 ℹ fail 6   <- N1 condition 3 keys off browserStartedAt again
✖ a browserStartedAt that outlived its browser no longer passes the quiet period
✖ a fresh session claims the marker and puts its windows inside the quiet period
✖ a session marker two hours old puts its windows outside the quiet period
✖ a window created inside the quiet period is refused
```

**GREEN** is the restored tree: 51 pass, 0 fail across the two new files, 218
across the suite.

The rest of the new work, mutated one at a time on a clean tree:

| Mutation | Result |
| --- | --- |
| N1 condition 3 keys off `browserStartedAt` again (the bug) | 6 fail |
| N2 marker claimed unconditionally, no set-if-absent | 9 fail |
| N3 an unreadable marker reads as `now()` instead of `null` | 2 fail |
| N5 `msSincePreviousWindow` always `null` | 3 fail |
| N6 wall-clock `at` dropped | 1 fail |

N2 failing nine tests is the interesting one: re-claiming the marker on every
install resets the quiet period, which breaks every ordinary Cmd+N case in the
suite. That is what an eviction would have done to the real gate.

I also re-ran the original mutations against the reshaped suite — M1, M3, M5,
M6, M7, M9 and M10 all still bite, with the same counts as before.

## Making concern 2 answerable

Concern 2 stays open by agreement: a Space created by hand at 3pm still passes
all five conditions, and that is a design question rather than a threshold.
What changed is that the log can now settle it at a glance. Two fields, neither
of which the classifier reads:

- **`at`** — the creation time as an ISO wall-clock string, first in the
  record. Scanning the log reads as a timeline instead of a column of epoch
  milliseconds. `09:01:03Z` is a launch; `15:47:22Z` is the afternoon.
- **`msSincePreviousWindow`** — the gap to the previous window this worker saw,
  `null` for the first. A run of `45, 45, 45` is a machine. A lone `null`, or a
  gap of minutes, is a person. No arithmetic, no cross-referencing.

The live console line was reshaped for the same reason. It now leads with a
summary and follows with the full record, so a storm is a visible *shape* in
the console rather than something you have to parse:

```
[Tab Boss dx] 2025-12-01T09:01:02.140Z window=14 would not clone burst=7 gap=45ms {"version":1,…}
```

Three tests cover this: the timeline fields, a five-window storm reading
`[null, 45, 45, 45, 45]`, and the console summary carrying `burst=2 gap=45ms`.

## What I still think is wrong with the rule

### 1. Condition 3 assumes Spaces are only created at launch

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
hand, look for the record with a lone `msSincePreviousWindow` and an afternoon
`at`, and see what `wouldClone` says.

### 2. The burst counter does not survive service worker eviction

Left in memory by agreement, because it has not been measured.

`windowsCreatedInLastTwoSeconds` resets to 1 whenever MV3 evicts the worker.
During a launch storm the worker is busy and unlikely to be evicted mid-storm,
so this is probably fine, but it is a guard that can be switched off by
something outside our control. The log will show it: a record with
`windowsCreatedInLastTwoSeconds: 1` and a small `msSincePreviousWindow`, sitting
between two records with a high count, is an eviction — the two fields disagree
precisely when the counter has been reset, which is what makes it detectable at
all. If that turns out to be common, the counter belongs in
`chrome.storage.session`, alongside the marker that now lives there.

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
**do not push**. I followed the brief and surfaced the conflict; the coordinator
confirmed they are handling the push. Four commits sit unpushed on
`feat/window-classifier`.

## How to read the log

In the service worker console:

```js
(await chrome.storage.local.get("windowObservations")).windowObservations
```

A compact view, which is how I would actually scan a day of it:

```js
console.table(
  (await chrome.storage.local.get("windowObservations")).windowObservations
    .map(({ at, windowId, wouldClone, windowsCreatedInLastTwoSeconds,
            msSincePreviousWindow, msSinceSessionStart, reasons }) =>
      ({ at, windowId, wouldClone, burst: windowsCreatedInLastTwoSeconds,
         gap: msSincePreviousWindow, sinceStart: msSinceSessionStart,
         why: reasons.filter(r => r.startsWith("no:")).join(" ") || "all clear" }))
);
```

Or filter the live console on `[Tab Boss dx]`.

The four things worth looking for:

1. **`wouldClone: true` on anything that was not a deliberate Cmd+N** — a false
   positive, the expensive kind. Most likely a hand-made Space (concern 1).
2. **`wouldClone: false` on a real Cmd+N** — a false negative, the cheap kind.
   Read the `no:` reasons; if they are mostly `focused-late`, tune
   `FOCUS_GRACE_MS` from the distribution rather than by guessing.
3. **After a restart**: `msSinceSessionStart` small while `msSinceBrowserStart`
   is hours, with `startupSeenAt: null`. That is the old bug being caught by the
   session marker. If instead `msSinceSessionStart` is the larger of the two,
   `storage.session` is not being cleared on ego lite and the fix is void.
4. **A burst count of 1 next to a tiny `msSincePreviousWindow`** — the service
   worker was evicted mid-storm (concern 2).
