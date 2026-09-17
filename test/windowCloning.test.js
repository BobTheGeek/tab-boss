import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { isClonableUrl as writerIsClonableUrl } from "../src/tabWriter.js";
import {
  duplicateFocusedWindow,
  isClonableUrl,
  writeIntoNewWindow,
} from "../src/windowCloning.js";

test("isClonableUrl is still reachable from here", () => {
  // The scheme test moved to the writer, and its own tests live beside it in
  // test/tabWriter.test.js. This only pins the re-export importers rely on.
  assert.equal(isClonableUrl, writerIsClonableUrl);
});
// ---------------------------------------------------------------------------
// Duplicate this window (explicit, user-triggered)
//
// The safe replacement for auto-clone: the user asks by name, so there is no
// windows.onCreated to misread and no restart storm to fear. It reuses the same
// write path and every guard.
// ---------------------------------------------------------------------------

function newWindowIds(fake, before) {
  return [...fake.windows.keys()].filter((id) => !before.has(id));
}

test("duplicate copies the focused window's tabs into a brand new window", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
    ],
  });
  const state = createState();
  const before = new Set(fake.windows.keys());

  const ok = await duplicateFocusedWindow(fake.api, state);
  assert.equal(ok, true);

  const [newId] = newWindowIds(fake, before);
  const urls = [...fake.tabs.values()]
    .filter((t) => t.windowId === newId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.url);
  assert.deepEqual(urls, ["https://a.test/", "https://b.test/"]);
  // The original window is left exactly as it was.
  assert.equal([...fake.tabs.values()].filter((t) => t.windowId === 1).length, 2);
});

test("duplicate never touches an existing window", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://a.test/", active: true }],
  });
  const state = createState();
  await duplicateFocusedWindow(fake.api, state);
  const removes = fake.calls.filter(([name]) => name === "tabs.remove");
  // The only remove allowed is the new window's own placeholder.
  for (const [, tabId] of removes) {
    assert.notEqual(tabId, 10, "an existing window's tab was removed");
  }
});

test("duplicate tags the new window so nothing else can clone onto it", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://a.test/", active: true }],
  });
  const state = createState();
  const before = new Set(fake.windows.keys());
  await duplicateFocusedWindow(fake.api, state);
  const [newId] = newWindowIds(fake, before);
  assert.ok(state.restoredWindowIds.has(newId), "the new window must be tagged");
});

test("duplicate does nothing when the focused window is incognito", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1, incognito: true }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://a.test/", active: true }],
  });
  const state = createState();
  const before = new Set(fake.windows.keys());
  const ok = await duplicateFocusedWindow(fake.api, state);
  assert.equal(ok, false);
  assert.deepEqual(newWindowIds(fake, before), [], "no window may be created");
});

test("duplicate does nothing when there is no window to copy", async () => {
  const fake = createFakeChrome();
  const state = createState();
  const ok = await duplicateFocusedWindow(fake.api, state);
  assert.equal(ok, false);
});

test("an all-unclonable source leaves the new window with its blank tab", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "chrome://settings/", active: true }],
  });
  const state = createState();
  const before = new Set(fake.windows.keys());
  const ok = await duplicateFocusedWindow(fake.api, state);
  assert.equal(ok, true);
  const [newId] = newWindowIds(fake, before);
  assert.equal(
    [...fake.tabs.values()].filter((t) => t.windowId === newId).length,
    1,
    "the new window must not vanish",
  );
});

// ---------------------------------------------------------------------------
// writeIntoNewWindow — the shared tagged new-window write (duplicate + tabset)
// ---------------------------------------------------------------------------

test("writeIntoNewWindow writes a stored plan into a fresh tagged window", async () => {
  const fake = createFakeChrome({ windows: [{ id: 1 }], tabs: [] });
  const state = createState();
  const before = new Set(fake.windows.keys());

  const plan = [
    { url: "https://a.test/", pinned: false, muted: false, active: false, groupKey: null },
    { url: "https://b.test/", pinned: false, muted: false, active: true, groupKey: null },
  ];
  const created = await writeIntoNewWindow(fake.api, state, () => ({ plan, groups: [] }));
  assert.equal(created, true);

  const [newId] = [...fake.windows.keys()].filter((id) => !before.has(id));
  const urls = [...fake.tabs.values()]
    .filter((t) => t.windowId === newId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.url);
  assert.deepEqual(urls, ["https://a.test/", "https://b.test/"]);
  assert.ok(state.restoredWindowIds.has(newId), "the new window must be tagged");
});

test("writeIntoNewWindow returns false when a window cannot be created", async () => {
  const fake = createFakeChrome();
  const state = createState();
  fake.api.windows.create = async () => {
    throw new Error("no window");
  };
  const created = await writeIntoNewWindow(fake.api, state, () => ({ plan: [], groups: [] }));
  assert.equal(created, false);
});

test("writeIntoNewWindow does not remove the placeholder when the window aborted mid-write", async () => {
  // Pins the abort check before the placeholder removal: if the target closes
  // during the write, tabs.remove must not be called into a dead window — the
  // tb-084 pattern.
  const fake = createFakeChrome({ windows: [{ id: 1 }], tabs: [] });
  const state = createState();
  const origCreate = fake.api.tabs.create;
  fake.api.tabs.create = async (args) => {
    const tab = await origCreate(args);
    // The target dies the instant its first tab lands.
    state.abortedWindowIds.add(args.windowId);
    return tab;
  };

  const plan = [
    { url: "https://a.test/", pinned: false, muted: false, active: false, groupKey: null },
    { url: "https://b.test/", pinned: false, muted: false, active: true, groupKey: null },
  ];
  await writeIntoNewWindow(fake.api, state, () => ({ plan, groups: [] }));

  assert.equal(
    fake.calls.some(([name]) => name === "tabs.remove"),
    false,
    "no tab may be removed once the window is known gone",
  );
});

test("writeIntoNewWindow writes nothing when buildPlan returns null", async () => {
  // buildPlan returning null means the read was abandoned (e.g. the target
  // aborted). The window is created but no tab is written and it returns true.
  const fake = createFakeChrome({ windows: [{ id: 1 }], tabs: [] });
  const state = createState();
  const created = await writeIntoNewWindow(fake.api, state, () => null);
  assert.equal(created, true);
  assert.equal(
    fake.calls.some(([name]) => name === "tabs.create"),
    false,
    "no tab may be created when there is no plan",
  );
});
