# Tab Layout Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically snapshot the user's tab layout every 2 minutes and restore the newest snapshot into fresh windows with one toolbar click, so a crash cannot lose it.

**Architecture:** Three new subsystems — capture (`snapshot.js` + `snapshotStore.js` + `snapshotScheduler.js`), restore (`restore.js`), and a shared tab writer (`tabWriter.js`) extracted from the existing window cloner. Restore and cloning both write tabs through the same writer, so both inherit the abort-on-window-close protection built for `tb-084`. No module under `src/` touches the global `chrome`; each takes the API as an argument.

**Tech Stack:** Plain JavaScript ES modules. Manifest V3. Node's built-in `node:test` and `node:assert/strict`. Zero npm dependencies, no build step.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-09-16-tab-snapshots-design.md`. Read it before starting.
- The `tb-084` crash fix is merged to `main`. Build on `main`.
- `manifest.json` ends with exactly four permissions: `tabs`, `tabGroups`, `storage`, `alarms`, plus an `action` block. Never add host permissions, content scripts, or network access.
- No npm dependencies. No `package-lock.json`.
- ES modules everywhere. Run the suite with `npm test`. **Never `node --test test/`** — Node 26 misparses the bare directory argument and reports a phantom failing test. A single file (`node --test test/snapshot.test.js`) works correctly.
- All log output uses the exact prefix `[Tab Boss] `. Expected races (a window or tab closing mid-operation, a refused discard) are swallowed silently with NO log. Routine information uses `console.log`. Only unexpected failures use `console.warn`.
- A storage read that fails or returns malformed data is treated as "no snapshots" rather than throwing. A backup feature must never be the thing that breaks the browser.
- Incognito windows are never captured, stored, or restored.
- 77 tests pass at the start. Every task must leave the whole suite green.
- **On test counts:** each task below states an expected total. Task 1 moves tests between files and may add guard tests, so it can shift the baseline. Treat every later count as "this many more than the previous task left", not as an absolute to hit. Never delete a test to match a number — if your count differs, say so in your report and explain why.
- Commit after every task, Conventional Commits. Do not push; the controller merges.

## The abort watch — read this before Task 1

`src/windowCloning.js` defines `createAbortWatch(state, windowId)` returning `{ aborted(), mark() }`:

- `aborted()` — `state.abortedWindowIds.has(windowId)`
- `mark()` — `state.abortedWindowIds.add(windowId)`

`installWindowCloning` registers `api.windows.onRemoved`, which records a window id only when it is already in `state.suppressedWindowIds`. That is what bounds the set. The clone clears both sets for its own id in a `finally`.

**The rule that must survive every change in this plan:** an abort check sits immediately before every browser call, with no `await` between the check and the call. All twelve existing guards are pinned by tests. If a test stops failing when you delete a guard, the guard is not really there.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/tabWriter.js` | **New.** Writes a normalised tab plan into a target window: create, mute, group, activate, collapse, discard. The only module that mutates a target window's tabs. |
| `src/windowCloning.js` | Loses its tab-writing half. Keeps the gate, reads the source window, builds a plan, calls the writer. Gains the `restoreInProgress` check. |
| `src/snapshot.js` | **New.** Pure. Builds a snapshot object, fingerprints it, judges a suspected loss. No browser calls. |
| `src/snapshotStore.js` | **New.** Reads, writes, prunes `snapshots` and `meta` in `chrome.storage.local`. |
| `src/snapshotScheduler.js` | **New.** The alarm, the startup clock, and the three refusal rules. |
| `src/restore.js` | **New.** Action click, newest snapshot, new windows, badge on failure. |
| `src/state.js` | Gains `restoreInProgress`. |
| `src/background.js` | Wires the two new installers. Still no branching. |
| `manifest.json` | Adds `storage`, `alarms`, and `action`. |
| `test/fakeChrome.js` | Gains `storage.local`, `alarms`, `action`, `runtime` events, `windows.create`. |

---

### Task 1: Extract the shared tab writer

**This is a pure refactor. No behaviour changes.** It is first and alone because it moves safety-critical code that took four rounds to get right. The existing abort test suite is your safety net — if it goes green without you changing its meaning, the extraction is correct.

**Files:**
- Create: `src/tabWriter.js`
- Modify: `src/windowCloning.js`
- Create: `test/tabWriter.test.js`
- Modify: `test/windowCloning.test.js`

**Interfaces:**
- Consumes: `createAbortWatch` (currently private in `src/windowCloning.js` — move it to `src/state.js` and export it, since both the cloner and the writer's future callers need it).
- Produces:
  - From `src/state.js`: `createAbortWatch(state, windowId): { aborted(): boolean, mark(): void }`
  - From `src/tabWriter.js`:
    - `isClonableUrl(url): boolean` (moved from `windowCloning.js`)
    - `writeTabs(api, watch, targetId, plan, groups): Promise<Array<{ spec, tab }>>`
    - `plan` is `Array<{ url, pinned, muted, active, groupKey }>` where `groupKey` is a number or `null`
    - `groups` is `Array<{ key, title, color, collapsed }>`

**The one behaviour relocation, and it is deliberate.** Today `recreateGroups` calls `api.tabGroups.get(sourceGroupId)` — a read of the *source* window — and warns once per clone if it fails. After this task the writer makes **no source-window calls at all**; its only failure mode is the target. So `tabGroups.get` moves up into `windowCloning.js`'s plan-building phase, and the "could not recreate a tab group" warning moves with it. Observable behaviour is unchanged: still at most one warning per clone, and the clone still completes. Tests asserting it move from `windowCloning.test.js` to wherever the read now lives.

- [ ] **Step 1: Move `createAbortWatch` into `src/state.js` and export it**

Append to `src/state.js`:

```js
/**
 * A one-window view of the abort set, so callers ask "has my window gone?"
 * rather than reaching into shared state. `mark()` is for a caller that learns
 * the window is gone from a failed call rather than from windows.onRemoved.
 */
export function createAbortWatch(state, windowId) {
  return {
    aborted: () => state.abortedWindowIds.has(windowId),
    mark: () => state.abortedWindowIds.add(windowId),
  };
}
```

Delete the private copy from `src/windowCloning.js` and import it instead.

- [ ] **Step 2: Run the suite to confirm the move alone broke nothing**

Run: `npm test`
Expected: PASS, 77 tests.

- [ ] **Step 3: Commit the move**

```bash
git add src/state.js src/windowCloning.js
git commit -m "refactor: move createAbortWatch into state so both writers can share it"
```

- [ ] **Step 4: Write `src/tabWriter.js`**

```js
/** Schemes Chromium forbids an extension from opening in a new tab. */
const UNCLONABLE_PREFIXES = [
  "about:",
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "edge://",
  "ego://",
  "file://",
  "view-source:",
];

/** The one `about:` URL an extension is allowed to reopen. */
const CLONABLE_ABOUT_URL = "about:blank";

