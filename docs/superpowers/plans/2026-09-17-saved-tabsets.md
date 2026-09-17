# Saved Tabsets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user save the current window's tabs and groups under a name and open that named set into a new window, via a toolbar popup, with a toggle for the automatic snapshot system.

**Architecture:** A toolbar popup (the project's first UI) does its own storage reads for the set list, the toggle, and deletes, and sends two messages to the service worker for the operations that touch live windows — capture and open — because those reuse the crash-hardened `writeTabs` + abort-watch + window-tagging that lives in the worker. A shared `writeIntoNewWindow` helper, extracted from the existing duplicate-window feature, is the single implementation of the tagged new-window write.

**Tech Stack:** Plain JavaScript ES modules, Manifest V3, Node's built-in `node:test`. Plain HTML/CSS/JS for the popup, no framework. Zero npm dependencies.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-09-17-saved-tabsets-design.md`. Read it first.
- Zero npm dependencies. ES modules everywhere. No build step.
- Whole suite runs with `npm test`. **Never `node --test test/`** — Node 26 misparses the bare directory argument and reports a phantom failing test. A single file: `node --test test/tabsetStore.test.js`.
- 243 tests pass at the start. Every task leaves the whole suite green. Test counts below are deltas ("N more"), not absolutes — do not delete a test to hit a number; if your count differs, say why.
- All log output uses the exact prefix `[Tab Boss] `. Expected races (a window or tab closing mid-operation) are swallowed silently. Only unexpected failures use `console.warn`.
- Storage reads fail OPEN (a failed or malformed read reports "nothing"); a write that builds on an unverified read fails CLOSED (a rejected pre-write read aborts the write rather than clobbering the store). This mirrors `src/snapshotStore.js`.
- Two NEW `chrome.storage.local` keys: `tabsets` (array) and `settings` (object). They are independent of `snapshots`, `meta`, and `windowObservations`.
- The popup NEVER uses `alert`/`confirm`/`prompt` — those block the message channel. Confirmations are inline two-step buttons.
- Do not weaken any tb-084 abort guard. The write path stays byte-identical; only its entry point is refactored.
- Commit after every task, Conventional Commits. Do not push; the controller merges.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/windowCloning.js` | Gains `writeIntoNewWindow(api, state, buildPlan)`; `duplicateFocusedWindow` is refactored to call it; `planFromWindow` is exported. |
| `src/tabsetStore.js` | New. Read/upsert-by-name/delete-by-name/find for the `tabsets` key, with the fail-open/fail-closed rules. |
| `src/settingsStore.js` | New. Read/write `settings`, default `{ snapshotsEnabled: true }`. |
| `src/snapshotScheduler.js` | `captureNow` gains an early return when `snapshotsEnabled` is false. |
| `src/popupMessages.js` | New. The message-type string constants shared by popup and worker. |
| `src/popupService.js` | New. `handlePopupMessage(api, state, message, now)` — the capture/open/restore logic, unit-tested. |
| `src/popupModel.js` | New. Pure popup logic: name validation, list view-model, name-exists. No DOM. |
| `src/background.js` | Wires `runtime.onMessage` to `handlePopupMessage`; drops the now-dead `installRestore` toolbar listener. |
| `popup.html`, `popup.css`, `src/popup.js` | New. The popup DOM and wiring. Verified by the manual smoke test. |
| `manifest.json` | Adds `action.default_popup`. |
| `test/fakeChrome.js` | Gains `runtime.sendMessage`/`onMessage` only if a test needs them (the service is tested directly, so likely not). |

---

### Task 1: Extract `writeIntoNewWindow` from duplicate-window

A behaviour-preserving refactor. `duplicateFocusedWindow` currently inlines "create a new window, tag it, write a plan into it, tidy the placeholder". Tabset-open needs the same procedure with a stored plan instead of a live source. Extract it, so there is one implementation of the tagged, abort-guarded new-window write.

**Files:**
- Modify: `src/windowCloning.js`
- Test: `test/windowCloning.test.js`

**Interfaces:**
- Consumes: `createAbortWatch` from `src/state.js`; `writeTabs`, `windowStillOpen` from `src/tabWriter.js` (already imported).
- Produces:
  - `writeIntoNewWindow(api, state, buildPlan): Promise<boolean>` where `buildPlan` is `(watch) => Promise<{ plan, groups } | null> | { plan, groups } | null`. Returns `true` when a window was created (even if the write then failed or was aborted), `false` only when the window could not be created.
  - `planFromWindow(api, sourceId, watch): Promise<{ plan, groups } | null>` — now exported (was private).

- [ ] **Step 1: Add a failing test for `writeIntoNewWindow` with a stored plan**

Append to `test/windowCloning.test.js`. Add `writeIntoNewWindow` to the import from `../src/windowCloning.js`.

```js
test("writeIntoNewWindow writes a stored plan into a fresh tagged window", async () => {
  const fake = createFakeChrome({ windows: [{ id: 1 }], tabs: [] });
  const state = createState();
  const before = new Set(fake.windows.keys());

  const plan = [
    { url: "https://a.test/", pinned: false, muted: false, active: false, groupKey: null },
    { url: "https://b.test/", pinned: false, muted: false, active: true, groupKey: null },
  ];
  const created = await writeIntoNewWindow(fake.api, state, () => ({ plan, groups: [] }));
  assert.equal(created, true);

  const [newId] = [...fake.windows.keys()].filter((id) => !before.has(id));
  const urls = [...fake.tabs.values()]
    .filter((t) => t.windowId === newId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.url);
  assert.deepEqual(urls, ["https://a.test/", "https://b.test/"]);
  assert.ok(state.restoredWindowIds.has(newId), "the new window must be tagged");
});

test("writeIntoNewWindow returns false when a window cannot be created", async () => {
  const fake = createFakeChrome();
  const state = createState();
  fake.api.windows.create = async () => {
    throw new Error("no window");
  };
  const created = await writeIntoNewWindow(fake.api, state, () => ({ plan: [], groups: [] }));
  assert.equal(created, false);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/windowCloning.test.js`
Expected: FAIL — `writeIntoNewWindow is not a function`.

- [ ] **Step 3: Add `writeIntoNewWindow` and export `planFromWindow`**

In `src/windowCloning.js`, change `async function planFromWindow` to `export async function planFromWindow`. Then add, above `duplicateFocusedWindow`:

```js
/**
 * Creates a new window and writes a plan into it, with every tb-084 abort
 * guard. The plan is produced by `buildPlan`, which receives the target's abort
 * watch: duplicate-window builds it from the focused window (so it can bail if
 * the target dies during the source read); tabset-open just returns a stored
 * plan. One implementation of the tagged new-window write, two callers.
 *
 * Returns true when a window was created — even if the write then aborted or
 * failed — and false only when the window itself could not be created.
 */
export async function writeIntoNewWindow(api, state, buildPlan) {
  let target;
  try {
    target = await api.windows.create({});
  } catch (error) {
    console.warn("[Tab Boss] could not create a window", error);
    return false;
  }

  // Tagged the instant it exists and NOT cleared when this finishes: nothing may
  // ever clone onto a window Tab Boss itself created. Cleared only on close
  // (windows.onRemoved). suppressedWindowIds keeps new tab placement off it.
  state.suppressedWindowIds.add(target.id);
  state.restoredWindowIds.add(target.id);
  const watch = createAbortWatch(state, target.id);
  try {
    const placeholders = await api.tabs.query({ windowId: target.id });
    const described = await buildPlan(watch);
    if (watch.aborted() || described === null) return true;
    const written = await writeTabs(
      api,
      watch,
      target.id,
      described.plan,
      described.groups,
    );
    if (watch.aborted()) return true;
    // Removing a window's last tab closes it. If nothing could be written,
    // leave the blank tab rather than making the window vanish.
    if (written.length > 0 && placeholders.length === 1) {
      await api.tabs.remove(placeholders[0].id);
    }
    return true;
  } catch (error) {
    // The user can close the new window mid-write. Expected race, silent;
    // anything else must be findable.
    if (!watch.aborted() && (await windowStillOpen(api, target.id))) {
      console.warn("[Tab Boss] write into new window failed", error);
    }
    return true;
  } finally {
    state.suppressedWindowIds.delete(target.id);
    state.abortedWindowIds.delete(target.id);
  }
}
```

- [ ] **Step 4: Refactor `duplicateFocusedWindow` to call it**

Replace the entire body of `duplicateFocusedWindow` with:

```js
export async function duplicateFocusedWindow(api, state) {
  let source;
  try {
    source = await api.windows.getLastFocused();
  } catch {
    // No open window to copy.
    return false;
  }
  if (!source || source.type !== "normal" || source.incognito) return false;

  return writeIntoNewWindow(api, state, (watch) =>
    planFromWindow(api, source.id, watch),
  );
}
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. The existing duplicate-window tests (`duplicate copies the focused window's tabs...`, `...never touches an existing window`, `...tags the new window...`, `...incognito`, `...no window to copy`, `...all-unclonable...`) all still pass — that is the proof the refactor preserved behaviour — plus the 2 new `writeIntoNewWindow` tests. About 2 more than before.

- [ ] **Step 6: Prove the abort guard survived the move**

On a scratch copy, delete the `if (watch.aborted()) return true;` line before the placeholder removal in `writeIntoNewWindow`, run `node --test test/windowCloning.test.js`, and confirm a test fails (the mid-write abort suite). Restore it. Record the result in your report. If nothing fails, add a test that closes the target mid-write and asserts no call lands after.

- [ ] **Step 7: Commit**

```bash
git add src/windowCloning.js test/windowCloning.test.js
git commit -m "refactor: extract writeIntoNewWindow so tabset-open and duplicate share it"
```

---

### Task 2: `tabsetStore.js`

**Files:**
- Create: `src/tabsetStore.js`
- Test: `test/tabsetStore.test.js`

**Interfaces:**
- Consumes: `createFakeChrome` from `test/fakeChrome.js`.
- Produces:
  - `TABSETS_KEY: string` (value `"tabsets"`)
  - `readTabsets(api): Promise<Array>` — never throws; malformed/absent reads as `[]`
  - `findTabset(api, name): Promise<object|null>`
  - `upsertTabset(api, tabset): Promise<boolean>` — replaces any set with the same name; returns `true` if one was replaced. Fails closed on a rejected pre-write read.
  - `deleteTabset(api, name): Promise<void>` — fails closed on a rejected pre-write read.

- [ ] **Step 1: Write the failing tests**

Create `test/tabsetStore.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import {
  deleteTabset,
  findTabset,
  readTabsets,
  upsertTabset,
} from "../src/tabsetStore.js";

const setOf = (name, urls) => ({
  name,
  savedAt: 1,
  plan: urls.map((url) => ({ url, pinned: false, muted: false, active: false, groupKey: null })),
  groups: [],
});

test("an empty store reads as no tabsets", async () => {
  const { api } = createFakeChrome();
  assert.deepEqual(await readTabsets(api), []);
  assert.equal(await findTabset(api, "x"), null);
});

test("upsert adds a new set and find returns it", async () => {
  const { api } = createFakeChrome();
  const replaced = await upsertTabset(api, setOf("Daily", ["https://a.test/"]));
  assert.equal(replaced, false);
  const found = await findTabset(api, "Daily");
  assert.deepEqual(found.plan.map((t) => t.url), ["https://a.test/"]);
});

test("upsert with an existing name replaces in place, not duplicates", async () => {
  const { api } = createFakeChrome();
  await upsertTabset(api, setOf("Daily", ["https://old.test/"]));
  const replaced = await upsertTabset(api, setOf("Daily", ["https://new.test/"]));
  assert.equal(replaced, true);
  const all = await readTabsets(api);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].plan.map((t) => t.url), ["https://new.test/"]);
});

test("delete removes a set by name", async () => {
  const { api } = createFakeChrome();
  await upsertTabset(api, setOf("A", ["https://a.test/"]));
  await upsertTabset(api, setOf("B", ["https://b.test/"]));
  await deleteTabset(api, "A");
  assert.deepEqual((await readTabsets(api)).map((s) => s.name), ["B"]);
});

test("a malformed stored value reads as no tabsets", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("tabsets", { not: "an array" });
  assert.deepEqual(await readTabsets(api), []);
});

test("a rejected pre-write read aborts upsert rather than clobbering", async () => {
  const { api } = createFakeChrome();
  await upsertTabset(api, setOf("Keep", ["https://keep.test/"]));
  const originalGet = api.storage.local.get;
  api.storage.local.get = async () => {
    throw new Error("storage glitch");
  };
  await assert.rejects(() => upsertTabset(api, setOf("New", ["https://new.test/"])));
  api.storage.local.get = originalGet;
  assert.deepEqual((await readTabsets(api)).map((s) => s.name), ["Keep"]);
});

test("a storage failure reads as no tabsets rather than throwing", async () => {
  const { api } = createFakeChrome();
  api.storage.local.get = async () => {
    throw new Error("unavailable");
  };
  assert.deepEqual(await readTabsets(api), []);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/tabsetStore.test.js`
Expected: FAIL — `Cannot find module .../src/tabsetStore.js`.

- [ ] **Step 3: Write `src/tabsetStore.js`**

```js
/** The storage key for saved tabsets, kept apart from snapshots and meta. */
export const TABSETS_KEY = "tabsets";

/**
 * A read that does NOT swallow, for the callers that must not build a write on
 * a guess. A rejection propagates and aborts the write; overwriting the whole
 * store because one read glitched is the one way a store can lose everything.
 */
async function readForWrite(api) {
  const result = await api.storage.local.get(TABSETS_KEY);
  const stored = result?.[TABSETS_KEY];
  return Array.isArray(stored) ? stored : [];
}

export async function readTabsets(api) {
  try {
    const result = await api.storage.local.get(TABSETS_KEY);
    const stored = result?.[TABSETS_KEY];
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export async function findTabset(api, name) {
  const sets = await readTabsets(api);
  return sets.find((set) => set.name === name) ?? null;
}

export async function upsertTabset(api, tabset) {
  const sets = await readForWrite(api);
  const without = sets.filter((set) => set.name !== tabset.name);
  const replaced = without.length !== sets.length;
  without.push(tabset);
  await api.storage.local.set({ [TABSETS_KEY]: without });
  return replaced;
}

export async function deleteTabset(api, name) {
  const sets = await readForWrite(api);
  await api.storage.local.set({
    [TABSETS_KEY]: sets.filter((set) => set.name !== name),
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: PASS, 7 more than before.

- [ ] **Step 5: Commit**

```bash
git add src/tabsetStore.js test/tabsetStore.test.js
git commit -m "feat: store, find, upsert, and delete named tabsets"
```

---

### Task 3: `settingsStore.js` and the snapshot gate

**Files:**
- Create: `src/settingsStore.js`
- Modify: `src/snapshotScheduler.js`
- Test: `test/settingsStore.test.js`, `test/snapshotScheduler.test.js`

**Interfaces:**
- Produces:
  - From `src/settingsStore.js`: `readSettings(api): Promise<{ snapshotsEnabled: boolean }>` (default `true`); `writeSettings(api, patch): Promise<void>`.
  - `captureNow(api, now, state)` gains a new return value `"disabled"`.

- [ ] **Step 1: Write the failing settings tests**

Create `test/settingsStore.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { readSettings, writeSettings } from "../src/settingsStore.js";

test("settings default to snapshots enabled", async () => {
  const { api } = createFakeChrome();
  assert.deepEqual(await readSettings(api), { snapshotsEnabled: true });
});

test("writeSettings patches and round-trips", async () => {
  const { api } = createFakeChrome();
  await writeSettings(api, { snapshotsEnabled: false });
  assert.equal((await readSettings(api)).snapshotsEnabled, false);
});

test("a malformed settings value reads as the default", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("settings", "nonsense");
  assert.deepEqual(await readSettings(api), { snapshotsEnabled: true });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/settingsStore.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write `src/settingsStore.js`**

```js
const SETTINGS_KEY = "settings";
const DEFAULTS = { snapshotsEnabled: true };

export async function readSettings(api) {
  try {
    const result = await api.storage.local.get(SETTINGS_KEY);
    const stored = result?.[SETTINGS_KEY];
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
      return { ...DEFAULTS };
    }
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeSettings(api, patch) {
  const current = await readSettings(api);
  await api.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}
```

- [ ] **Step 4: Add the failing gate test**

Append to `test/snapshotScheduler.test.js`. Add `writeSettings` to a new import from `../src/settingsStore.js`:

```js
import { writeSettings } from "../src/settingsStore.js";

test("captureNow does nothing when snapshots are disabled", async () => {
  const { api } = fakeWith(3);
  await writeSettings(api, { snapshotsEnabled: false });
  assert.equal(await captureNow(api, 0, createState()), "disabled");
  assert.deepEqual(await readSnapshots(api), []);
});
```

Note: `fakeWith`, `createState`, `captureNow`, and `readSnapshots` are already imported in that file. If `createState` is not, add it from `../src/state.js`.

- [ ] **Step 5: Run, verify the gate test fails**

Run: `node --test test/snapshotScheduler.test.js`
Expected: FAIL — `captureNow` returns `"saved"`, not `"disabled"`.

- [ ] **Step 6: Add the gate to `captureNow`**

In `src/snapshotScheduler.js`, add the import:

```js
import { readSettings } from "./settingsStore.js";
```

Immediately after the existing `if (state.restoreInProgress) return "restoring";` line in `captureNow`, add:

```js
  // The user can turn the whole automatic snapshot system off from the popup.
  // The alarm still fires; it just does nothing while disabled.
  if (!(await readSettings(api)).snapshotsEnabled) return "disabled";
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS. The existing scheduler tests do not set `settings`, so they default to enabled and are unaffected. About 4 more than before.

- [ ] **Step 8: Commit**

```bash
git add src/settingsStore.js src/snapshotScheduler.js test/settingsStore.test.js test/snapshotScheduler.test.js
git commit -m "feat: a snapshotsEnabled setting that gates the scheduler"
```

---

### Task 4: `popupService.js` — the message handler

**Files:**
- Create: `src/popupMessages.js`, `src/popupService.js`
- Test: `test/popupService.test.js`

**Interfaces:**
- Consumes: `readSettings` (not needed here), `findTabset`/`upsertTabset` from `src/tabsetStore.js`; `planFromWindow`/`writeIntoNewWindow` from `src/windowCloning.js`; `restoreNewest` from `src/restore.js`.
- Produces:
  - From `src/popupMessages.js`: `CAPTURE` (`"tabsets/capture"`), `OPEN` (`"tabsets/open"`), `RESTORE` (`"snapshots/restore"`).
  - `handlePopupMessage(api, state, message, now): Promise<object>` — `now` is a `() => number` for the save timestamp.

- [ ] **Step 1: Write the failing tests**

Create `test/popupService.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { readTabsets, upsertTabset } from "../src/tabsetStore.js";
import { CAPTURE, OPEN, RESTORE, handlePopupMessage } from "../src/popupService.js";

const now = () => 12345;

/** A fake with one focused normal window that has real tabs. */
function focusedWindow() {
  return createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
    ],
  });
}

test("capture stores the focused window under the name", async () => {
  const fake = focusedWindow();
  const reply = await handlePopupMessage(fake.api, createState(), { type: CAPTURE, name: "Daily" }, now);
  assert.deepEqual(reply, { ok: true, overwritten: false });
  const [set] = await readTabsets(fake.api);
  assert.equal(set.name, "Daily");
  assert.equal(set.savedAt, 12345);
  assert.deepEqual(set.plan.map((t) => t.url), ["https://a.test/", "https://b.test/"]);
});

test("capture of an incognito window saves nothing", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1, incognito: true }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://a.test/", active: true }],
  });
  const reply = await handlePopupMessage(fake.api, createState(), { type: CAPTURE, name: "X" }, now);
  assert.equal(reply.ok, false);
  assert.deepEqual(await readTabsets(fake.api), []);
});

