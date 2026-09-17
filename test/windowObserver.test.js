import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome, createManualClock } from "./fakeChrome.js";
import {
  FOCUS_GRACE_MS,
  STARTUP_QUIET_MS,
} from "../src/windowClassifier.js";
import {
  MAX_OBSERVATIONS,
  OBSERVATIONS_KEY,
  SESSION_START_KEY,
  installWindowObserver,
  readObservations,
} from "../src/windowObserver.js";
import {
  createState,
  recordFocus,
  resolveSourceWindowId,
} from "../src/state.js";
import { cloneIntoWindow, installWindowCloning } from "../src/windowCloning.js";

const START = 1_700_000_000_000;

/** Comfortably outside the startup quiet period. */
const LONG_AGO = START - STARTUP_QUIET_MS - 60_000;

/**
 * The only calls this instrument is allowed to make. The whole point of the
 * exercise is that it observes and writes a log; if this list ever grows a
 * `tabs.` or `windows.` verb, the instrument has become a participant.
 *
 * `storage.session.set` is a write, but only of the session marker, and a
 * separate assertion pins it to that one key.
 */
const READ_ONLY_CALLS = new Set([
  "tabs.query",
  "windows.get",
  "storage.local.get",
  "storage.local.set",
  "storage.session.get",
  "storage.session.set",
]);

/**
 * A fake browser with one window already open, plus an observer wired to a
 * hand-driven clock.
 *
 * `sessionStartedAt` seeds `storage.session` BEFORE the observer installs, so
 * the default is a session that has been running for a while: a genuine Cmd+N.
 * Passing `null` leaves session storage empty, which is what the browser hands
 * a worker on the first start after a restart.
 *
 * `startedAt` seeds `meta.browserStartedAt` in `storage.local` separately. It
 * no longer decides anything — it is recorded so we can check that the session
 * marker is catching the staleness it was introduced to catch.
 *
 * Both are seeded straight into the fake's backing maps rather than through
 * the api, so `calls` holds only what the observer itself did — including what
 * it did at install, which is where the session marker is claimed.
 *
 * Exactly one observer per fake. `createEvent` in the fake awaits each
 * listener in turn, and this listener parks on a grace timer, so a second
 * observer on the same fake would never be reached before the test advanced
 * the clock. That is a fake artefact, but installing two live observers into
 * one browser is not a real scenario either: MV3 evicts the old worker before
 * cold-starting the new one.
 */
async function setup(
  t,
  {
    sessionStartedAt = LONG_AGO,
    startedAt = LONG_AGO,
    breakSessionStorage = false,
    performClone,
    resolveCloneSource,
  } = {},
) {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 100, windowId: 1, index: 0, url: "https://example.com/" }],
  });
  if (startedAt !== null) fake.storage.set("meta", { browserStartedAt: startedAt });
  if (sessionStartedAt !== null) {
    fake.session.set(SESSION_START_KEY, sessionStartedAt);
  }
  if (breakSessionStorage) {
    fake.api.storage.session.get = async () => {
      throw new Error("session storage unavailable");
    };
  }

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
    performClone,
    resolveCloneSource,
  });
  return { ...fake, clock, observer, logs };
}

/** How many times the observer wrote to a storage area. */
const setCalls = (fake, area) =>
  fake.calls.filter(([name]) => name === `storage.${area}.set`);

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
  assert.equal(record.sessionStartedAt, LONG_AGO);
  assert.equal(record.msSinceSessionStart, STARTUP_QUIET_MS + 60_000);
  assert.equal(record.windowsCreatedInLastTwoSeconds, 1);
  assert.equal(record.becameFocused, true);
  assert.equal(record.becameFocusedWithinMs, 30);
  assert.equal(record.createdAt, START);
  assert.ok(Array.isArray(record.reasons) && record.reasons.length === 5);
  // Kept for the tb-dup lead: the gate and the failure disagreed about the
  // window's type, so the type after the grace period is worth having.
  assert.equal(record.typeAfterGrace, "normal");
  // Kept so we can check that storage.session behaves on ego lite the way the
  // docs say. Recorded, not decisive.
  assert.equal(record.browserStartedAt, LONG_AGO);
  assert.equal(record.msSinceBrowserStart, STARTUP_QUIET_MS + 60_000);
  assert.equal(record.startupSeenAt, null);
});

test("the record reads as a timeline, not as epoch arithmetic", async (t) => {
  // Concern 2 lives or dies on someone being able to scan this log and tell a
  // launch storm from one window in the middle of the afternoon.
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));
  fake.clock.advance(240_000);
  await observeWindow(fake, openBlankWindow(fake, 3));

  const log = await readObservations(fake.api);
  assert.equal(log[0].at, new Date(START).toISOString());
  assert.equal(log[0].msSincePreviousWindow, null, "the first window has no gap");
  assert.equal(
    log[1].msSincePreviousWindow,
    240_431,
    "a four-minute gap must be readable without subtracting timestamps",
  );
});