export function isClonableUrl(url) {
  if (!url) return false;
  if (url === CLONABLE_ABOUT_URL) return true;
  return !UNCLONABLE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Runs a best-effort browser call whose failure must not stop the write. */
async function ignoreFailure(promise) {
  try {
    await promise;
  } catch {
    // Best effort only.
  }
}

/**
 * Rebuilds the plan's groups in the target window.
 *
 * Collapsed state is NOT applied here. Chromium refuses to collapse a group
 * holding the active tab, so the caller applies it after activation and lets
 * the browser refuse where it must.
 *
 * Returns Array<{ newGroupId, collapsed }>.
 */
async function buildGroups(api, watch, targetId, written, groups) {
  const tabIdsByKey = new Map();
  for (const { spec, tab } of written) {
    if (spec.groupKey == null) continue;
    if (!tabIdsByKey.has(spec.groupKey)) tabIdsByKey.set(spec.groupKey, []);
    tabIdsByKey.get(spec.groupKey).push(tab.id);
  }

  const created = [];
  for (const group of groups) {
    const tabIds = tabIdsByKey.get(group.key);
    if (!tabIds || tabIds.length === 0) continue;
    if (watch.aborted()) return created;
    const newGroupId = await api.tabs.group({
      tabIds,
      createProperties: { windowId: targetId },
    });
    if (watch.aborted()) return created;
    await api.tabGroups.update(newGroupId, {
      title: group.title,
      color: group.color,
    });
    created.push({ newGroupId, collapsed: group.collapsed });
  }
  return created;
}

/**
 * Writes a normalised tab plan into one window.
 *
 * Ordering is load-bearing: create, then mute, then group, then activate, then
 * collapse, then discard. Discarding before activating fights the browser,
 * which refuses to discard the active tab, and collapsing before activating
 * fights it too, because it refuses to collapse a group holding the active tab.
 *
 * This is five to twenty sequential calls into one window, and the user may
 * close that window at any await. `watch.aborted()` says the window has gone;
 * it is checked immediately before every single call with no await in the gap,
 * and the write then unwinds silently with whatever it had written. Swallowing
 * the failures and pressing on is what crashed the browser in tb-084.
 *
 * Makes no calls against any window other than `targetId`.
 */
export async function writeTabs(api, watch, targetId, plan, groups) {
  const written = [];
  let skipped = 0;

  for (const spec of plan) {
    if (watch.aborted()) return written;
    if (!isClonableUrl(spec.url)) {
      skipped += 1;
      continue;
    }
    const tab = await api.tabs.create({
      windowId: targetId,
      url: spec.url,
      pinned: spec.pinned,
      active: false,
    });
    written.push({ spec, tab });
  }

  if (skipped > 0 && !watch.aborted()) {
    // Routine: a pinned chrome:// tab would warn every single time. An abort
    // says nothing at all, and the create loop can exit normally on its last
    // entry with the window already gone, so this needs its own check.
    console.log(
      `[Tab Boss] skipped ${skipped} tab(s) the browser will not let an extension reopen`,
    );
  }

  for (const { spec, tab } of written) {
    if (!spec.muted) continue;
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabs.update(tab.id, { muted: true }));
  }

  const built = await buildGroups(api, watch, targetId, written, groups);

  const activeEntry = written.find(({ spec }) => spec.active);
  if (activeEntry) {
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabs.update(activeEntry.tab.id, { active: true }));
  }

  for (const { newGroupId, collapsed } of built) {
    if (!collapsed) continue;
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabGroups.update(newGroupId, { collapsed: true }));
  }

  for (const { tab } of written) {
    if (tab.id === activeEntry?.tab.id) continue;
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabs.discard(tab.id));
  }

  return written;
}
```

- [ ] **Step 5: Rewrite `copyTabs` in `src/windowCloning.js` to build a plan and delegate**

Delete `recreateGroups`, `ignoreFailure`, `isClonableUrl`, and `UNCLONABLE_PREFIXES` from `src/windowCloning.js`. Re-export `isClonableUrl` from the writer so existing importers keep working:

```js
export { isClonableUrl } from "./tabWriter.js";
```

Replace `copyTabs` with:

```js
/**
 * Reads the source window and describes it as a plan the writer can replay.
 *
 * Every call here is against the SOURCE window, so it cannot hurt the target.
 * The watch is still consulted, because there is no point reading a source for
 * a target that has already gone.
 *
 * Returns { plan, groups } or null when the read was abandoned.
 */
async function planFromWindow(api, sourceId, watch) {
  // Reached when the removal event arrived during the gate but the window was
  // still queryable, so the caller's liveness probe said "alive" and only the
  // armed watch knows better.
  if (watch.aborted()) return null;
  const sourceTabs = (await api.tabs.query({ windowId: sourceId })).sort(
    (a, b) => a.index - b.index,
  );

  const groupKeyBySourceId = new Map();
  const groups = [];
  let warned = false;

  for (const tab of sourceTabs) {
    const groupId = tab.groupId;
    if (groupId == null || groupId === TAB_GROUP_ID_NONE) continue;
    if (groupKeyBySourceId.has(groupId)) continue;
    if (watch.aborted()) return null;
    try {
      const group = await api.tabGroups.get(groupId);
      const key = groups.length;
      groupKeyBySourceId.set(groupId, key);
      groups.push({
        key,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
    } catch (error) {
      // One group vanishing is worth a line. A user closing the source while
      // four groups are pending is not worth four.
      if (!warned) {
        warned = true;
        console.warn("[Tab Boss] could not recreate a tab group", error);
      }
    }
  }

  const plan = sourceTabs.map((tab) => ({
    // A tab whose navigation has not committed reports an empty url and
    // carries its destination in pendingUrl, exactly as isBlankTab assumes.
    url: tab.url || tab.pendingUrl || "",
    pinned: tab.pinned,
    muted: Boolean(tab.mutedInfo?.muted),
    active: Boolean(tab.active),
    groupKey: groupKeyBySourceId.has(tab.groupId)
      ? groupKeyBySourceId.get(tab.groupId)
      : null,
  }));

  return { plan, groups };
}
```

Then in `cloneIntoWindow`, replace the `copyTabs` call:

```js
      const described = await planFromWindow(api, source.id, watch);
      if (watch.aborted() || described === null) return false;
      const written = await writeTabs(
        api,
        watch,
        newWindow.id,
        described.plan,
        described.groups,
      );
      if (watch.aborted()) return false;
      if (written.length > 0) {
        await api.tabs.remove(placeholder.id);
      }
```

Import at the top: `import { isClonableUrl, writeTabs } from "./tabWriter.js";`

- [ ] **Step 6: Move the writer-side tests into `test/tabWriter.test.js`**

Every existing test in `test/windowCloning.test.js` that exercises tab writing — order, pinned, muted, active, discard-excludes-active, unclonable skipping, refused discard, group title/colour/collapsed, and **every abort test that aborts during create, mute, group, activate, collapse, or discard** — moves to `test/tabWriter.test.js`, rewritten to call `writeTabs` directly with a plan instead of going through `cloneIntoWindow`.

Tests that stay in `test/windowCloning.test.js`: the five-condition gate, source resolution and both event orderings, the suppression checks, the liveness probe, the gate-query catch, the placeholder-removal rule, and the `finally` cleanup.

The "a group that disappears mid-clone does not stop the clone" test stays in `test/windowCloning.test.js`, because `tabGroups.get` is now a source read made there.

Use this helper in the new file so a plan is cheap to write:

```js
function planOf(...urls) {
  return urls.map((url, index) => ({
    url,
    pinned: false,
    muted: false,
    active: index === 0,
    groupKey: null,
  }));
}
```

- [ ] **Step 7: Prove the guards are still real**

For each abort check in `src/tabWriter.js` — the create loop, the mute loop, before `tabs.group`, before the group `tabGroups.update`, before activation, the collapse loop, and the discard loop — delete the line, run `node --test test/tabWriter.test.js`, and confirm at least one test fails. Restore it. Record the per-guard result in your report.

A guard that stays green when deleted is not pinned. Write a test for it before moving on.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS. The count should be at or above 77 — you may have added tests, but you must not have lost any coverage.

- [ ] **Step 9: Commit**

```bash
git add src/tabWriter.js src/windowCloning.js test/tabWriter.test.js test/windowCloning.test.js
git commit -m "refactor: extract the shared tab writer from the window cloner"
```

---

### Task 2: The pure snapshot module

**Files:**
- Create: `src/snapshot.js`
- Test: `test/snapshot.test.js`

**Interfaces:**
- Consumes: `TAB_GROUP_ID_NONE` from `src/state.js`.
- Produces:
  - `SNAPSHOT_VERSION: number` (value `1`)
  - `buildSnapshot(windows, takenAt): object` — `windows` is `Array<{ window, tabs, groups }>` where `window` is a Chromium window, `tabs` its tabs, `groups` its tab groups
  - `totalTabs(snapshot): number`
  - `fingerprint(snapshot): string`
  - `isSuspectedLoss(candidate, newest): boolean`

- [ ] **Step 1: Write the failing tests**

Create `test/snapshot.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_VERSION,
  buildSnapshot,
  fingerprint,
  isSuspectedLoss,
  totalTabs,
} from "../src/snapshot.js";

function win(overrides = {}) {
  return { id: 1, type: "normal", incognito: false, focused: false, ...overrides };
}

function tab(overrides = {}) {
  return {
    url: "https://a.test/",
    title: "A",
    pinned: false,
    active: false,
    groupId: -1,
    mutedInfo: { muted: false },
    ...overrides,
  };
}

const ONE_WINDOW = [
  {
    window: win(),
    tabs: [tab(), tab({ url: "https://b.test/", title: "B", active: true })],
    groups: [],
  },
];

test("a snapshot carries its version and the time it was taken", () => {
  const snap = buildSnapshot(ONE_WINDOW, 123);
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.takenAt, 123);
});

