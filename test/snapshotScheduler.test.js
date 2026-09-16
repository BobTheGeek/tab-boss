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
