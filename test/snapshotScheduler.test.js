import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import {
  newestSnapshot,
  readConsecutiveLosses,
  readMeta,
  readSnapshots,
  writeConsecutiveLosses,
  writeMeta,
} from "../src/snapshotStore.js";
import { totalTabs } from "../src/snapshot.js";
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
  const state = createState();
  assert.equal(await captureNow(api, 0, state), "saved");
  assert.equal((await readSnapshots(api)).length, 1);
});

test("a capture inside the quiet period is skipped", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  await writeMeta(api, { browserStartedAt: 1000 });
  assert.equal(await captureNow(api, 1000 + QUIET_PERIOD_MS - 1, state), "quiet");
  assert.deepEqual(await readSnapshots(api), []);
});

test("a capture just past the quiet period is saved", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  await writeMeta(api, { browserStartedAt: 1000 });
  assert.equal(await captureNow(api, 1000 + QUIET_PERIOD_MS, state), "saved");
});

test("a missing browserStartedAt never blocks a save", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  assert.equal(await captureNow(api, 0, state), "saved");
});

test("an unchanged layout is skipped silently", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  assert.equal(await captureNow(api, 0, state), "saved");
  assert.equal(await captureNow(api, 1, state), "unchanged");
  assert.equal((await readSnapshots(api)).length, 1);
});

test("a halved tab count is skipped as a suspected loss and counted", async () => {
  const { api, tabs } = fakeWith(10);
  const state = createState();
  assert.equal(await captureNow(api, 0, state), "saved");
  for (const id of [...tabs.keys()].slice(4)) tabs.delete(id);
  assert.equal(await captureNow(api, 1, state), "loss");
  assert.equal(await readConsecutiveLosses(api), 1);
  assert.equal((await readSnapshots(api)).length, 1);
});

test("a persistent low count is accepted on the third try and resets the counter", async () => {
  const { api, tabs } = fakeWith(10);
  const state = createState();
  await captureNow(api, 0, state);
  for (const id of [...tabs.keys()].slice(4)) tabs.delete(id);
  for (let i = 1; i < MAX_CONSECUTIVE_LOSSES; i += 1) {
    assert.equal(await captureNow(api, i, state), "loss");
  }
  assert.equal(await captureNow(api, MAX_CONSECUTIVE_LOSSES, state), "saved");
  assert.equal(await readConsecutiveLosses(api), 0);
  assert.equal((await readSnapshots(api)).length, 2);
});

test("a successful save resets the loss counter", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  await writeMeta(api, { browserStartedAt: null });
  await writeConsecutiveLosses(api, 2);
  assert.equal(await captureNow(api, 0, state), "saved");
  assert.equal(await readConsecutiveLosses(api), 0);
});

test("the first ever capture cannot be a loss or unchanged", async () => {
  const { api } = fakeWith(1);
  const state = createState();
  assert.equal(await captureNow(api, 0, state), "saved");
});

test("installing creates the repeating alarm when there is none", async () => {
  const { api, calls } = fakeWith(1);
  await installSnapshotScheduler(api, createState());
  assert.deepEqual(
    calls.filter(([name]) => name === "alarms.create"),
    [
      [
        "alarms.create",
        SNAPSHOT_ALARM,
        {
          periodInMinutes: SNAPSHOT_PERIOD_MINUTES,
          persistAcrossSessions: true,
        },
      ],
    ],
  );
});

test("installing again does not reschedule an alarm that already exists", async () => {
  const { api, calls } = fakeWith(1);
  const state = createState();
  // Every cold start of an evicted Manifest V3 service worker re-runs
  // background.js and therefore this installer. Chromium cancels and replaces
  // a same-name alarm, and with only periodInMinutes set it re-derives the
  // first fire time as now + 2 minutes. A browser that cold-starts more often
  // than every two minutes — which four high-frequency tab and window
  // listeners guarantee — would then never take a single snapshot.
  await installSnapshotScheduler(api, state);
  await installSnapshotScheduler(api, state);
  await installSnapshotScheduler(api, state);

  assert.equal(
    calls.filter(([name]) => name === "alarms.create").length,
    1,
    "re-creating the alarm on every cold start resets its clock and the snapshot never fires",
  );
});