test("tabs are captured in order with their flags", () => {
  const snap = buildSnapshot(
    [
      {
        window: win(),
        tabs: [
          tab({ pinned: true }),
          tab({ url: "https://b.test/", mutedInfo: { muted: true }, active: true }),
        ],
        groups: [],
      },
    ],
    0,
  );
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => [t.url, t.pinned, t.muted, t.active]),
    [
      ["https://a.test/", true, false, false],
      ["https://b.test/", false, true, true],
    ],
  );
});

test("live group ids are remapped to snapshot-local keys", () => {
  const snap = buildSnapshot(
    [
      {
        window: win(),
        tabs: [tab({ groupId: 77 }), tab({ groupId: 77 }), tab()],
        groups: [{ id: 77, title: "Research", color: "blue", collapsed: true }],
      },
    ],
    0,
  );
  assert.deepEqual(snap.windows[0].groups, [
    { key: 0, title: "Research", color: "blue", collapsed: true },
  ]);
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => t.groupKey),
    [0, 0, null],
  );
});

test("a still-loading tab is captured from pendingUrl", () => {
  const snap = buildSnapshot(
    [{ window: win(), tabs: [tab({ url: "", pendingUrl: "https://c.test/" })], groups: [] }],
    0,
  );
  assert.equal(snap.windows[0].tabs[0].url, "https://c.test/");
});

test("incognito and non-normal windows are never captured", () => {
  const snap = buildSnapshot(
    [
      { window: win({ id: 1, incognito: true }), tabs: [tab()], groups: [] },
      { window: win({ id: 2, type: "popup" }), tabs: [tab()], groups: [] },
      { window: win({ id: 3 }), tabs: [tab()], groups: [] },
    ],
    0,
  );
  assert.equal(snap.windows.length, 1);
});

test("totalTabs counts across every window", () => {
  const snap = buildSnapshot(
    [
      { window: win({ id: 1 }), tabs: [tab(), tab()], groups: [] },
      { window: win({ id: 2 }), tabs: [tab()], groups: [] },
    ],
    0,
  );
  assert.equal(totalTabs(snap), 3);
});

test("the fingerprint ignores when it was taken", () => {
  assert.equal(
    fingerprint(buildSnapshot(ONE_WINDOW, 1)),
    fingerprint(buildSnapshot(ONE_WINDOW, 999)),
  );
});

test("the fingerprint ignores titles, which change as pages load", () => {
  const renamed = [
    {
      window: win(),
      tabs: [tab({ title: "changed" }), tab({ url: "https://b.test/", title: "also changed", active: true })],
      groups: [],
    },
  ];
  assert.equal(fingerprint(buildSnapshot(ONE_WINDOW, 0)), fingerprint(buildSnapshot(renamed, 0)));
});

test("the fingerprint changes on anything that is layout", () => {
  const base = fingerprint(buildSnapshot(ONE_WINDOW, 0));
  const variants = {
    reorder: [{ window: win(), tabs: [tab({ url: "https://b.test/", active: true }), tab()], groups: [] }],
    pinned: [{ window: win(), tabs: [tab({ pinned: true }), tab({ url: "https://b.test/", active: true })], groups: [] }],
    muted: [{ window: win(), tabs: [tab({ mutedInfo: { muted: true } }), tab({ url: "https://b.test/", active: true })], groups: [] }],
    active: [{ window: win(), tabs: [tab({ active: true }), tab({ url: "https://b.test/" })], groups: [] }],
    grouped: [
      {
        window: win(),
        tabs: [tab({ groupId: 5 }), tab({ url: "https://b.test/", active: true })],
        groups: [{ id: 5, title: "G", color: "red", collapsed: false }],
      },
    ],
  };
  for (const [name, windows] of Object.entries(variants)) {
    assert.notEqual(fingerprint(buildSnapshot(windows, 0)), base, name);
  }
});

test("the fingerprint changes when a group is renamed, recoloured, or collapsed", () => {
  const withGroup = (group) => [
    { window: win(), tabs: [tab({ groupId: 5 })], groups: [{ id: 5, ...group }] },
  ];
  const base = fingerprint(buildSnapshot(withGroup({ title: "G", color: "red", collapsed: false }), 0));
  assert.notEqual(fingerprint(buildSnapshot(withGroup({ title: "H", color: "red", collapsed: false }), 0)), base);
  assert.notEqual(fingerprint(buildSnapshot(withGroup({ title: "G", color: "blue", collapsed: false }), 0)), base);
  assert.notEqual(fingerprint(buildSnapshot(withGroup({ title: "G", color: "red", collapsed: true }), 0)), base);
});

