import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState, recordFocus } from "../src/state.js";
import {
  cloneIntoWindow,
  isBlankTab,
  isClonableUrl,
} from "../src/windowCloning.js";

test("isBlankTab recognises the blank URLs a new window can hold", () => {
  assert.equal(isBlankTab({ url: "" }), true);
  assert.equal(isBlankTab({ url: "about:blank" }), true);
  assert.equal(isBlankTab({ url: "chrome://newtab/" }), true);
  assert.equal(isBlankTab({ url: "chrome://new-tab-page/" }), true);
  assert.equal(isBlankTab({ url: "ego://newtab/" }), true);
  assert.equal(isBlankTab({ url: undefined, pendingUrl: "about:blank" }), true);
  assert.equal(isBlankTab({ url: "https://example.com/" }), false);
});

/**
 * Window 1 is the source with two real tabs. Window 2 is the brand new window
 * holding a single blank tab. Focus history says the user came from window 1.
 */
function setupClonable(overrides = {}) {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2, ...(overrides.newWindow ?? {}) }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  return { fake, state };
}

test("a fresh empty window clones the window the user came from", async () => {
  const { fake, state } = setupClonable();
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, true);
});

test("an incognito new window is never cloned into", async () => {
  const { fake, state } = setupClonable({ newWindow: { incognito: true } });
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a popup new window is never cloned into", async () => {
  const { fake, state } = setupClonable({ newWindow: { type: "popup" } });
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window holding a real page is not cloned into", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 20, windowId: 2, index: 0, url: "https://dragged.test/" },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window holding several tabs is not cloned into", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 20, windowId: 2, index: 0, url: "about:blank" },
      { id: 21, windowId: 2, index: 1, url: "about:blank" },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window with no known source is not cloned into", async () => {
  const { fake, state } = setupClonable();
  state.previousWindowId = null;
  state.currentWindowId = null;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a source window that has closed is not cloned from", async () => {
  const { fake, state } = setupClonable();
  fake.windows.delete(1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("an incognito source window is not cloned from", async () => {
  const { fake, state } = setupClonable();
  fake.windows.get(1).incognito = true;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a popup source window is not cloned from", async () => {
  const { fake, state } = setupClonable();
  fake.windows.get(1).type = "popup";
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window that is itself being cloned into is never a clone source", async () => {
  const { fake, state } = setupClonable();
  // Window 1 is mid-clone: its tabs are not meaningful yet.
  state.suppressedWindowIds.add(1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
  assert.equal(
    fake.calls.some(([name]) => name === "tabs.create"),
    false,
  );
  // The source's own suppression must survive untouched.
  assert.equal(state.suppressedWindowIds.has(1), true);
});

test("the source is current when focus fired before creation", async () => {
  const { fake, state } = setupClonable();
  recordFocus(state, 2);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, true);
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "windows.get"),
    [["windows.get", 1]],
  );
});

test("the source is never the new window itself", async () => {
  const { fake, state } = setupClonable();
  state.previousWindowId = null;
  state.currentWindowId = 2;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("the suppression flag is cleared after a successful clone", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(state.suppressedWindowIds.has(2), false);
});

test("the suppression flag is cleared even when the clone throws", async () => {
  const { fake, state } = setupClonable();
  fake.api.tabs.create = async () => {
    throw new Error("boom");
  };
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(state.suppressedWindowIds.has(2), false);
  // A swallowed failure is not a clone that ran.
  assert.equal(cloned, false);
});

test("a window closing mid-clone is a silent race, not a logged failure", async () => {
  const { fake, state } = setupClonable();
  fake.api.tabs.create = async () => {
    fake.windows.delete(2);
    throw new Error("window closed");
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let cloned;
  try {
    cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
  assert.equal(state.suppressedWindowIds.has(2), false);
  assert.equal(cloned, false);
});

test("isClonableUrl rejects URLs an extension may not reopen", () => {
  assert.equal(isClonableUrl("https://example.com/"), true);
  assert.equal(isClonableUrl("http://example.com/"), true);
  assert.equal(isClonableUrl("chrome://settings/"), false);
  assert.equal(isClonableUrl("chrome-untrusted://foo/"), false);
  assert.equal(isClonableUrl("devtools://devtools/"), false);
  assert.equal(isClonableUrl("file:///Users/me/notes.txt"), false);
  assert.equal(isClonableUrl("view-source:https://example.com/"), false);
  assert.equal(isClonableUrl("edge://settings/"), false);
  // about:blank is the one about: URL an extension may reopen.
  assert.equal(isClonableUrl("about:blank"), true);
  assert.equal(isClonableUrl("about:version"), false);
  assert.equal(isClonableUrl("about:srcdoc"), false);
  assert.equal(isClonableUrl("ego://newtab/"), false);
  assert.equal(isClonableUrl(""), false);
  assert.equal(isClonableUrl(undefined), false);
});

function clonedTabs(fake, windowId) {
  return [...fake.tabs.values()]
    .filter((tab) => tab.windowId === windowId)
    .sort((a, b) => a.index - b.index);
}

test("tabs are recreated in source order", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.deepEqual(
    clonedTabs(fake, 2).map((tab) => tab.url),
    ["https://a.test/", "https://b.test/"],
  );
});

test("the blank placeholder tab is removed", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(fake.tabs.has(20), false);
});

test("pinned state is reproduced", async () => {
  const { fake, state } = setupClonable();
  fake.tabs.get(10).pinned = true;
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.deepEqual(
    clonedTabs(fake, 2).map((tab) => tab.pinned),
    [true, false],
  );
});

test("muted state is reproduced", async () => {
  const { fake, state } = setupClonable();
  fake.tabs.get(10).mutedInfo = { muted: true };
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.deepEqual(
    clonedTabs(fake, 2).map((tab) => tab.mutedInfo.muted),
    [true, false],
  );
});

test("the same tab ends up active", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  const active = clonedTabs(fake, 2).filter((tab) => tab.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].url, "https://b.test/");
});

