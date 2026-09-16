import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome, createManualClock } from "./fakeChrome.js";
import { writeMeta } from "../src/snapshotStore.js";
import {
  FOCUS_GRACE_MS,
  STARTUP_QUIET_MS,
} from "../src/windowClassifier.js";
import {
  MAX_OBSERVATIONS,
  OBSERVATIONS_KEY,
  installWindowObserver,
  readObservations,
} from "../src/windowObserver.js";

const START = 1_700_000_000_000;

/**
 * The only calls this instrument is allowed to make. The whole point of the
 * exercise is that it observes and writes a log; if this list ever grows a
 * `tabs.` or `windows.` verb, the instrument has become a participant.
 */
const READ_ONLY_CALLS = new Set([
  "tabs.query",
  "windows.get",
  "storage.local.get",
  "storage.local.set",
]);

/**
 * A fake browser with one window already open, plus an observer wired to a
 * hand-driven clock. `browserStartedAt` defaults to well clear of the quiet
 * period, so the default scenario is a genuine Cmd+N.
 */
async function setup(t, { startedAt = START - STARTUP_QUIET_MS - 60_000 } = {}) {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 100, windowId: 1, index: 0, url: "https://example.com/" }],
  });
  if (startedAt !== null) await writeMeta(fake.api, { browserStartedAt: startedAt });

  // The observer logs a line per record. Captured rather than printed, both to
  // keep the suite readable and so the live-watching line can be asserted on.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  t.after(() => {
    console.log = originalLog;
  });

  const clock = createManualClock(START);
  const observer = installWindowObserver(fake.api, {
    now: clock.now,
    wait: clock.wait,
  });
  fake.calls.length = 0;
  return { ...fake, clock, observer, logs };
}

/** Adds a blank one-tab window to the fake and returns the event object. */
function openBlankWindow(fake, id, overrides = {}) {
  const win = { id, type: "normal", incognito: false, focused: true, ...overrides };
  fake.windows.set(id, win);
  fake.tabs.set(id * 10, {
    id: id * 10,
    windowId: id,
    index: 0,
    url: "chrome://newtab/",
    pinned: false,
    active: true,
    groupId: -1,
    mutedInfo: { muted: false },
  });
  return win;
}

/**
 * Plays one window creation through: the create event, an optional focus
 * event, then the grace period. `emit` is deliberately not awaited — the
 * listener parks on its grace timer, exactly as it does in the browser.
 */
async function observeWindow(fake, win, { focus = true, focusDelay = 30 } = {}) {
  void fake.api.windows.onCreated.emit(win);
  if (focus) {
    fake.clock.advance(focusDelay);
    void fake.api.windows.onFocusChanged.emit(win.id);
  }
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test("a Cmd+N window is recorded as one the cloner would have filled", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));

  const log = await readObservations(fake.api);
  assert.equal(log.length, 1);
  assert.equal(log[0].wouldClone, true, log[0].reasons?.join(" "));
});

test("the record carries every signal the classifier was given", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2), { focusDelay: 30 });

  const [record] = await readObservations(fake.api);
  assert.equal(record.windowId, 2);
  assert.equal(record.typeAtCreate, "normal");
  assert.equal(record.incognito, false);
  assert.equal(record.focusedAtCreate, true);
  assert.equal(record.tabCount, 1);
  assert.deepEqual(record.tabUrls, ["chrome://newtab/"]);
  assert.equal(record.msSinceBrowserStart, STARTUP_QUIET_MS + 60_000);
  assert.equal(record.windowsCreatedInLastTwoSeconds, 1);
  assert.equal(record.becameFocused, true);
  assert.equal(record.becameFocusedWithinMs, 30);
  assert.equal(record.createdAt, START);
  assert.ok(Array.isArray(record.reasons) && record.reasons.length === 5);
  // Kept for the tb-dup lead: the gate and the failure disagreed about the
  // window's type, so the type after the grace period is worth having.
  assert.equal(record.typeAfterGrace, "normal");
});

// ---------------------------------------------------------------------------
// The constraint that matters most
// ---------------------------------------------------------------------------

test("the observer never asks the browser to change anything", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));
  await observeWindow(fake, openBlankWindow(fake, 3, { type: "popup" }));

  const names = [...new Set(fake.calls.map(([name]) => name))];
  assert.ok(names.length > 0, "the observer did nothing at all");
  for (const name of names) {
    assert.ok(
      READ_ONLY_CALLS.has(name),
      `the observer called ${name}, which is not a read`,
    );
  }
});