test("a suspected loss is a tab count that has more than halved", () => {
  const of = (count) => ({
    windows: [{ tabs: Array.from({ length: count }, () => ({})), groups: [] }],
  });
  assert.equal(isSuspectedLoss(of(4), of(10)), true);
  assert.equal(isSuspectedLoss(of(5), of(10)), false, "exactly half is not a loss");
  assert.equal(isSuspectedLoss(of(6), of(10)), false);
  assert.equal(isSuspectedLoss(of(10), of(10)), false);
  assert.equal(isSuspectedLoss(of(12), of(10)), false, "growth is never a loss");
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `node --test test/snapshot.test.js`
Expected: FAIL — `Cannot find module .../src/snapshot.js`

- [ ] **Step 3: Write `src/snapshot.js`**

```js
import { TAB_GROUP_ID_NONE } from "./state.js";

/** Bumped when the stored shape changes, so an old snapshot is skipped. */
export const SNAPSHOT_VERSION = 1;

function isCapturable(window) {
  return window.type === "normal" && !window.incognito;
}

/**
 * Builds one snapshot from live window data.
 *
 * Live Chromium group ids do not survive a browser restart, so each group is
 * remapped to a key local to the snapshot. Storing the live id would make a
 * snapshot useless for exactly the case this feature exists for.
 */
export function buildSnapshot(windows, takenAt) {
  return {
    version: SNAPSHOT_VERSION,
    takenAt,
    windows: windows.filter(({ window }) => isCapturable(window)).map(({ window, tabs, groups }) => {
      const keyByGroupId = new Map();
      const captured = [];
      for (const group of groups) {
        keyByGroupId.set(group.id, captured.length);
        captured.push({
          key: captured.length,
          title: group.title,
          color: group.color,
          collapsed: Boolean(group.collapsed),
        });
      }
      return {
        focused: Boolean(window.focused),
        groups: captured,
        tabs: tabs.map((tab) => ({
          // A tab whose navigation has not committed reports an empty url and
          // carries its destination in pendingUrl.
          url: tab.url || tab.pendingUrl || "",
          title: tab.title ?? "",
          pinned: Boolean(tab.pinned),
          muted: Boolean(tab.mutedInfo?.muted),
          active: Boolean(tab.active),
          groupKey:
            tab.groupId != null &&
            tab.groupId !== TAB_GROUP_ID_NONE &&
            keyByGroupId.has(tab.groupId)
              ? keyByGroupId.get(tab.groupId)
              : null,
        })),
      };
    }),
  };
}

export function totalTabs(snapshot) {
  return snapshot.windows.reduce((sum, window) => sum + window.tabs.length, 0);
}

/**
 * A stable string covering layout and nothing else.
 *
 * `takenAt` and `title` are excluded deliberately. Titles change as pages load
 * and as sites update them, which would defeat deduplication entirely while
 * telling us nothing about layout.
 */
export function fingerprint(snapshot) {
  return JSON.stringify(
    snapshot.windows.map((window) => [
      window.groups.map((g) => [g.key, g.title, g.color, g.collapsed]),
      window.tabs.map((t) => [t.url, t.pinned, t.muted, t.active, t.groupKey]),
    ]),
  );
}

/**
 * True when the tab count has more than halved since the newest snapshot.
 *
 * That smells like a crash or an accidental close rather than a decision, and
 * letting it overwrite good history would make the whole feature useless. The
 * scheduler owns the escape hatch for a user who really did close half.
 */
export function isSuspectedLoss(candidate, newest) {
  return totalTabs(candidate) * 2 < totalTabs(newest);
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npm test`
Expected: PASS, 88 tests.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.js test/snapshot.test.js
git commit -m "feat: build, fingerprint, and judge tab layout snapshots"
```

---

### Task 3: Snapshot storage

**Files:**
- Create: `src/snapshotStore.js`
- Modify: `test/fakeChrome.js`
- Test: `test/snapshotStore.test.js`

**Interfaces:**
- Consumes: `createFakeChrome` from `test/fakeChrome.js`.
- Produces:
  - `MAX_SNAPSHOTS: number` (value `20`)
  - `readSnapshots(api): Promise<Array>` — never throws; malformed or absent reads as `[]`
  - `newestSnapshot(api): Promise<object|null>`
  - `appendSnapshot(api, snapshot): Promise<void>` — appends and prunes to the newest `MAX_SNAPSHOTS`
  - `readMeta(api): Promise<{ browserStartedAt: number|null, consecutiveSuspectedLosses: number }>`
  - `writeMeta(api, meta): Promise<void>`
- The fake gains `api.storage.local.get(keys)` and `api.storage.local.set(items)`, backed by a `storage` Map exposed on the returned object, plus `calls` entries `["storage.local.get", keys]` and `["storage.local.set", items]`.

- [ ] **Step 1: Add `storage.local` to `test/fakeChrome.js`**

Inside `createFakeChrome`, add a `const storage = new Map();`, include `storage` in the returned object, and add to `api`:

```js
    storage: {
      local: {
        async get(keys) {
          calls.push(["storage.local.get", keys]);
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) {
            if (storage.has(key)) out[key] = structuredClone(storage.get(key));
          }
          return out;
        },
        async set(items) {
          calls.push(["storage.local.set", items]);
          for (const [key, value] of Object.entries(items)) {
            storage.set(key, structuredClone(value));
          }
        },
      },
    },
```

`structuredClone` on both sides is deliberate: real `chrome.storage` serialises, so a test that mutates a returned object must not corrupt the store.

- [ ] **Step 2: Write the failing tests**

Create `test/snapshotStore.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import {
  MAX_SNAPSHOTS,
  appendSnapshot,
  newestSnapshot,
  readMeta,
  readSnapshots,
  writeMeta,
} from "../src/snapshotStore.js";

const snap = (takenAt) => ({ version: 1, takenAt, windows: [] });

test("an empty store reads as no snapshots", async () => {
  const { api } = createFakeChrome();
  assert.deepEqual(await readSnapshots(api), []);
  assert.equal(await newestSnapshot(api), null);
});

test("snapshots round-trip oldest first", async () => {
  const { api } = createFakeChrome();
  await appendSnapshot(api, snap(1));
  await appendSnapshot(api, snap(2));
  assert.deepEqual((await readSnapshots(api)).map((s) => s.takenAt), [1, 2]);
  assert.equal((await newestSnapshot(api)).takenAt, 2);
});

test("the store keeps only the newest MAX_SNAPSHOTS, dropping oldest first", async () => {
  const { api } = createFakeChrome();
  for (let i = 1; i <= MAX_SNAPSHOTS + 5; i += 1) await appendSnapshot(api, snap(i));
  const stored = await readSnapshots(api);
  assert.equal(stored.length, MAX_SNAPSHOTS);
  assert.equal(stored[0].takenAt, 6);
  assert.equal(stored.at(-1).takenAt, MAX_SNAPSHOTS + 5);
});

test("a malformed stored value reads as no snapshots rather than throwing", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("snapshots", { not: "an array" });
  assert.deepEqual(await readSnapshots(api), []);
});

test("a storage failure reads as no snapshots rather than throwing", async () => {
  const { api } = createFakeChrome();
  api.storage.local.get = async () => {
    throw new Error("storage unavailable");
  };
  assert.deepEqual(await readSnapshots(api), []);
  assert.equal(await newestSnapshot(api), null);
});

test("meta round-trips and defaults sensibly", async () => {
  const { api } = createFakeChrome();
  assert.deepEqual(await readMeta(api), {
    browserStartedAt: null,
    consecutiveSuspectedLosses: 0,
  });
  await writeMeta(api, { browserStartedAt: 42, consecutiveSuspectedLosses: 2 });
  assert.deepEqual(await readMeta(api), {
    browserStartedAt: 42,
    consecutiveSuspectedLosses: 2,
  });
});

