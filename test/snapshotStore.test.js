import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import {
  MAX_SNAPSHOTS,
  appendSnapshot,
  newestSnapshot,
  readConsecutiveLosses,
  readMeta,
  readSnapshots,
  updateMeta,
  writeConsecutiveLosses,
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
  assert.deepEqual(await readMeta(api), { browserStartedAt: null });
  await writeMeta(api, { browserStartedAt: 42 });
  assert.deepEqual(await readMeta(api), { browserStartedAt: 42 });
});

test("a malformed meta value reads as the defaults", async () => {
  const { api, storage } = createFakeChrome();
  storage.set("meta", "nonsense");
  assert.deepEqual(await readMeta(api), { browserStartedAt: null });
});

test("updateMeta patches without disturbing what it was not given", async () => {
  const { api } = createFakeChrome();
  await writeMeta(api, { browserStartedAt: 42, somethingElse: "kept" });
  await updateMeta(api, { browserStartedAt: 99 });
  assert.deepEqual(await readMeta(api), {
    browserStartedAt: 99,
    somethingElse: "kept",
  });
});

test("the loss counter round-trips in session storage and defaults to zero", async () => {
  const { api } = createFakeChrome();
  assert.equal(await readConsecutiveLosses(api), 0);
  await writeConsecutiveLosses(api, 2);
  assert.equal(await readConsecutiveLosses(api), 2);
});

test("the loss counter is kept out of local storage entirely", async () => {
  const { api, storage, session } = createFakeChrome();
  await writeConsecutiveLosses(api, 2);
  // The point of the move: the browser clears session storage on shutdown, so
  // the counter cannot outlive a browser session no matter what the extension
  // does or which event wins a race at startup.
  assert.equal(session.get("consecutiveSuspectedLosses"), 2);
  assert.equal(storage.has("consecutiveSuspectedLosses"), false);
});

test("a browser restart leaves the counter cleared but keeps browserStartedAt", async () => {
  const { api, session } = createFakeChrome();
  await writeMeta(api, { browserStartedAt: 42 });
  await writeConsecutiveLosses(api, 2);

  session.clear(); // what the browser does on shutdown

  assert.equal(await readConsecutiveLosses(api), 0);
  assert.deepEqual(
    await readMeta(api),
    { browserStartedAt: 42 },
    "browserStartedAt must stay in local: in session storage, absent would be ambiguous between a fresh session and onStartup not having run yet",
  );
});

test("a malformed or negative loss counter reads as zero", async () => {
  const { api, session } = createFakeChrome();
  for (const bad of ["two", -1, 1.5, null, {}]) {
    session.set("consecutiveSuspectedLosses", bad);
    assert.equal(await readConsecutiveLosses(api), 0, `${JSON.stringify(bad)} must read as 0`);
  }
});

test("a session storage failure reads the counter as zero rather than throwing", async () => {
  const { api } = createFakeChrome();
  api.storage.session.get = async () => {
    throw new Error("storage is unavailable");
  };
  // 0 is the safe direction: it means no evidence a low count has persisted,
  // so the suspected-loss rule applies in full and refuses to overwrite.
  assert.equal(await readConsecutiveLosses(api), 0);
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