test("open writes a stored set into a new window", async () => {
  const fake = focusedWindow();
  await upsertTabset(fake.api, {
    name: "Work",
    savedAt: 1,
    plan: [{ url: "https://x.test/", pinned: false, muted: false, active: true, groupKey: null }],
    groups: [],
  });
  const before = new Set(fake.windows.keys());
  const reply = await handlePopupMessage(fake.api, createState(), { type: OPEN, name: "Work" }, now);
  assert.equal(reply.ok, true);
  const [newId] = [...fake.windows.keys()].filter((id) => !before.has(id));
  const urls = [...fake.tabs.values()].filter((t) => t.windowId === newId).map((t) => t.url);
  assert.deepEqual(urls, ["https://x.test/"]);
});

test("opening a missing set creates no window", async () => {
  const fake = focusedWindow();
  const before = new Set(fake.windows.keys());
  const reply = await handlePopupMessage(fake.api, createState(), { type: OPEN, name: "ghost" }, now);
  assert.equal(reply.ok, false);
  assert.deepEqual([...fake.windows.keys()].filter((id) => !before.has(id)), []);
});

test("a restore message runs the newest-snapshot restore", async () => {
  const fake = focusedWindow();
  let ran = false;
  // No snapshot stored, so restoreNewest badges and returns 0 — enough to prove
  // the message routes to it.
  const reply = await handlePopupMessage(fake.api, createState(), { type: RESTORE }, now);
  ran = reply.ok !== undefined;
  assert.equal(ran, true);
});

