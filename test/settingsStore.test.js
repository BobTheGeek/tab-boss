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