test("a malformed meta value reads as the defaults", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("meta", "nonsense");
  assert.deepEqual(await readMeta(api), {
    browserStartedAt: null,
    consecutiveSuspectedLosses: 0,
  });
});
```

- [ ] **Step 3: Run and verify they fail**

Run: `node --test test/snapshotStore.test.js`
Expected: FAIL — `Cannot find module .../src/snapshotStore.js`

- [ ] **Step 4: Write `src/snapshotStore.js`**

```js
/** How many snapshots to keep. At 2-minute intervals, about 40 minutes. */
export const MAX_SNAPSHOTS = 20;

const SNAPSHOTS_KEY = "snapshots";
const META_KEY = "meta";

const DEFAULT_META = {
  browserStartedAt: null,
  consecutiveSuspectedLosses: 0,
};

/**
 * Storage is a backup, so a failure to read it must never break the browser.
 * Anything unreadable or malformed is reported as "nothing stored", which the
 * callers already handle.
 */
async function readKey(api, key) {
  try {
    const result = await api.storage.local.get(key);
    return result?.[key];
  } catch {
    return undefined;
  }
}

export async function readSnapshots(api) {
  const stored = await readKey(api, SNAPSHOTS_KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function newestSnapshot(api) {
  const snapshots = await readSnapshots(api);
  return snapshots.length > 0 ? snapshots.at(-1) : null;
}

export async function appendSnapshot(api, snapshot) {
  const snapshots = await readSnapshots(api);
  snapshots.push(snapshot);
  await api.storage.local.set({
    [SNAPSHOTS_KEY]: snapshots.slice(-MAX_SNAPSHOTS),
  });
}

export async function readMeta(api) {
  const stored = await readKey(api, META_KEY);
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...DEFAULT_META };
  }
  return { ...DEFAULT_META, ...stored };
}

export async function writeMeta(api, meta) {
  await api.storage.local.set({ [META_KEY]: meta });
}
```

- [ ] **Step 5: Run and verify they pass**

Run: `npm test`
Expected: PASS, 94 tests.

- [ ] **Step 6: Commit**

```bash
git add src/snapshotStore.js test/fakeChrome.js test/snapshotStore.test.js
git commit -m "feat: store, prune, and safely read tab layout snapshots"
```

---

### Task 4: The scheduler and the three refusal rules

**Files:**
- Create: `src/snapshotScheduler.js`
- Modify: `test/fakeChrome.js`
- Test: `test/snapshotScheduler.test.js`

**Interfaces:**
- Consumes: `buildSnapshot`, `fingerprint`, `isSuspectedLoss`, `totalTabs` from `src/snapshot.js`; the whole of `src/snapshotStore.js`.
- Produces:
  - `SNAPSHOT_ALARM: string` (value `"tab-boss-snapshot"`)
  - `SNAPSHOT_PERIOD_MINUTES: number` (value `2`)
  - `QUIET_PERIOD_MS: number` (value `60_000`)
  - `MAX_CONSECUTIVE_LOSSES: number` (value `3`)
  - `captureNow(api, now): Promise<"saved"|"quiet"|"loss"|"unchanged">`
  - `installSnapshotScheduler(api): void`
- The fake gains `api.alarms.create(name, info)` (recorded in `calls`, stored in an `alarms` Map), `api.alarms.onAlarm` as an event, and `api.runtime.onStartup` / `api.runtime.onInstalled` as events.

`captureNow` returns a string rather than a boolean so its four outcomes are directly assertable. `now` is passed in rather than read from `Date.now()` so tests are deterministic.

- [ ] **Step 1: Add `alarms` and `runtime` to `test/fakeChrome.js`**

```js
    alarms: {
      onAlarm: createEvent(),
      async create(name, info) {
        calls.push(["alarms.create", name, info]);
        alarms.set(name, info);
      },
    },

    runtime: {
      onStartup: createEvent(),
      onInstalled: createEvent(),
    },
```

Add `const alarms = new Map();` and include `alarms` in the returned object.

- [ ] **Step 2: Write the failing tests**

Create `test/snapshotScheduler.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { readMeta, readSnapshots, writeMeta } from "../src/snapshotStore.js";
import {
  MAX_CONSECUTIVE_LOSSES,
  QUIET_PERIOD_MS,
  SNAPSHOT_ALARM,
  SNAPSHOT_PERIOD_MINUTES,
  captureNow,
  installSnapshotScheduler,
} from "../src/snapshotScheduler.js";

/** A fake holding one normal window with `count` tabs. */
function fakeWith(count) {
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    windowId: 1,
    index,
    url: `https://${index}.test/`,
    title: `T${index}`,
    active: index === 0,
  }));
  return createFakeChrome({ windows: [{ id: 1 }], tabs });
}

test("a capture outside the quiet period is saved", async () => {
  const { api } = fakeWith(3);
  assert.equal(await captureNow(api, 0), "saved");
  assert.equal((await readSnapshots(api)).length, 1);
});

test("a capture inside the quiet period is skipped", async () => {
  const { api } = fakeWith(3);
  await writeMeta(api, { browserStartedAt: 1000, consecutiveSuspectedLosses: 0 });
  assert.equal(await captureNow(api, 1000 + QUIET_PERIOD_MS - 1), "quiet");
  assert.deepEqual(await readSnapshots(api), []);
});

test("a capture just past the quiet period is saved", async () => {
  const { api } = fakeWith(3);
  await writeMeta(api, { browserStartedAt: 1000, consecutiveSuspectedLosses: 0 });
  assert.equal(await captureNow(api, 1000 + QUIET_PERIOD_MS), "saved");
});

test("a missing browserStartedAt never blocks a save", async () => {
  const { api } = fakeWith(3);
  assert.equal(await captureNow(api, 0), "saved");
});

test("an unchanged layout is skipped silently", async () => {
  const { api } = fakeWith(3);
  assert.equal(await captureNow(api, 0), "saved");
  assert.equal(await captureNow(api, 1), "unchanged");
  assert.equal((await readSnapshots(api)).length, 1);
});

test("a halved tab count is skipped as a suspected loss and counted", async () => {
  const { api, tabs } = fakeWith(10);
  assert.equal(await captureNow(api, 0), "saved");
  for (const id of [...tabs.keys()].slice(4)) tabs.delete(id);
  assert.equal(await captureNow(api, 1), "loss");
  assert.equal((await readMeta(api)).consecutiveSuspectedLosses, 1);
  assert.equal((await readSnapshots(api)).length, 1);
});

test("a persistent low count is accepted on the third try and resets the counter", async () => {
  const { api, tabs } = fakeWith(10);
  await captureNow(api, 0);
  for (const id of [...tabs.keys()].slice(4)) tabs.delete(id);
  for (let i = 1; i < MAX_CONSECUTIVE_LOSSES; i += 1) {
    assert.equal(await captureNow(api, i), "loss");
  }
  assert.equal(await captureNow(api, MAX_CONSECUTIVE_LOSSES), "saved");
  assert.equal((await readMeta(api)).consecutiveSuspectedLosses, 0);
  assert.equal((await readSnapshots(api)).length, 2);
});