test("the alarm firing takes a snapshot", async () => {
  const { api } = fakeWith(2);
  const state = createState();
  await installSnapshotScheduler(api, state);
  await api.alarms.onAlarm.emit({ name: SNAPSHOT_ALARM });
  assert.equal((await readSnapshots(api)).length, 1);
});

test("an unrelated alarm takes no snapshot", async () => {
  const { api } = fakeWith(2);
  const state = createState();
  await installSnapshotScheduler(api, state);
  await api.alarms.onAlarm.emit({ name: "something-else" });
  assert.deepEqual(await readSnapshots(api), []);
});

test("startup records the browser start time", async () => {
  const { api } = fakeWith(2);
  await installSnapshotScheduler(api, createState());
  await api.runtime.onStartup.emit();
  assert.notEqual((await readMeta(api)).browserStartedAt, null);
});

test("a browser start landing mid-capture survives the capture's own meta write", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  await installSnapshotScheduler(api, state);

  const getAll = api.windows.getAll;
  let fired = false;
  api.windows.getAll = async () => {
    if (!fired) {
      fired = true;
      // chrome.runtime.onStartup lands while the capture is suspended. With a
      // persisted alarm this is not hypothetical: an overdue alarm fires at
      // startup, so the two writers really do overlap.
      await api.runtime.onStartup.emit();
    }
    return getAll();
  };

  await captureNow(api, 0, state);

  assert.notEqual(
    (await readMeta(api)).browserStartedAt,
    null,
    "the capture wrote back a meta it had read before onStartup, losing the browser start time and with it the quiet period",
  );
});

/**
 * Ends a browser session the way the browser does: storage.local survives, so
 * `meta.browserStartedAt` still holds the OLD session's value, and
 * storage.session is cleared. Then the machine comes back up holding `tabs`
 * worth of tabs.
 */
async function restartBrowserInto(fake, tabCount) {
  fake.session.clear();
  for (const id of [...fake.tabs.keys()].slice(tabCount)) fake.tabs.delete(id);
}

/** Runs `n` captures that are each expected to be refused as a loss. */
async function accumulateStrikes(api, state, n) {
  for (let i = 0; i < n; i += 1) {
    assert.equal(await captureNow(api, 1_000_000 + i, state), "loss");
  }
}

test("an alarm that fires before onStartup cannot save a halved candidate", async () => {
  // Ten tabs of good history, and the counter ends the session sitting at two.
  const fake = fakeWith(10);
  const { api } = fake;
  const state = createState();
  await installSnapshotScheduler(api, state);
  await writeMeta(api, { browserStartedAt: 1_000 });
  await captureNow(api, 500_000, state);
  for (const id of [...fake.tabs.keys()].slice(4)) fake.tabs.delete(id);
  await accumulateStrikes(api, state, MAX_CONSECUTIVE_LOSSES - 1);
  assert.equal(await readConsecutiveLosses(api), MAX_CONSECUTIVE_LOSSES - 1);

  // Crash, relaunch into a single tab. The persisted overdue alarm fires
  // BEFORE runtime.onStartup, so browserStartedAt is still the previous
  // session's value and the quiet period is bypassed. Before the counter moved
  // to storage.session, that left the escape hatch as the only thing standing
  // in the way — and it was already at two, so it fired on the very first
  // capture of the new session and the remnant became the newest snapshot.
  await restartBrowserInto(fake, 1);
  await api.alarms.onAlarm.emit({ name: SNAPSHOT_ALARM });

  assert.equal(
    totalTabs(await newestSnapshot(api)),
    10,
    "a counter that outlives the browser collapses the six-minute buffer to nothing",
  );
});