test("the observer leaves the snapshots and meta keys alone", async (t) => {
  const fake = await setup(t);
  fake.storage.set("snapshots", [{ version: 1, takenAt: 5, windows: [] }]);
  await observeWindow(fake, openBlankWindow(fake, 2));

  assert.deepEqual(fake.storage.get("snapshots"), [
    { version: 1, takenAt: 5, windows: [] },
  ]);
  assert.equal(
    fake.storage.get("meta").browserStartedAt,
    START - STARTUP_QUIET_MS - 60_000,
  );
  for (const [name, items] of fake.calls.filter(
    ([name]) => name === "storage.local.set",
  )) {
    assert.deepEqual(
      Object.keys(items),
      [OBSERVATIONS_KEY],
      `${name} touched a key that is not the observation log`,
    );
  }
});

// ---------------------------------------------------------------------------
// The storm
// ---------------------------------------------------------------------------

test("a Space-restore storm is logged in full and cloned not at all", async (t) => {
  // Twenty windows inside a second, moments after launch, all but one of them
  // rebuilt behind the Space the user was last looking at.
  const fake = await setup(t, { startedAt: START - 1_000 });
  const created = [];
  for (let i = 0; i < 20; i += 1) {
    const win = openBlankWindow(fake, 10 + i);
    created.push(win);
    void fake.api.windows.onCreated.emit(win);
    fake.clock.advance(45);
  }
  void fake.api.windows.onFocusChanged.emit(created[7].id);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const log = await readObservations(fake.api);
  assert.equal(log.length, 20, "concurrent writes lost records");
  for (const record of log) {
    assert.equal(
      record.wouldClone,
      false,
      `window ${record.windowId} would have been cloned: ${record.reasons.join(" ")}`,
    );
  }
  // The burst counter saw the storm for what it was.
  assert.ok(
    log.some((record) => record.windowsCreatedInLastTwoSeconds > 1),
    "the burst counter never rose above one during a twenty-window storm",
  );
});

test("a genuine Cmd+N during a storm is logged as refused", async (t) => {
  const fake = await setup(t, { startedAt: START - 1_000 });
  for (let i = 0; i < 5; i += 1) {
    void fake.api.windows.onCreated.emit(openBlankWindow(fake, 20 + i));
    fake.clock.advance(50);
  }
  const mine = openBlankWindow(fake, 40);
  void fake.api.windows.onCreated.emit(mine);
  fake.clock.advance(20);
  void fake.api.windows.onFocusChanged.emit(40);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const record = (await readObservations(fake.api)).find(
    (entry) => entry.windowId === 40,
  );
  assert.equal(record.becameFocused, true);
  assert.equal(record.wouldClone, false, "failing closed is the point");
});

// ---------------------------------------------------------------------------
// The burst counter
// ---------------------------------------------------------------------------

test("two Cmd+N presses a minute apart both read as a lone window", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));
  fake.clock.advance(60_000);
  await observeWindow(fake, openBlankWindow(fake, 3));

  const log = await readObservations(fake.api);
  assert.deepEqual(
    log.map((record) => record.windowsCreatedInLastTwoSeconds),
    [1, 1],
    "the burst counter did not age out",
  );
  assert.deepEqual(log.map((record) => record.wouldClone), [true, true]);
});

test("two windows inside the burst window are both seen as a burst", async (t) => {
  const fake = await setup(t);
  void fake.api.windows.onCreated.emit(openBlankWindow(fake, 2));
  fake.clock.advance(500);
  void fake.api.windows.onCreated.emit(openBlankWindow(fake, 3));
  void fake.api.windows.onFocusChanged.emit(3);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const log = await readObservations(fake.api);
  assert.deepEqual(
    log.map((record) => record.windowsCreatedInLastTwoSeconds).sort(),
    [1, 2],
  );
  const second = log.find((record) => record.windowId === 3);
  assert.equal(second.wouldClone, false);
  assert.ok(second.reasons.includes("no:burst=2"));
});

// ---------------------------------------------------------------------------
// Failing closed on missing signals
// ---------------------------------------------------------------------------

test("a window nobody focused is recorded as unfocused and refused", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2), { focus: false });

  const [record] = await readObservations(fake.api);
  assert.equal(record.becameFocused, false);
  assert.equal(record.becameFocusedWithinMs, null);
  assert.equal(record.wouldClone, false);
  assert.ok(record.reasons.includes("no:never-focused"));
});

test("focus landing on some other window does not count", async (t) => {
  const fake = await setup(t);
  const win = openBlankWindow(fake, 2);
  void fake.api.windows.onCreated.emit(win);
  fake.clock.advance(30);
  void fake.api.windows.onFocusChanged.emit(1);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const [record] = await readObservations(fake.api);
  assert.equal(record.becameFocused, false);
  assert.equal(record.wouldClone, false);
});