test("a successful save resets the loss counter", async () => {
  const { api } = fakeWith(3);
  await writeMeta(api, { browserStartedAt: null, consecutiveSuspectedLosses: 2 });
  assert.equal(await captureNow(api, 0), "saved");
  assert.equal((await readMeta(api)).consecutiveSuspectedLosses, 0);
});

test("the first ever capture cannot be a loss or unchanged", async () => {
  const { api } = fakeWith(1);
  assert.equal(await captureNow(api, 0), "saved");
});

test("installing creates the repeating alarm", async () => {
  const { api, calls } = fakeWith(1);
  installSnapshotScheduler(api);
  assert.deepEqual(
    calls.filter(([name]) => name === "alarms.create"),
    [["alarms.create", SNAPSHOT_ALARM, { periodInMinutes: SNAPSHOT_PERIOD_MINUTES }]],
  );
});

test("the alarm firing takes a snapshot", async () => {
  const { api } = fakeWith(2);
  installSnapshotScheduler(api);
  await api.alarms.onAlarm.emit({ name: SNAPSHOT_ALARM });
  assert.equal((await readSnapshots(api)).length, 1);
});

test("an unrelated alarm takes no snapshot", async () => {
  const { api } = fakeWith(2);
  installSnapshotScheduler(api);
  await api.alarms.onAlarm.emit({ name: "something-else" });
  assert.deepEqual(await readSnapshots(api), []);
});

test("startup records the browser start time", async () => {
  const { api } = fakeWith(2);
  installSnapshotScheduler(api);
  await api.runtime.onStartup.emit();
  assert.notEqual((await readMeta(api)).browserStartedAt, null);
});
```

- [ ] **Step 3: Run and verify they fail**

Run: `node --test test/snapshotScheduler.test.js`
Expected: FAIL — `Cannot find module .../src/snapshotScheduler.js`

- [ ] **Step 4: Write `src/snapshotScheduler.js`**

```js
import { buildSnapshot, fingerprint, isSuspectedLoss, totalTabs } from "./snapshot.js";
import {
  appendSnapshot,
  newestSnapshot,
  readMeta,
  writeMeta,
} from "./snapshotStore.js";

export const SNAPSHOT_ALARM = "tab-boss-snapshot";
export const SNAPSHOT_PERIOD_MINUTES = 2;

/**
 * A browser that has just crashed and relaunched into a reduced set of tabs
 * must not be able to overwrite good history during its first minute.
 */
export const QUIET_PERIOD_MS = 60_000;

/**
 * How many consecutive suspected losses before we accept the low count.
 *
 * Without this, a user who deliberately closes half their tabs would block
 * every future snapshot forever.
 */
export const MAX_CONSECUTIVE_LOSSES = 3;

async function readCapturableWindows(api) {
  const windows = await api.windows.getAll();
  const described = [];
  for (const window of windows) {
    if (window.type !== "normal" || window.incognito) continue;
    const tabs = (await api.tabs.query({ windowId: window.id })).sort(
      (a, b) => a.index - b.index,
    );
    const groups = await api.tabGroups.query({ windowId: window.id });
    described.push({ window, tabs, groups });
  }
  return described;
}

/**
 * Takes one snapshot unless a refusal rule fires.
 *
 * `now` is a parameter rather than a Date.now() call so the quiet period is
 * testable without waiting a minute.
 *
 * Returns "saved" | "quiet" | "loss" | "unchanged".
 */
export async function captureNow(api, now) {
  const meta = await readMeta(api);

  if (
    meta.browserStartedAt !== null &&
    now - meta.browserStartedAt < QUIET_PERIOD_MS
  ) {
    return "quiet";
  }

  const candidate = buildSnapshot(await readCapturableWindows(api), now);
  const newest = await newestSnapshot(api);

  if (newest !== null) {
    if (fingerprint(candidate) === fingerprint(newest)) return "unchanged";

    if (isSuspectedLoss(candidate, newest)) {
      const seen = meta.consecutiveSuspectedLosses + 1;
      if (seen < MAX_CONSECUTIVE_LOSSES) {
        // Routine, not a failure: say why a snapshot is missing.
        console.log(
          `[Tab Boss] skipped a snapshot: ${totalTabs(candidate)} tabs, down from ${totalTabs(newest)}`,
        );
        await writeMeta(api, { ...meta, consecutiveSuspectedLosses: seen });
        return "loss";
      }
      // The low count has held long enough to be a decision, not a loss.
    }
  }

  await appendSnapshot(api, candidate);
  await writeMeta(api, { ...meta, consecutiveSuspectedLosses: 0 });
  return "saved";
}

export function installSnapshotScheduler(api) {
  // Manifest V3 evicts the service worker when idle and a setInterval dies
  // with it. An alarm wakes the worker back up. alarms.create is idempotent
  // for a given name, so this needs no onInstalled/onStartup creation path.
  void api.alarms.create(SNAPSHOT_ALARM, {
    periodInMinutes: SNAPSHOT_PERIOD_MINUTES,
  });

  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== SNAPSHOT_ALARM) return;
    try {
      await captureNow(api, Date.now());
    } catch (error) {
      console.warn("[Tab Boss] could not take a snapshot", error);
    }
  });

  const recordStart = async () => {
    const meta = await readMeta(api);
    await writeMeta(api, { ...meta, browserStartedAt: Date.now() });
  };

  api.runtime.onStartup.addListener(recordStart);
  api.runtime.onInstalled.addListener(recordStart);
}
```

`api.tabGroups.query` and `api.windows.getAll` are new to the fake — add them in Step 1 of this task alongside the alarms work:

```js
      async getAll() {
        calls.push(["windows.getAll"]);
        return [...windows.values()].map((win) => ({ ...win }));
      },
```

```js
      async query({ windowId }) {
        calls.push(["tabGroups.query", windowId]);
        return [...groups.values()]
          .filter((group) => group.windowId === windowId)
          .map((group) => ({ ...group }));
      },
```

- [ ] **Step 5: Run and verify they pass**

Run: `npm test`
Expected: PASS, 107 tests.

- [ ] **Step 6: Commit**

```bash
git add src/snapshotScheduler.js test/fakeChrome.js test/snapshotScheduler.test.js
git commit -m "feat: schedule snapshots and refuse to save a suspected loss"
```

---

### Task 5: Restore

**Files:**
- Create: `src/restore.js`
- Modify: `src/state.js`, `src/windowCloning.js`, `test/fakeChrome.js`
- Test: `test/restore.test.js`
- Modify: `test/windowCloning.test.js`

**Interfaces:**
- Consumes: `newestSnapshot` from `src/snapshotStore.js`; `SNAPSHOT_VERSION` from `src/snapshot.js`; `writeTabs` from `src/tabWriter.js`; `createAbortWatch` from `src/state.js`.
- Produces:
  - `BADGE_MS: number` (value `3000`)
  - `restoreNewest(api, state): Promise<number>` — the number of windows created
  - `installRestore(api, state): void`
- `src/state.js`'s `createState()` gains `restoreInProgress: false`.
- The fake gains `api.windows.create(createData)` (opens a window with one blank placeholder tab and returns it), `api.action.onClicked` as an event, and `api.action.setBadgeText(details)`.

- [ ] **Step 1: Add `restoreInProgress` to state and the guard to the cloner**

In `src/state.js`'s `createState()` return object add `restoreInProgress: false,` and extend the doc comment:

```js
 * `restoreInProgress` is true while restore is creating windows. Restore calls
 * windows.create, which fires windows.onCreated, which is what the cloner
 * listens for — without this the cloner would clone every restored window.
 * suppressedWindowIds cannot do the job: the id is not known until create
 * resolves, and onCreated can fire first.