test("a storm is visible in the record as a run of tiny gaps", async (t) => {
  const fake = await setup(t, { sessionStartedAt: START - 1_000 });
  for (let i = 0; i < 5; i += 1) {
    void fake.api.windows.onCreated.emit(openBlankWindow(fake, 60 + i));
    fake.clock.advance(45);
  }
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const log = await readObservations(fake.api);
  assert.deepEqual(
    log.map((record) => record.msSincePreviousWindow),
    [null, 45, 45, 45, 45],
  );
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
  const fake = await setup(t, { sessionStartedAt: START - 1_000, startedAt: START - 1_000 });
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
  const fake = await setup(t, { sessionStartedAt: START - 1_000, startedAt: START - 1_000 });
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

test("a window created inside the quiet period is refused", async (t) => {
  const fake = await setup(t, { sessionStartedAt: START - 5_000 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.msSinceSessionStart, 5_000);
  assert.equal(record.wouldClone, false);
});

// ---------------------------------------------------------------------------
// The session marker — the fix for a browserStartedAt that outlives its
// browser. See src/windowObserver.js SESSION_START_KEY.
// ---------------------------------------------------------------------------

test("a fresh session claims the marker and puts its windows inside the quiet period", async (t) => {
  // storage.session empty is what the browser hands the first worker after a
  // restart. The observer claims the marker at install, so every window of the
  // restore storm is measured against a start time of right now.
  const fake = await setup(t, { sessionStartedAt: null });
  await observeWindow(fake, openBlankWindow(fake, 2));

  assert.equal(
    fake.session.get(SESSION_START_KEY),
    START,
    "the first worker start since the browser came up must claim the marker",
  );

  const [record] = await readObservations(fake.api);
  assert.equal(record.sessionStartedAt, START);
  assert.equal(record.msSinceSessionStart, 0);
  assert.equal(record.wouldClone, false);
  assert.ok(record.reasons.includes("no:startup-quiet=0ms"));
});

test("a session marker two hours old puts its windows outside the quiet period", async (t) => {
  const fake = await setup(t, { sessionStartedAt: START - 7_200_000 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.msSinceSessionStart, 7_200_000);
  assert.equal(record.wouldClone, true, record.reasons.join(" "));
});

test("a browserStartedAt that outlived its browser no longer passes the quiet period", async (t) => {
  // THE BUG. `meta.browserStartedAt` lives in storage.local and survives a
  // restart, so a Space storm that beats runtime.onStartup reads the previous
  // session's timestamp — here, three hours ago. Keyed off that value,
  // condition 3 would sail through at the one moment it exists to fire.
  // Keyed off the session marker, it fires.
  const fake = await setup(t, {
    sessionStartedAt: null,
    startedAt: START - 10_800_000,
  });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(
    record.msSinceBrowserStart,
    10_800_000,
    "the stale local timestamp is still recorded, so we can see it happening",
  );
  assert.equal(record.startupSeenAt, null, "onStartup has not run yet");
  assert.equal(record.msSinceSessionStart, 0);
  assert.equal(
    record.wouldClone,
    false,
    "a three-hour-old timestamp from a dead browser must not unlock cloning",
  );
});

test("a cold start that finds the marker leaves it exactly where it was", async (t) => {
  // storage.session survives worker eviction and is cleared only when the
  // browser shuts down, so a cold start mid-session finds the previous
  // worker's marker. Manifest V3 evicts this worker constantly, so if an
  // install could re-claim the marker, every eviction would reset the quiet
  // period and the restore-storm guard would be off more often than on.
  const fake = await setup(t, { sessionStartedAt: START - 300_000 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  assert.equal(fake.session.get(SESSION_START_KEY), START - 300_000);
  assert.equal(
    setCalls(fake, "session").length,
    0,
    "an install that found a marker must not write one",
  );
  const [record] = await readObservations(fake.api);
  assert.equal(record.sessionStartedAt, START - 300_000);
  assert.equal(record.msSinceSessionStart, 300_000);
  assert.equal(record.wouldClone, true, record.reasons.join(" "));
});

test("an unreadable session marker is a no, not a yes", async (t) => {
  const fake = await setup(t, { breakSessionStorage: true });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.sessionStartedAt, null);
  assert.equal(record.msSinceSessionStart, null);
  assert.equal(record.wouldClone, false);
  assert.ok(record.reasons.includes("no:sessionStart-unknown"));
});

test("a session marker claim is attempted again after a storage failure", async (t) => {
  // One transient failure must not blind the quiet period for the whole life
  // of the worker.
  const fake = await setup(t, { breakSessionStorage: true });
  await observeWindow(fake, openBlankWindow(fake, 2));
  assert.equal((await readObservations(fake.api))[0].sessionStartedAt, null);

  fake.api.storage.session.get = async (keys) => {
    fake.calls.push(["storage.session.get", keys]);
    return fake.session.has(keys) ? { [keys]: fake.session.get(keys) } : {};
  };
  fake.clock.advance(3_000);
  await observeWindow(fake, openBlankWindow(fake, 3));

  const record = (await readObservations(fake.api)).at(-1);
  assert.equal(
    record.sessionStartedAt,
    LONG_AGO,
    "the observer must retry rather than stay blind for the worker's lifetime",
  );
});

test("the session marker is the only thing ever written to session storage", async (t) => {
  const fake = await setup(t, { sessionStartedAt: null });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const writes = setCalls(fake, "session");
  assert.equal(writes.length, 1, "claimed once, at install, and never again");
  assert.deepEqual(Object.keys(writes[0][1]), [SESSION_START_KEY]);
  assert.deepEqual([...fake.session.keys()], [SESSION_START_KEY]);
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
  const [summary, json] = fake.logs[0];
  assert.ok(
    summary.startsWith("[Tab Boss dx] "),
    `observation output must carry the dx prefix, got ${summary}`,
  );
  // The summary leads so a storm is a visible shape in the console.
  assert.match(summary, /window=2/);
  assert.match(summary, /WOULD CLONE/);
  assert.match(summary, /burst=1/);
  assert.match(summary, /first/);
  assert.equal(
    JSON.parse(json).windowId,
    2,
    "the full record must follow, so the console is replayable too",
  );
});

test("the console summary says why a storm looks like a storm", async (t) => {
  const fake = await setup(t, { sessionStartedAt: START - 1_000 });
  void fake.api.windows.onCreated.emit(openBlankWindow(fake, 2));
  fake.clock.advance(45);
  void fake.api.windows.onCreated.emit(openBlankWindow(fake, 3));
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  const summaries = fake.logs.map(([summary]) => summary);
  assert.ok(summaries.every((line) => line.includes("would not clone")));
  assert.ok(summaries.some((line) => line.includes("burst=2 gap=45ms")));
});

test("readObservations reads an empty store as no records", async () => {
  const { api } = createFakeChrome();
  assert.deepEqual(await readObservations(api), []);
});

// ---------------------------------------------------------------------------
// Driving the cloner
//
// Production wires `performClone` and `resolveCloneSource`; observe-only (the
// kill switch off) leaves them undefined and the observer only logs. These pin
// the handoff: the classifier decides, and only a "would clone" verdict reaches
// the writer, with the source captured at create time.
// ---------------------------------------------------------------------------

/** A spy standing in for cloneIntoWindow. Records (windowId, sourceId). */
function cloneSpy(result = true) {
  const calls = [];
  const fn = async (win, sourceId) => {
    calls.push({ windowId: win.id, sourceId });
    return result;
  };
  fn.calls = calls;
  return fn;
}

test("a would-clone verdict hands the window to the cloner and records it", async (t) => {
  const performClone = cloneSpy(true);
  const fake = await setup(t, { performClone, resolveCloneSource: () => 1 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  assert.deepEqual(performClone.calls, [{ windowId: 2, sourceId: 1 }]);
  const [record] = await readObservations(fake.api);
  assert.equal(record.wouldClone, true, record.reasons?.join(" "));
  assert.equal(record.action, "cloned");
});

test("a window the classifier rejects is never handed to the cloner", async (t) => {
  const performClone = cloneSpy(true);
  const fake = await setup(t, { performClone, resolveCloneSource: () => 1 });
  // Never focused: a mid-session Space, which the classifier vetoes.
  await observeWindow(fake, openBlankWindow(fake, 2, { focused: false }), {
    focus: false,
  });

  assert.deepEqual(performClone.calls, []);
  const [record] = await readObservations(fake.api);
  assert.equal(record.wouldClone, false);
  assert.equal(record.action, "logged");
});

test("a clone the writer declines is recorded as declined", async (t) => {
  const performClone = cloneSpy(false);
  const fake = await setup(t, { performClone, resolveCloneSource: () => 1 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  assert.equal(performClone.calls.length, 1);
  const [record] = await readObservations(fake.api);
  assert.equal(record.action, "clone-declined-by-writer");
});

test("a clone action that throws does not break the observer", async (t) => {
  const performClone = async () => {
    throw new Error("boom");
  };
  const fake = await setup(t, { performClone, resolveCloneSource: () => 1 });
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.action, "clone-errored");
  assert.equal(record.wouldClone, true);
});

test("the clone source is captured at create time, not after the focus grace", async (t) => {
  const performClone = cloneSpy(true);
  let source = 1;
  const fake = await setup(t, {
    performClone,
    resolveCloneSource: () => source,
  });
  void fake.api.windows.onCreated.emit(openBlankWindow(fake, 2));
  // The focus history moves during the grace period. The source handed to the
  // writer must be the one from create time, not this later value.
  source = 999;
  fake.clock.advance(30);
  void fake.api.windows.onFocusChanged.emit(2);
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  assert.deepEqual(performClone.calls, [{ windowId: 2, sourceId: 1 }]);
});

test("a restart storm hands nothing to the cloner", async (t) => {
  const performClone = cloneSpy(true);
  // Fresh session marker: every window is inside the quiet period, and they
  // arrive in a burst. Storm windows DO focus fast, so focus alone would not
  // save us here — the quiet period and burst counter must.
  const fake = await setup(t, {
    sessionStartedAt: START,
    performClone,
    resolveCloneSource: () => 1,
  });
  for (let id = 2; id <= 8; id += 1) {
    void fake.api.windows.onCreated.emit(openBlankWindow(fake, id));
    fake.clock.advance(5);
    void fake.api.windows.onFocusChanged.emit(id);
  }
  fake.clock.advance(FOCUS_GRACE_MS + 1);
  await fake.observer.idle();

  assert.deepEqual(performClone.calls, [], "no restored Space may be cloned");
  const log = await readObservations(fake.api);
  assert.ok(log.every((r) => r.wouldClone === false));
  assert.ok(log.every((r) => r.action === "logged"));
});

test("with no clone action wired, the observer only logs", async (t) => {
  const fake = await setup(t);
  await observeWindow(fake, openBlankWindow(fake, 2));

  const [record] = await readObservations(fake.api);
  assert.equal(record.wouldClone, true);
  assert.equal(record.action, "logged");
});

// ---------------------------------------------------------------------------
// End to end with the real cloner
//
// The spy tests pin the handoff; cloneIntoWindow's internals are pinned by
// test/windowCloning.test.js. This proves the two compose: a genuine Cmd+N,
// driven only through the observer, actually copies the source window's tabs.
// ---------------------------------------------------------------------------

test("a genuine Cmd+N, driven through the observer, really clones the source", async (t) => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
    ],
  });
  fake.storage.set("meta", { browserStartedAt: LONG_AGO });
  fake.session.set(SESSION_START_KEY, LONG_AGO);

  const state = createState();
  recordFocus(state, 1); // the window the user came from
  installWindowCloning(fake.api, state); // abort tracking

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
    resolveCloneSource: (win) => resolveSourceWindowId(state, win.id),
    performClone: (win, sourceId) =>
      cloneIntoWindow(fake.api, state, win, sourceId),
  });

  // A blank new window, focused fast: a deliberate Cmd+N.
  const win = { id: 2, type: "normal", incognito: false, focused: true };
  fake.windows.set(2, win);
  fake.tabs.set(20, {
    id: 20,
    windowId: 2,
    index: 0,
    url: "about:blank",
    pinned: false,
    active: true,
    groupId: -1,
    mutedInfo: { muted: false },
  });

  void fake.api.windows.onCreated.emit(win);
  clock.advance(30);
  void fake.api.windows.onFocusChanged.emit(2);
  clock.advance(FOCUS_GRACE_MS + 1);
  await observer.idle();

  const clonedUrls = [...fake.tabs.values()]
    .filter((tab) => tab.windowId === 2)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.url);
  assert.deepEqual(clonedUrls, ["https://a.test/", "https://b.test/"]);
});

test("a window created during a restore is never cloned, even with a clone wired", async (t) => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://a.test/", active: true }],
  });
  fake.storage.set("meta", { browserStartedAt: LONG_AGO });
  fake.session.set(SESSION_START_KEY, LONG_AGO);

  const state = createState();
  recordFocus(state, 1);
  installWindowCloning(fake.api, state);
  state.restoreInProgress = true; // a restore is building windows

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
    resolveCloneSource: (win) => resolveSourceWindowId(state, win.id),
    performClone: (win, sourceId) =>
      cloneIntoWindow(fake.api, state, win, sourceId),
  });

  const win = { id: 2, type: "normal", incognito: false, focused: true };
  fake.windows.set(2, win);
  fake.tabs.set(20, {
    id: 20,
    windowId: 2,
    index: 0,
    url: "about:blank",
    pinned: false,
    active: true,
    groupId: -1,
    mutedInfo: { muted: false },
  });

  void fake.api.windows.onCreated.emit(win);
  clock.advance(30);
  void fake.api.windows.onFocusChanged.emit(2);
  clock.advance(FOCUS_GRACE_MS + 1);
  await observer.idle();

  const win2Tabs = [...fake.tabs.values()].filter((tab) => tab.windowId === 2);
  assert.equal(win2Tabs.length, 1, "the restored window must be left untouched");
  const [record] = await readObservations(fake.api);
  assert.equal(record.action, "clone-declined-by-writer");
});
