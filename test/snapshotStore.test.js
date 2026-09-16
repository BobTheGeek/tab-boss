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

test("a storage failure during append aborts without ever calling storage.local.set", async () => {
  const { api, calls, storage } = createFakeChrome();
  storage.set("snapshots", [snap(1), snap(2)]);
  api.storage.local.get = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(() => appendSnapshot(api, snap(3)));
  assert.equal(
    calls.some(([name]) => name === "storage.local.set"),
    false,
  );
});

test("a storage failure during append leaves existing snapshots intact", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("snapshots", [snap(1), snap(2)]);
  const originalGet = api.storage.local.get;
  api.storage.local.get = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(() => appendSnapshot(api, snap(3)));
  api.storage.local.get = originalGet;
  assert.deepEqual((await readSnapshots(api)).map((s) => s.takenAt), [1, 2]);
});

test("a malformed stored value during append still succeeds, starting fresh", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("snapshots", { not: "an array" });
  await appendSnapshot(api, snap(1));
  assert.deepEqual((await readSnapshots(api)).map((s) => s.takenAt), [1]);
});

test("mutating a snapshot returned from readSnapshots does not corrupt the store", async () => {
  const { api } = createFakeChrome();
  await appendSnapshot(api, snap(1));
  const [first] = await readSnapshots(api);
  first.takenAt = 999;
  first.windows.push("mutated");
  const [again] = await readSnapshots(api);
  assert.equal(again.takenAt, 1);
  assert.deepEqual(again.windows, []);
});

test("mutating a snapshot after it is passed to appendSnapshot does not corrupt the store", async () => {
  const { api } = createFakeChrome();
  const original = snap(1);
  await appendSnapshot(api, original);
  original.takenAt = 999;
  original.windows.push("mutated");
  const [stored] = await readSnapshots(api);
  assert.equal(stored.takenAt, 1);
  assert.deepEqual(stored.windows, []);
});