```

As the **first statement** of `cloneIntoWindow`, before `resolveSourceWindowId` and before any `await`:

```js
  // Restore creates windows of its own. Both this check and the flag's setter
  // are synchronous, so no event can interleave between them.
  if (state.restoreInProgress) return false;
```

- [ ] **Step 2: Add `windows.create` and `action` to `test/fakeChrome.js`**

```js
      async create(createData = {}) {
        calls.push(["windows.create", createData]);
        const id = nextWindowId++;
        windows.set(id, { ...WINDOW_DEFAULTS, id, ...createData });
        const tabId = nextTabId++;
        tabs.set(tabId, {
          ...TAB_DEFAULTS,
          id: tabId,
          windowId: id,
          index: 0,
          url: "about:blank",
          active: true,
        });
        return { ...windows.get(id) };
      },
```

```js
    action: {
      onClicked: createEvent(),
      async setBadgeText(details) {
        calls.push(["action.setBadgeText", details]);
        badge.text = details.text;
      },
    },
```

Add `let nextWindowId = 50;`, `const badge = { text: "" };`, and include `badge` in the returned object.

- [ ] **Step 3: Write the failing tests**

Create `test/restore.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { appendSnapshot } from "../src/snapshotStore.js";
import { SNAPSHOT_VERSION } from "../src/snapshot.js";
import { installRestore, restoreNewest } from "../src/restore.js";

function snapshot(windows) {
  return { version: SNAPSHOT_VERSION, takenAt: 1, windows };
}

function tabSpec(url, overrides = {}) {
  return { url, title: url, pinned: false, muted: false, active: false, groupKey: null, ...overrides };
}

const TWO_TABS = snapshot([
  {
    focused: true,
    groups: [],
    tabs: [tabSpec("https://a.test/"), tabSpec("https://b.test/", { active: true })],
  },
]);

function tabsOf(fake, windowId) {
  return [...fake.tabs.values()]
    .filter((tab) => tab.windowId === windowId)
    .sort((a, b) => a.index - b.index);
}

function createdWindowIds(fake) {
  return [...fake.windows.keys()].filter((id) => id >= 50);
}

test("restoring creates a window with the snapshot's tabs in order", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  assert.equal(await restoreNewest(fake.api, state), 1);
  const [windowId] = createdWindowIds(fake);
  assert.deepEqual(
    tabsOf(fake, windowId).map((tab) => tab.url),
    ["https://a.test/", "https://b.test/"],
  );
});

test("pinned, muted, and the active tab are reproduced", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [],
        tabs: [
          tabSpec("https://a.test/", { pinned: true, muted: true }),
          tabSpec("https://b.test/", { active: true }),
        ],
      },
    ]),
  );
  await restoreNewest(fake.api, state);
  const [windowId] = createdWindowIds(fake);
  const restored = tabsOf(fake, windowId);
  assert.equal(restored[0].pinned, true);
  assert.equal(restored[0].mutedInfo.muted, true);
  assert.equal(restored[1].active, true);
});

test("groups are recreated with title, colour, and collapsed state", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [{ key: 0, title: "Research", color: "blue", collapsed: true }],
        tabs: [
          tabSpec("https://a.test/", { groupKey: 0 }),
          tabSpec("https://b.test/", { groupKey: 0 }),
          tabSpec("https://c.test/", { active: true }),
        ],
      },
    ]),
  );
  await restoreNewest(fake.api, state);
  const [windowId] = createdWindowIds(fake);
  const restored = tabsOf(fake, windowId);
  assert.equal(restored[0].groupId, restored[1].groupId);
  assert.notEqual(restored[0].groupId, -1);
  const group = fake.groups.get(restored[0].groupId);
  assert.equal(group.title, "Research");
  assert.equal(group.color, "blue");
  assert.equal(group.collapsed, true);
});

test("every snapshot window becomes its own new window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: false, groups: [], tabs: [tabSpec("https://a.test/", { active: true })] },
      { focused: true, groups: [], tabs: [tabSpec("https://b.test/", { active: true })] },
    ]),
  );
  assert.equal(await restoreNewest(fake.api, state), 2);
  assert.equal(createdWindowIds(fake).length, 2);
});

test("existing windows are never touched", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://mine.test/" }],
  });
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  await restoreNewest(fake.api, state);
  assert.deepEqual(tabsOf(fake, 1).map((tab) => tab.url), ["https://mine.test/"]);
});

test("unclonable URLs are skipped and the rest still restore", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [],
        tabs: [tabSpec("chrome://settings/"), tabSpec("https://b.test/", { active: true })],
      },
    ]),
  );
  await restoreNewest(fake.api, state);
  const [windowId] = createdWindowIds(fake);
  assert.deepEqual(tabsOf(fake, windowId).map((tab) => tab.url), ["https://b.test/"]);
});

test("a window whose tabs are all unclonable keeps its placeholder", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: true, groups: [], tabs: [tabSpec("chrome://settings/", { active: true })] },
    ]),
  );
  await restoreNewest(fake.api, state);
  const [windowId] = createdWindowIds(fake);
  assert.equal(tabsOf(fake, windowId).length, 1, "the window must not vanish");
});

test("nothing stored shows the badge and creates no window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  assert.equal(await restoreNewest(fake.api, state), 0);
  assert.equal(fake.badge.text, "!");
  assert.deepEqual(createdWindowIds(fake), []);
});

test("an unknown snapshot version shows the badge and creates no window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, { ...TWO_TABS, version: SNAPSHOT_VERSION + 1 });
  assert.equal(await restoreNewest(fake.api, state), 0);
  assert.equal(fake.badge.text, "!");
});

test("restoreInProgress is set during the restore and cleared after", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  let seenDuring = false;
  const create = fake.api.windows.create;
  fake.api.windows.create = async (data) => {
    seenDuring = state.restoreInProgress;
    return create(data);
  };
  await restoreNewest(fake.api, state);
  assert.equal(seenDuring, true);
  assert.equal(state.restoreInProgress, false);
});

test("restoreInProgress is cleared even when the restore throws", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  fake.api.windows.create = async () => {
    throw new Error("boom");
  };
  await restoreNewest(fake.api, state);
  assert.equal(state.restoreInProgress, false);
});

test("clicking the toolbar icon restores", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  installRestore(fake.api, state);
  await fake.api.action.onClicked.emit({});
  assert.equal(createdWindowIds(fake).length, 1);
});
```

Add to `test/windowCloning.test.js`:

```js
test("the cloner ignores a window while a restore is running", async () => {
  const { fake, state } = setupClonable();
  state.restoreInProgress = true;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
  assert.deepEqual(fake.calls, [], "it must not even look at the window");
});
```

- [ ] **Step 4: Run and verify they fail**

Run: `node --test test/restore.test.js`
Expected: FAIL — `Cannot find module .../src/restore.js`

- [ ] **Step 5: Write `src/restore.js`**

```js
import { SNAPSHOT_VERSION } from "./snapshot.js";
import { newestSnapshot } from "./snapshotStore.js";
import { createAbortWatch } from "./state.js";
import { writeTabs } from "./tabWriter.js";

