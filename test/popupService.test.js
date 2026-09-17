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
  const reply = await handlePopupMessage(
    fake.api,
    createState(),
    { type: CAPTURE, name: "Daily" },
    now,
  );
  assert.deepEqual(reply, { ok: true, overwritten: false });
  const [set] = await readTabsets(fake.api);
  assert.equal(set.name, "Daily");
  assert.equal(set.savedAt, 12345);
  assert.deepEqual(
    set.plan.map((t) => t.url),
    ["https://a.test/", "https://b.test/"],
  );
});

test("capture of an incognito window saves nothing", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1, incognito: true }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://a.test/", active: true }],
  });
  const reply = await handlePopupMessage(
    fake.api,
    createState(),
    { type: CAPTURE, name: "X" },
    now,
  );
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
  const reply = await handlePopupMessage(
    fake.api,
    createState(),
    { type: OPEN, name: "Work" },
    now,
  );
  assert.equal(reply.ok, true);
  const [newId] = [...fake.windows.keys()].filter((id) => !before.has(id));
  const urls = [...fake.tabs.values()]
    .filter((t) => t.windowId === newId)
    .map((t) => t.url);
  assert.deepEqual(urls, ["https://x.test/"]);
});

test("opening a missing set creates no window", async () => {
  const fake = focusedWindow();
  const before = new Set(fake.windows.keys());
  const reply = await handlePopupMessage(
    fake.api,
    createState(),
    { type: OPEN, name: "ghost" },
    now,
  );
  assert.equal(reply.ok, false);
  assert.deepEqual(
    [...fake.windows.keys()].filter((id) => !before.has(id)),
    [],
  );
});

test("a restore message routes to the newest-snapshot restore", async () => {
  const fake = focusedWindow();
  // No snapshot stored, so restoreNewest badges and returns 0 — enough to prove
  // the message routed to it and got a reply.
  const reply = await handlePopupMessage(fake.api, createState(), { type: RESTORE }, now);
  assert.equal(reply.ok, true);
  assert.equal(reply.created, 0);
});

test("an unknown or malformed message is rejected", async () => {
  const fake = focusedWindow();
  assert.equal(
    (await handlePopupMessage(fake.api, createState(), { type: "nope" }, now)).ok,
    false,
  );
  assert.equal(
    (await handlePopupMessage(fake.api, createState(), null, now)).ok,
    false,
  );
});

test("capture rejects an empty or garbage name at the worker boundary", async () => {
  const fake = focusedWindow();
  for (const name of ["", "   ", null, "x".repeat(61)]) {
    const reply = await handlePopupMessage(fake.api, createState(), { type: CAPTURE, name }, now);
    assert.equal(reply.ok, false, `name ${JSON.stringify(name)} must be rejected`);
  }
  assert.deepEqual(await readTabsets(fake.api), [], "nothing may be stored");
});

test("capture stores the trimmed name", async () => {
  const fake = focusedWindow();
  await handlePopupMessage(fake.api, createState(), { type: CAPTURE, name: "  Trimmed  " }, now);
  const [set] = await readTabsets(fake.api);
  assert.equal(set.name, "Trimmed");
});

test("open reports failure when the window cannot be created", async () => {
  const fake = focusedWindow();
  await upsertTabset(fake.api, {
    name: "W",
    savedAt: 1,
    plan: [{ url: "https://x.test/", pinned: false, muted: false, active: true, groupKey: null }],
    groups: [],
  });
  fake.api.windows.create = async () => {
    throw new Error("no window");
  };
  const reply = await handlePopupMessage(fake.api, createState(), { type: OPEN, name: "W" }, now);
  assert.equal(reply.ok, false);
});