test("focus arriving before the create event still counts", async (t) => {
  // Chromium does not promise the ordering of the two events.
  const fake = await setup(t);
  const win = openBlankWindow(fake, 2);
  void fake.api.windows.onFocusChanged.emit(2);
  fake.clock.advance(20);
  void fake.api.windows.onCreated.emit(win);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const [record] = await readObservations(fake.api);
  assert.equal(record.becameFocused, true);
  assert.equal(record.becameFocusedWithinMs, -20);
  assert.equal(record.wouldClone, true, record.reasons.join(" "));
});

test("focus from long before the create event does not count", async (t) => {
  const fake = await setup(t);
  const win = openBlankWindow(fake, 2);
  void fake.api.windows.onFocusChanged.emit(2);
  fake.clock.advance(FOCUS_GRACE_MS * 3);
  void fake.api.windows.onCreated.emit(win);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const [record] = await readObservations(fake.api);
  assert.equal(record.becameFocused, false);
  assert.equal(record.wouldClone, false);
});

test("an unknown browserStartedAt is logged as null and refused", async (t) => {
  const fake = await setup(t, { startedAt: null });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.browserStartedAt, null);
  assert.equal(record.msSinceBrowserStart, null);
  assert.equal(record.wouldClone, false, "a missing start time must not pass");
  assert.ok(record.reasons.includes("no:msSinceBrowserStart-unknown"));
});

test("a window created inside the quiet period is refused", async (t) => {
  const fake = await setup(t, { startedAt: START - 5_000 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.msSinceBrowserStart, 5_000);
  assert.equal(record.wouldClone, false);
});

test("a tabs.query that fails is recorded as unknown, not as empty", async (t) => {
  const fake = await setup(t);
  fake.api.tabs.query = async () => {
    throw new Error("window vanished");
  };
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.tabCount, null);
  assert.deepEqual(record.tabUrls, []);
  assert.equal(record.wouldClone, false);
  assert.ok(record.reasons.includes("no:tabs-unknown"));
});

test("a window that closed during the grace period is still logged", async (t) => {
  const fake = await setup(t);
  const win = openBlankWindow(fake, 2);
  void fake.api.windows.onCreated.emit(win);
  fake.windows.delete(2);
  void fake.api.windows.onFocusChanged.emit(2);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const [record] = await readObservations(fake.api);
  assert.equal(record.typeAfterGrace, null);
  assert.equal(record.windowId, 2);
});

// ---------------------------------------------------------------------------
// The log itself
// ---------------------------------------------------------------------------

test("the log keeps the newest MAX_OBSERVATIONS, dropping oldest first", async (t) => {
  const fake = await setup(t);
  for (let i = 0; i < MAX_OBSERVATIONS + 5; i += 1) {
    await observeWindow(fake, openBlankWindow(fake, 1_000 + i));
    fake.clock.advance(3_000);
  }

  const log = await readObservations(fake.api);
  assert.equal(log.length, MAX_OBSERVATIONS);
  assert.equal(log[0].windowId, 1_005, "the oldest records were not dropped");
  assert.equal(log.at(-1).windowId, 1_000 + MAX_OBSERVATIONS + 4);
});

test("an unreadable log is left alone rather than overwritten", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));
  const before = fake.storage.get(OBSERVATIONS_KEY);

  const realGet = fake.api.storage.local.get;
  fake.api.storage.local.get = async (keys) => {
    if (keys === OBSERVATIONS_KEY) throw new Error("storage unavailable");
    return realGet.call(fake.api.storage.local, keys);
  };
  fake.clock.advance(3_000);
  await observeWindow(fake, openBlankWindow(fake, 3));

  assert.deepEqual(
    fake.storage.get(OBSERVATIONS_KEY),
    before,
    "a failed read must not replace the log with a single record",
  );
});

test("a malformed log starts fresh rather than throwing", async (t) => {
  const fake = await setup(t);
  fake.storage.set(OBSERVATIONS_KEY, { not: "an array" });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const log = await readObservations(fake.api);
  assert.equal(log.length, 1);
  assert.equal(log[0].windowId, 2);
});

test("a storage write that fails is swallowed", async (t) => {
  const fake = await setup(t);
  fake.api.storage.local.set = async () => {
    throw new Error("quota exceeded");
  };
  await observeWindow(fake, openBlankWindow(fake, 2));
  assert.deepEqual(await readObservations(fake.api), []);
});

test("each record also goes to the console for anyone watching live", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));

  assert.equal(fake.logs.length, 1, "one compact line per record, no more");
  const [line] = fake.logs[0];
  assert.ok(
    line.startsWith("[Tab Boss dx] "),
    `observation output must carry the dx prefix, got ${line}`,
  );
  assert.equal(
    JSON.parse(line.slice("[Tab Boss dx] ".length)).windowId,
    2,
    "the logged line must be the record itself",
  );
});

test("readObservations reads an empty store as no records", async () => {
  const { api } = createFakeChrome();
  assert.deepEqual(await readObservations(api), []);
});