/** How long the failure badge stays up. */
export const BADGE_MS = 3000;

async function flashBadge(api) {
  await api.action.setBadgeText({ text: "!" });
  // Best effort: an evicted service worker may leave the badge up. A lingering
  // "!" is harmless and the next successful restore clears it, so this does
  // not warrant an alarm.
  setTimeout(() => {
    void api.action.setBadgeText({ text: "" });
  }, BADGE_MS);
}

/**
 * Restores the newest snapshot into brand new windows.
 *
 * Never modifies, reorders, or closes a window the user already has open.
 * Returns how many windows were created.
 */
export async function restoreNewest(api, state) {
  const snapshot = await newestSnapshot(api);
  if (snapshot === null || snapshot.version !== SNAPSHOT_VERSION) {
    // Restore must never fail silently: the user pressed a button.
    await flashBadge(api);
    return 0;
  }

  // Set synchronously before the first windows.create, because that fires
  // windows.onCreated and the cloner would otherwise clone every window we
  // make. The cloner's matching check is synchronous too.
  state.restoreInProgress = true;
  let created = 0;
  try {
    await api.action.setBadgeText({ text: "" });
    for (const window of snapshot.windows) {
      const target = await api.windows.create({});
      created += 1;
      state.suppressedWindowIds.add(target.id);
      try {
        const placeholders = await api.tabs.query({ windowId: target.id });
        const watch = createAbortWatch(state, target.id);
        const written = await writeTabs(
          api,
          watch,
          target.id,
          window.tabs,
          window.groups,
        );
        // Removing a window's last tab closes the window. A snapshot window
        // whose tabs were all unclonable must leave a plain empty window
        // rather than vanishing.
        if (written.length > 0 && placeholders.length === 1) {
          await api.tabs.remove(placeholders[0].id);
        }
      } finally {
        state.suppressedWindowIds.delete(target.id);
        state.abortedWindowIds.delete(target.id);
      }
    }
  } catch (error) {
    console.warn("[Tab Boss] restore failed", error);
  } finally {
    state.restoreInProgress = false;
  }
  return created;
}

export function installRestore(api, state) {
  // Manifest V3 requires listeners to register synchronously at the top level.
  api.action.onClicked.addListener(async () => {
    await restoreNewest(api, state);
  });
}
```

- [ ] **Step 6: Run and verify they pass**

Run: `npm test`
Expected: PASS, 13 more than Task 4 left (120 if no counts shifted in Task 1).

- [ ] **Step 7: Commit**

```bash
git add src/restore.js src/state.js src/windowCloning.js test/fakeChrome.js test/restore.test.js test/windowCloning.test.js
git commit -m "feat: restore the newest snapshot into new windows from the toolbar"
```

---

### Task 6: Wire the service worker, the manifest, and the docs

**Files:**
- Modify: `src/background.js`, `manifest.json`, `README.md`

**Interfaces:**
- Consumes: `installSnapshotScheduler` from `src/snapshotScheduler.js`; `installRestore` from `src/restore.js`.
- Produces: the loadable extension.

- [ ] **Step 1: Update `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Tab Boss",
  "version": "1.1.0",
  "description": "New tabs go to the bottom. New windows clone the window you came from. Your layout is backed up.",
  "permissions": ["tabs", "tabGroups", "storage", "alarms"],
  "action": {
    "default_title": "Tab Boss — restore the newest tab layout"
  },
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  }
}
```

There is deliberately no `default_popup`. One click restores.

- [ ] **Step 2: Update `src/background.js`**

```js
import { createState } from "./state.js";
import { installFocusTracking, seedFocus } from "./focusTracking.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installRestore } from "./restore.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { installWindowCloning } from "./windowCloning.js";

const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installFocusTracking(chrome, state);
installNewTabPlacement(chrome, state);
installWindowCloning(chrome, state);
installSnapshotScheduler(chrome);
installRestore(chrome, state);

void seedFocus(chrome, state);
```

- [ ] **Step 3: Update `README.md`**

Add a third numbered feature after the existing two:

````markdown
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
````

Update the permissions note to say four permissions: `tabs`, `tabGroups`,
`storage`, `alarms`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, the same count Task 5 left, 0 failures.

- [ ] **Step 5: Manual smoke test in ego lite**

Load the unpacked extension and reload it from `chrome://extensions`. Open the
service worker console to watch for `[Tab Boss]` lines.

1. Open several tabs including a pinned one, a muted one, and a named group.
   Wait two minutes.
2. Click the Tab Boss icon. A new window appears matching the layout: same
   order, same pinned tabs, same group name and colour, same selected tab.
   Your existing windows are untouched.
3. Click the icon again. A second matching window appears. Nothing breaks.
4. Close half your tabs. Watch the console: snapshots are skipped with a
   `skipped a snapshot` line, then one is taken about six minutes later.
5. Quit ego lite and relaunch. Confirm no snapshot is taken in the first minute.
6. Re-run the existing `tb-084` check: File > New Window, then close that
   window immediately while it is still filling. The browser must not crash.

This task cannot be completed by an agent — step 5 requires a human with a
browser. An agent must perform steps 1-4 and report step 5 as not done.

- [ ] **Step 6: Commit**

```bash
git add src/background.js manifest.json README.md
git commit -m "feat: wire snapshots and restore into the service worker"
```

---

## Self-review notes

Spec coverage:

| Spec requirement | Task |
| --- | --- |
| Snapshot shape, version, group remapping | 2 |
| `pendingUrl` fallback | 2 |
| Incognito and non-normal excluded | 2 |
| Fingerprint excludes `takenAt` and `title` | 2 |
| Suspected-loss threshold | 2 |
| `chrome.storage.local`, two keys, 20 cap | 3 |
| Malformed or failed read is "no snapshots" | 3 |
| Alarm, 2 minutes, idempotent creation | 4 |
| Quiet period, missing value does not block | 4 |
| Three-strike escape hatch | 4 |
| No-change skip is silent | 4 |
| Rules 2 and 3 do not apply to the first save | 4 |
| Toolbar action, one click, no popup | 5, 6 |
| Restore into new windows only | 5 |
| Placeholder kept when nothing was written | 5 |
| Badge on empty or unknown version | 5 |
| `restoreInProgress` and the cloner's check | 5 |
| Shared `tabWriter`, abort protection inherited | 1 |
| Ordering create → mute → group → activate → collapse → discard | 1 |
| Four permissions and an action | 6 |
| Manual smoke test | 6 |

Deliberate deviation from the spec: the spec's `writeTabs(api, watch, targetId, plan, groups)` returns "the written pairs"; this plan names the entries `{ spec, tab }` rather than the cloner's old `{ source, clone }`, because the writer no longer sees live source tabs. The cloner's `pairs` vocabulary retires with the extraction.

The spec left the `watch` signature to be resolved against merged code. Resolved: `createAbortWatch(state, windowId)` returning `{ aborted(), mark() }`, moved from `src/windowCloning.js` into `src/state.js` in Task 1 Step 1.
