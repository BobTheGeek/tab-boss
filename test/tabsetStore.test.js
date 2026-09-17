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
  plan: urls.map((url) => ({
    url,
    pinned: false,
    muted: false,
    active: false,
    groupKey: null,
  })),
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
  assert.deepEqual(
    found.plan.map((t) => t.url),
    ["https://a.test/"],
  );
});

test("upsert with an existing name replaces in place, not duplicates", async () => {
  const { api } = createFakeChrome();
  await upsertTabset(api, setOf("Daily", ["https://old.test/"]));
  const replaced = await upsertTabset(api, setOf("Daily", ["https://new.test/"]));
  assert.equal(replaced, true);
  const all = await readTabsets(api);
  assert.equal(all.length, 1);
  assert.deepEqual(
    all[0].plan.map((t) => t.url),
    ["https://new.test/"],
  );
});

test("delete removes a set by name", async () => {
  const { api } = createFakeChrome();
  await upsertTabset(api, setOf("A", ["https://a.test/"]));
  await upsertTabset(api, setOf("B", ["https://b.test/"]));
  await deleteTabset(api, "A");
  assert.deepEqual(
    (await readTabsets(api)).map((s) => s.name),
    ["B"],
  );
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
  assert.deepEqual(
    (await readTabsets(api)).map((s) => s.name),
    ["Keep"],
  );
});

test("a storage failure reads as no tabsets rather than throwing", async () => {
  const { api } = createFakeChrome();
  api.storage.local.get = async () => {
    throw new Error("unavailable");
  };
  assert.deepEqual(await readTabsets(api), []);
});