test("an unknown or malformed message is rejected", async () => {
  const fake = focusedWindow();
  assert.equal((await handlePopupMessage(fake.api, createState(), { type: "nope" }, now)).ok, false);
  assert.equal((await handlePopupMessage(fake.api, createState(), null, now)).ok, false);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/popupService.test.js`
Expected: FAIL — `Cannot find module .../src/popupService.js`.

- [ ] **Step 3: Write `src/popupMessages.js`**

```js
/** Message types the popup sends to the service worker. Shared so the two
 * sides cannot drift. */
export const CAPTURE = "tabsets/capture";
export const OPEN = "tabsets/open";
export const RESTORE = "snapshots/restore";
```

- [ ] **Step 4: Write `src/popupService.js`**

```js
import { findTabset, upsertTabset } from "./tabsetStore.js";
import { planFromWindow, writeIntoNewWindow } from "./windowCloning.js";
import { restoreNewest } from "./restore.js";
import { CAPTURE, OPEN, RESTORE } from "./popupMessages.js";

export { CAPTURE, OPEN, RESTORE };

/** A watch that never aborts, for reads with no target window to guard. */
const NEVER_ABORTS = { aborted: () => false, mark: () => {} };

/**
 * Handles the popup's messages. The popup does its own storage reads for the
 * list, the toggle, and deletes; only these operations, which touch live
 * windows through the crash-hardened write path, come through the worker.
 *
 * `now` is injected so the save timestamp is testable.
 */
export async function handlePopupMessage(api, state, message, now) {
  if (!message || typeof message !== "object") {
    return { ok: false, reason: "bad-message" };
  }
  switch (message.type) {
    case CAPTURE:
      return captureCurrentWindow(api, message.name, now);
    case OPEN:
      return openTabset(api, state, message.name);
    case RESTORE: {
      const created = await restoreNewest(api, state);
      return { ok: true, created };
    }
    default:
      return { ok: false, reason: "unknown" };
  }
}

async function captureCurrentWindow(api, name, now) {
  let source;
  try {
    source = await api.windows.getLastFocused();
  } catch {
    return { ok: false, reason: "no-window" };
  }
  if (!source || source.type !== "normal" || source.incognito) {
    return { ok: false, reason: "not-normal" };
  }
  const described = await planFromWindow(api, source.id, NEVER_ABORTS);
  if (described === null) return { ok: false, reason: "read-failed" };
  const overwritten = await upsertTabset(api, {
    name,
    savedAt: now(),
    plan: described.plan,
    groups: described.groups,
  });
  return { ok: true, overwritten };
}

async function openTabset(api, state, name) {
  const set = await findTabset(api, name);
  if (set === null) return { ok: false, reason: "not-found" };
  await writeIntoNewWindow(api, state, () => ({
    plan: set.plan,
    groups: set.groups,
  }));
  return { ok: true, created: 1 };
}
```

- [ ] **Step 5: Run, verify pass**

Run: `npm test`
Expected: PASS, about 6 more than before.

- [ ] **Step 6: Commit**

```bash
git add src/popupMessages.js src/popupService.js test/popupService.test.js
git commit -m "feat: popup message handler for capture, open, and restore"
```

---

### Task 5: `popupModel.js` — the popup's pure logic

**Files:**
- Create: `src/popupModel.js`
- Test: `test/popupModel.test.js`

**Interfaces:**
- Produces:
  - `validateName(raw): { valid: true, name } | { valid: false, reason }` — trims; rejects empty and over 60 chars.
  - `nameExists(tabsets, name): boolean`
  - `listView(tabsets): Array<{ name, tabCount, savedAt }>` — newest first.

- [ ] **Step 1: Write the failing tests**

Create `test/popupModel.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { listView, nameExists, validateName } from "../src/popupModel.js";

test("a name is trimmed and accepted", () => {
  assert.deepEqual(validateName("  Daily Work  "), { valid: true, name: "Daily Work" });
});

test("an empty or whitespace name is rejected", () => {
  assert.equal(validateName("").valid, false);
  assert.equal(validateName("   ").valid, false);
});

test("an over-long name is rejected", () => {
  assert.equal(validateName("x".repeat(61)).valid, false);
});

test("nameExists is exact", () => {
  const sets = [{ name: "Daily" }];
  assert.equal(nameExists(sets, "Daily"), true);
  assert.equal(nameExists(sets, "daily"), false);
});

test("listView is newest-first with a tab count", () => {
  const sets = [
    { name: "Old", savedAt: 1, plan: [{}, {}] },
    { name: "New", savedAt: 2, plan: [{}] },
  ];
  assert.deepEqual(listView(sets), [
    { name: "New", tabCount: 1, savedAt: 2 },
    { name: "Old", tabCount: 2, savedAt: 1 },
  ]);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/popupModel.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write `src/popupModel.js`**

```js
const MAX_NAME_LENGTH = 60;

export function validateName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) return { valid: false, reason: "empty" };
  if (name.length > MAX_NAME_LENGTH) return { valid: false, reason: "too-long" };
  return { valid: true, name };
}

export function nameExists(tabsets, name) {
  return tabsets.some((set) => set.name === name);
}

export function listView(tabsets) {
  return [...tabsets]
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((set) => ({
      name: set.name,
      tabCount: Array.isArray(set.plan) ? set.plan.length : 0,
      savedAt: set.savedAt,
    }));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: PASS, 5 more than before.

- [ ] **Step 5: Commit**

```bash
git add src/popupModel.js test/popupModel.test.js
git commit -m "feat: pure popup model — name validation and list view"
```

---

### Task 6: Wire the worker and the manifest

**Files:**
- Modify: `src/background.js`, `manifest.json`

**Interfaces:**
- Consumes: `handlePopupMessage` from `src/popupService.js`.
- Produces: the loadable extension with a working popup message channel.

`background.js` has no tests; it is pure wiring. Its correctness is covered by `popupService`'s tests and the manual smoke test.

- [ ] **Step 1: Wire `runtime.onMessage`**

In `src/background.js`, add the import:

```js
import { handlePopupMessage } from "./popupService.js";
```

Remove the `installRestore` import and its call inside the `if (TAB_WRITING_ENABLED)` block — with a popup, `action.onClicked` no longer fires, so that listener is dead. Restore is reached through the popup message instead. Leave `installWindowCloning` where it is.

Add, near the other installs (top level, synchronous):

```js
// The popup sends capture / open / restore messages. Returning true keeps the
// channel open for the async reply, as Manifest V3 requires.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handlePopupMessage(chrome, state, message, () => Date.now()).then(sendResponse);
  return true;
});
```

- [ ] **Step 2: Add the popup to the manifest**

In `manifest.json`, change the `action` block to:

```json
  "action": {
    "default_title": "Tab Boss — saved tabsets and snapshots",
    "default_popup": "popup.html"
  },
```

Bump `version` to `1.4.0`.

- [ ] **Step 3: Run the suite and check the manifest is valid**

Run: `npm test` — expected PASS, unchanged count.
Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json'))" && echo ok` — expected `ok`.

- [ ] **Step 4: Commit**

```bash
git add src/background.js manifest.json
git commit -m "feat: wire the popup message channel and register the popup"
```

---

### Task 7: The popup UI and the smoke test

**Files:**
- Create: `popup.html`, `popup.css`, `src/popup.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `readTabsets`, `deleteTabset` from `src/tabsetStore.js`; `readSettings`, `writeSettings` from `src/settingsStore.js`; `validateName`, `nameExists`, `listView` from `src/popupModel.js`; `CAPTURE`, `OPEN`, `RESTORE` from `src/popupMessages.js`.
- Produces: the popup.

The popup DOM is verified by the manual smoke test, not automated tests — the model, store, settings, and service layers beneath it carry the coverage.

- [ ] **Step 1: Create `popup.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <form id="save-form">
      <input id="name" type="text" placeholder="Name this window's tabs" autocomplete="off" />
      <button id="save" type="submit">Save</button>
    </form>
    <p id="status" class="status" hidden></p>
    <ul id="list" class="list"></ul>
    <footer>
      <label class="toggle">
        <input id="snapshots" type="checkbox" />
        Automatic snapshots &amp; restore
      </label>
      <button id="restore" type="button" hidden>Restore last backup</button>
    </footer>
    <script type="module" src="src/popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `popup.css`**

```css
body {
  width: 320px;
  margin: 0;
  padding: 12px;
  font: 13px/1.4 system-ui, sans-serif;
  color: #1a1a1a;
}
#save-form {
  display: flex;
  gap: 6px;
}
#name {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 6px;
}
button {
  padding: 6px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: #f6f6f6;
  cursor: pointer;
}
button:hover {
  background: #ececec;
}
.status {
  margin: 8px 0 0;
  color: #666;
}
.list {
  list-style: none;
  margin: 12px 0;
  padding: 0;
}
.list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-top: 1px solid #eee;
}
.list .name {
  flex: 1;
}
.list .count {
  color: #999;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid #eee;
  padding-top: 10px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
}
```

- [ ] **Step 3: Create `src/popup.js`**

```js
import { deleteTabset, readTabsets } from "./tabsetStore.js";
import { readSettings, writeSettings } from "./settingsStore.js";
import { listView, nameExists, validateName } from "./popupModel.js";
import { CAPTURE, OPEN, RESTORE } from "./popupMessages.js";

const nameInput = document.getElementById("name");
const saveForm = document.getElementById("save-form");
const statusLine = document.getElementById("status");
const listEl = document.getElementById("list");
const snapshotsToggle = document.getElementById("snapshots");
const restoreButton = document.getElementById("restore");

function showStatus(text) {
  statusLine.textContent = text;
  statusLine.hidden = text === "";
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refreshList() {
  const sets = await readTabsets(chrome);
  listEl.replaceChildren();
  for (const row of listView(sets)) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.name;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${row.tabCount}`;

    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", async () => {
      await send({ type: OPEN, name: row.name });
      window.close();
    });

    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      // Two-step confirm inline: the first click arms, the second deletes.
      if (del.dataset.armed !== "yes") {
        del.dataset.armed = "yes";
        del.textContent = "Sure?";
        return;
      }
      await deleteTabset(chrome, row.name);
      await refreshList();
    });

    li.append(name, count, open, del);
    listEl.append(li);
  }
}

saveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const check = validateName(nameInput.value);
  if (!check.valid) {
    showStatus(check.reason === "empty" ? "Type a name first." : "Name is too long.");
    return;
  }
  const sets = await readTabsets(chrome);
  const saveButton = document.getElementById("save");
  if (nameExists(sets, check.name) && saveButton.dataset.armed !== check.name) {
    saveButton.dataset.armed = check.name;
    saveButton.textContent = "Replace?";
    return;
  }
  saveButton.dataset.armed = "";
  saveButton.textContent = "Save";
  const reply = await send({ type: CAPTURE, name: check.name });
  if (!reply.ok) {
    showStatus("Can't save this window.");
    return;
  }
  nameInput.value = "";
  showStatus(reply.overwritten ? `Replaced "${check.name}".` : `Saved "${check.name}".`);
  await refreshList();
});

snapshotsToggle.addEventListener("change", async () => {
  await writeSettings(chrome, { snapshotsEnabled: snapshotsToggle.checked });
  restoreButton.hidden = !snapshotsToggle.checked;
});

restoreButton.addEventListener("click", async () => {
  await send({ type: RESTORE });
  window.close();
});

async function init() {
  const settings = await readSettings(chrome);
  snapshotsToggle.checked = settings.snapshotsEnabled;
  restoreButton.hidden = !settings.snapshotsEnabled;
  await refreshList();
}

