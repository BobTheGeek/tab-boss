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