test("background tabs are unloaded but the active one is not", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  const byUrl = Object.fromEntries(
    clonedTabs(fake, 2).map((tab) => [tab.url, tab.discarded]),
  );
  assert.equal(byUrl["https://a.test/"], true);
  assert.equal(byUrl["https://b.test/"], false);
});

test("unclonable tabs are skipped and the rest still clone", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "chrome://settings/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.deepEqual(
    clonedTabs(fake, 2).map((tab) => tab.url),
    ["https://b.test/"],
  );
});

test("skipped tabs are routine news, not a warning", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "chrome://settings/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /^\[Tab Boss\] skipped 1 tab/);
});

test("a still-loading source tab is cloned from its pending URL", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      {
        id: 10,
        windowId: 1,
        index: 0,
        url: "",
        pendingUrl: "https://loading.test/",
      },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.deepEqual(
    clonedTabs(fake, 2).map((tab) => tab.url),
    ["https://loading.test/", "https://b.test/"],
  );
});

test("a source with nothing clonable leaves the new window alive and non-empty", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "chrome://newtab/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  // Removing the last tab would close the window in a real browser.
  assert.equal(fake.tabs.has(20), true);
  assert.equal(fake.windows.has(2), true);
  assert.equal(clonedTabs(fake, 2).length, 1);
});

test("the clone source is resolved before the first await", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://right.test/" },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
      { id: 30, windowId: 3, index: 0, url: "https://wrong.test/" },
    ],
  });
  const state = createState();
  recordFocus(state, 1);

  // A second Cmd+N focuses window 3 while this clone is still in its gate.
  const query = fake.api.tabs.query;
  let interrupted = false;
  fake.api.tabs.query = async (args) => {
    const result = await query(args);
    if (!interrupted) {
      interrupted = true;
      recordFocus(state, 3);
    }
    return result;
  };

  await cloneIntoWindow(fake.api, state, fake.windows.get(2));

  assert.deepEqual(
    clonedTabs(fake, 2).map((tab) => tab.url),
    ["https://right.test/"],
  );
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "windows.get"),
    [["windows.get", 1]],
  );
});

test("a refused discard does not stop the clone", async () => {
  const { fake, state } = setupClonable();
  fake.api.tabs.discard = async () => {
    throw new Error("cannot discard");
  };
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(clonedTabs(fake, 2).length, 2);
  assert.equal(fake.tabs.has(20), false);
});

/** Window 1 holds two grouped tabs plus one loose tab. */
function setupGrouped(groupOverrides = {}) {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    groups: [
      {
        id: 77,
        windowId: 1,
        title: "Research",
        color: "blue",
        ...groupOverrides,
      },
    ],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/", groupId: 77 },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", groupId: 77 },
      { id: 12, windowId: 1, index: 2, url: "https://c.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  return { fake, state };
}

test("grouped tabs land in one new group in the new window", async () => {
  const { fake, state } = setupGrouped();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  const cloned = clonedTabs(fake, 2);
  const groupIds = cloned.map((tab) => tab.groupId);
  assert.equal(groupIds[0], groupIds[1]);
  assert.notEqual(groupIds[0], -1);
  assert.equal(groupIds[2], -1);
});

test("the new group keeps the source title and colour", async () => {
  const { fake, state } = setupGrouped();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  const newGroupId = clonedTabs(fake, 2)[0].groupId;
  const group = fake.groups.get(newGroupId);
  assert.equal(group.title, "Research");
  assert.equal(group.color, "blue");
  assert.equal(group.windowId, 2);
});

test("a collapsed source group is recreated collapsed", async () => {
  const { fake, state } = setupGrouped({ collapsed: true });
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  const newGroupId = clonedTabs(fake, 2)[0].groupId;
  assert.equal(fake.groups.get(newGroupId).collapsed, true);
});

test("collapse is applied after activation so the browser can refuse it", async () => {
  const { fake, state } = setupGrouped({ collapsed: true });
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  const names = fake.calls.map(([name, ...args]) =>
    name === "tabs.update" && args[1]?.active ? "activate" : name,
  );
  const collapseIndex = fake.calls.findIndex(
    ([name, , props]) => name === "tabGroups.update" && props?.collapsed,
  );
  assert.ok(collapseIndex > names.indexOf("activate"));
});

test("a group that disappears mid-clone does not stop the clone", async () => {
  const { fake, state } = setupGrouped();
  fake.groups.delete(77);
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(clonedTabs(fake, 2).length, 3);
  assert.equal(fake.tabs.has(20), false);
});

test("ungrouped tabs never trigger a group call", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.group"),
    [],
  );
});