void init();
```

Note: `readTabsets`, `readSettings`, `writeSettings`, and `deleteTabset` take the `chrome` object as their `api` argument — in the popup that is the real global `chrome`, which is available on extension pages. That is why the popup can call the store modules directly.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, unchanged count (the popup DOM is not unit-tested).

- [ ] **Step 5: Add the smoke test to `README.md`**

Append a section:

```markdown
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
```

- [ ] **Step 6: Manual smoke test in ego lite**

Load the unpacked extension, reload it, and run the six steps above by hand. This step cannot be done by an agent — it needs a human with the browser. An agent must report it as not performed.

- [ ] **Step 7: Commit**

```bash
git add popup.html popup.css src/popup.js README.md
git commit -m "feat: the saved-tabsets popup UI and its smoke test"
```

---

## Self-review notes

Spec coverage:

| Spec requirement | Task |
| --- | --- |
| Tabset shape (name, savedAt, plan, groups) | 2, 4 |
| `tabsets` storage key, separate, fail-open/closed | 2 |
| Capture the current window | 4 |
| Overwrite by name (returns overwritten) | 2, 4, 7 |
| Open into a new window, tagged, guarded | 1, 4 |
| Shared `writeIntoNewWindow` refactor | 1 |
| `settings.snapshotsEnabled`, default true | 3 |
| Scheduler gated on the setting | 3 |
| Restore reachable behind the toggle | 4, 7 |
| Message contract, worker returns true for async | 4, 6 |
| Popup: save row, list, delete, toggle, restore | 7 |
| Two-step inline confirms, no alert/confirm | 7 |
| Popup pure logic tested (`popupModel`) | 5 |
| `default_popup` in manifest | 6 |
| Manual smoke test | 7 |
| tb-084 guards preserved | 1 |

Deliberate deviation from the spec: the spec lists a `src/tabsetMessages.js`; the plan names it `src/popupMessages.js` because it also carries the `RESTORE` message, which is snapshot-related, not tabset-related. One message module for all popup→worker traffic.

The spec's `settingsStore.js` `writeSettings(api, meta)` is a patch-merge (`writeSettings(api, patch)`), matching `updateMeta`'s shape, so a future second setting does not clobber the first.