test("a restart clears the loss counter even when onStartup runs first", async () => {
  const fake = fakeWith(10);
  const { api } = fake;
  const state = createState();
  await installSnapshotScheduler(api, state);
  await captureNow(api, 0, state);
  for (const id of [...fake.tabs.keys()].slice(4)) fake.tabs.delete(id);
  await accumulateStrikes(api, state, MAX_CONSECUTIVE_LOSSES - 1);

  await restartBrowserInto(fake, 1);
  await api.runtime.onStartup.emit();

  const { browserStartedAt } = await readMeta(api);
  // Past the quiet period, so only the loss counter stands between the remnant
  // and the newest snapshot. Both event orderings land here, because the reset
  // is a property of the storage area rather than of the event.
  assert.equal(
    await captureNow(api, browserStartedAt + QUIET_PERIOD_MS, state),
    "loss",
  );
  assert.equal(totalTabs(await newestSnapshot(api)), 10);
});

test("the loss counter accumulates across ticks and survives a worker eviction", async () => {
  // Moving storage areas must not break the behaviour the escape hatch exists
  // for: a user who genuinely closes half their tabs still gets a snapshot
  // after about six minutes.
  const fake = fakeWith(10);
  const { api } = fake;
  const state = createState();
  await installSnapshotScheduler(api, state);
  await captureNow(api, 0, state);
  for (const id of [...fake.tabs.keys()].slice(4)) fake.tabs.delete(id);

  assert.equal(await captureNow(api, 1, state), "loss");
  assert.equal(await readConsecutiveLosses(api), 1);

  // Manifest V3 evicts the worker between two-minute ticks and background.js
  // re-runs. storage.session survives that, unlike anything held in memory.
  await installSnapshotScheduler(api, createState());

  assert.equal(await captureNow(api, 2, state), "loss");
  assert.equal(await readConsecutiveLosses(api), MAX_CONSECUTIVE_LOSSES - 1);
  assert.equal(await captureNow(api, 3, state), "saved");
  assert.equal(await readConsecutiveLosses(api), 0, "a successful save resets the counter");
  assert.equal(totalTabs(await newestSnapshot(api)), 4, "the low count is accepted on the third strike");
});

test("no snapshot is taken while a restore is in flight", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  state.restoreInProgress = true;
  assert.equal(await captureNow(api, 0, state), "restoring");
  assert.deepEqual(await readSnapshots(api), []);
});

test("a restore that begins mid-capture still blocks the save", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  const getAll = api.windows.getAll;
  api.windows.getAll = async () => {
    // The user clicks the toolbar icon while the capture is reading windows.
    state.restoreInProgress = true;
    return getAll();
  };
  assert.equal(await captureNow(api, 0, state), "restoring");
  assert.deepEqual(
    await readSnapshots(api),
    [],
    "a half-built restore must never become the newest snapshot: the next click would restore it",
  );
});

test("a restore beginning mid-capture does not spend a suspected-loss strike", async () => {
  const { api, tabs } = fakeWith(10);
  const state = createState();
  await captureNow(api, 0, state);
  // What a half-built restore looks like from here: a remnant, and so a
  // convincing suspected loss.
  for (const id of [...tabs.keys()].slice(1)) tabs.delete(id);

  const getAll = api.windows.getAll;
  api.windows.getAll = async () => {
    state.restoreInProgress = true;
    return getAll();
  };

  assert.equal(await captureNow(api, 1, state), "restoring");
  assert.equal(
    await readConsecutiveLosses(api),
    0,
    "the counter is a write too: a reading of the browser that was never real must not spend a strike towards the escape hatch",
  );
});

test("the alarm takes no snapshot during a restore", async () => {
  const { api } = fakeWith(3);
  const state = createState();
  await installSnapshotScheduler(api, state);
  state.restoreInProgress = true;
  await api.alarms.onAlarm.emit({ name: SNAPSHOT_ALARM });
  assert.deepEqual(
    await readSnapshots(api),
    [],
    "the scheduler must be given the shared state, not just the api",
  );
});
