import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState, recordFocus } from "../src/state.js";
import {
  cloneIntoWindow,
  installWindowCloning,
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
 * Every windows.get except the target window's own liveness probe. The probe
 * is bookkeeping about the window being filled; these tests are about which
 * window was chosen as the clone source.
 */
function sourceLookups(fake, targetId) {
  return fake.calls.filter(
    ([name, windowId]) => name === "windows.get" && windowId !== targetId,
  );
}

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
  // Window 2's own liveness probe is not a source lookup, so it is filtered
  // out. What matters is that window 1, and only window 1, was looked up as a
  // clone source.
  assert.deepEqual(sourceLookups(fake, 2), [["windows.get", 1]]);
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
  // Window 3 must never be looked up as a source, whatever focus did mid-gate.
  assert.deepEqual(sourceLookups(fake, 2), [["windows.get", 1]]);
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

// --- The user closes the new window mid-clone -------------------------------
//
// Every call issued into a destroyed window is another chance to trip a
// browser-side CHECK, which aborts the whole browser process. These tests
// assert on the call log, because "nothing threw" is not the property we need:
// the property we need is that we stop calling.

/**
 * Closes a window the way the browser does: the window is gone, and
 * windows.onRemoved fires for it.
 */
async function closeWindow(fake, windowId) {
  fake.windows.delete(windowId);
  await fake.api.windows.onRemoved.emit(windowId);
}

/** A source window holding three real tabs, the last one active. */
function setupThreeTabSource() {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/" },
      { id: 12, windowId: 1, index: 2, url: "https://c.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  installWindowCloning(fake.api, state);
  return { fake, state };
}

/** Names of every call recorded after `cut`. */
function callsAfter(fake, cut) {
  return fake.calls.slice(cut);
}

test("a window removed during the create loop stops further creates", async () => {
  const { fake, state } = setupThreeTabSource();
  let cut = null;
  const create = fake.api.tabs.create;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    if (cut === null) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return tab;
  };

  const cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.create").length,
    1,
    "the create loop must stop at the removal, not run to completion",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
  assert.equal(cloned, false);
});

test("a window removed before the group phase is never grouped into", async () => {
  const { fake, state } = setupGrouped();
  installWindowCloning(fake.api, state);
  let cut = null;
  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    if (createCount === 3) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return tab;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.group"),
    [],
    "tabs.group into a destroyed window is the most likely CHECK trigger",
  );
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabGroups.get"),
    [],
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed inside the group loop stops the remaining groups", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    groups: [
      { id: 77, windowId: 1, title: "One", color: "blue" },
      { id: 78, windowId: 1, title: "Two", color: "red" },
    ],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/", groupId: 77 },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", groupId: 78 },
      { id: 12, windowId: 1, index: 2, url: "https://c.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  installWindowCloning(fake.api, state);

  let cut = null;
  const group = fake.api.tabs.group;
  fake.api.tabs.group = async (args) => {
    const id = await group(args);
    if (cut === null) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return id;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.group").length,
    1,
    "the second group must not be created in a window that is gone",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed during activation stops collapse and discard", async () => {
  const { fake, state } = setupGrouped({ collapsed: true });
  installWindowCloning(fake.api, state);
  let cut = null;
  const update = fake.api.tabs.update;
  fake.api.tabs.update = async (tabId, props) => {
    const tab = await update(tabId, props);
    if (props.active && cut === null) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return tab;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name, , props]) => name === "tabGroups.update" && props?.collapsed),
    [],
  );
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.discard"),
    [],
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed during the discard loop stops further discards", async () => {
  const { fake, state } = setupThreeTabSource();
  let cut = null;
  const discard = fake.api.tabs.discard;
  fake.api.tabs.discard = async (tabId) => {
    await discard(tabId);
    if (cut === null) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.discard").length,
    1,
    "two tabs would be discarded normally; the removal must stop the second",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("the placeholder is not removed when the window is gone", async () => {
  const { fake, state } = setupThreeTabSource();
  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    if (createCount === 1) await closeWindow(fake, 2);
    return tab;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.remove"),
    [],
    "the placeholder belongs to a window that no longer exists",
  );
});

test("an aborted clone logs nothing at all", async () => {
  // The source holds an unclonable tab, so a clone that ran to completion
  // would print the routine "skipped 1 tab" line. A user closing a window is
  // not news of any kind, so an aborted clone must not print even that.
  //
  // The removal lands on the LAST create, so the create loop exits normally
  // and control reaches the skipped-tab log rather than returning before it.
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "chrome://settings/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/" },
      { id: 12, windowId: 1, index: 2, url: "https://c.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  installWindowCloning(fake.api, state);

  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    if (createCount === 2) await closeWindow(fake, 2);
    return tab;
  };

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
  assert.deepEqual(logs, []);
});

test("suppression and the abort record are both cleared after an abort", async () => {
  const { fake, state } = setupThreeTabSource();
  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    if (createCount === 1) await closeWindow(fake, 2);
    return tab;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.equal(state.suppressedWindowIds.has(2), false);
  assert.equal(state.abortedWindowIds.size, 0);
});

test("closing a window no clone is filling records nothing", async () => {
  const { fake, state } = setupThreeTabSource();
  await closeWindow(fake, 1);
  await fake.api.windows.onRemoved.emit(999);
  // Recording every closed window id would grow without bound for the life of
  // the service worker.
  assert.equal(state.abortedWindowIds.size, 0);
});

// --- The close lands during the gate, before the clone starts ---------------
//
// The gate awaits twice before the first tab is created, and a reflexive close
// lands right there. windows.onRemoved only records an id that is already an
// in-flight target, so the watch has to be armed before the first await or the
// event is dropped and every later guard reads false.

/** Destroys a window without the removal event ever reaching us. */
function destroyWindowSilently(fake, windowId) {
  fake.windows.delete(windowId);
}

/**
 * The removal event reaches us before the window object is reaped. Browser
 * process teardown is not atomic with event dispatch, so a window can still
 * answer a query for a moment after it has been announced as closed.
 */
async function announceCloseOnly(fake, windowId) {
  await fake.api.windows.onRemoved.emit(windowId);
}

test("a window removed during the gate is still caught", async () => {
  const { fake, state } = setupThreeTabSource();
  let cut = null;
  const get = fake.api.windows.get;
  fake.api.windows.get = async (windowId) => {
    const win = await get(windowId);
    // The source lookup is the gate's second await, the last chance to close
    // the window before the clone starts creating tabs.
    if (windowId === 1 && cut === null) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return win;
  };

  const cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.create"),
    [],
    "the watch must be armed before the gate's awaits, or it drops this close",
  );
  // Only the liveness probe, and then nothing.
  assert.deepEqual(callsAfter(fake, cut), [["windows.get", 2]]);
  assert.equal(cloned, false);
  assert.equal(state.abortedWindowIds.size, 0);
});

test("a removal announced during the gate is recorded even if the window still answers", async () => {
  // The two detectors cover different things. The probe is a point-in-time
  // read; arming the watch before the gate's first await gives continuous
  // cover from there on. This ordering is where they diverge: the event
  // arrives, but the window is still momentarily queryable, so the probe says
  // "alive". Only the armed watch catches it.
  const { fake, state } = setupThreeTabSource();
  let cut = null;
  const get = fake.api.windows.get;
  fake.api.windows.get = async (windowId) => {
    const win = await get(windowId);
    if (windowId === 1 && cut === null) {
      await announceCloseOnly(fake, 2);
      cut = fake.calls.length;
    }
    return win;
  };

  const cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.create"),
    [],
    "the watch must be armed before the gate's awaits",
  );
  assert.deepEqual(callsAfter(fake, cut), [["windows.get", 2]]);
  assert.equal(cloned, false);
  assert.equal(state.abortedWindowIds.size, 0);
});

test("a close the watch never saw is caught by the probe", async () => {
  const { fake, state } = setupThreeTabSource();
  let cut = null;
  const get = fake.api.windows.get;
  fake.api.windows.get = async (windowId) => {
    const win = await get(windowId);
    if (windowId === 1 && cut === null) {
      // No onRemoved: the event is late, or never arrives at all.
      destroyWindowSilently(fake, 2);
      cut = fake.calls.length;
    }
    return win;
  };

  const cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.create"),
    [],
    "one read-only probe before the first mutating call is the belt to the braces",
  );
  assert.deepEqual(callsAfter(fake, cut), [["windows.get", 2]]);
  assert.equal(cloned, false);
});

test("a window closed before the gate can even query it is a silent no-op", async () => {
  // Cmd+N, then Cmd+W before the service worker is scheduled to run at all.
  // The very first call of the gate rejects, and that rejection used to escape
  // cloneIntoWindow into the bare listener as an unhandled rejection.
  const { fake, state } = setupThreeTabSource();
  const query = fake.api.tabs.query;
  fake.api.tabs.query = async ({ windowId }) => {
    if (windowId === 2) {
      destroyWindowSilently(fake, 2);
      throw new Error("No window with id 2");
    }
    return query({ windowId });
  };

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  let cloned;
  try {
    // Must resolve, not reject.
    cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(cloned, false);
  assert.deepEqual(warnings, []);
  assert.deepEqual(logs, []);
  assert.equal(state.suppressedWindowIds.has(2), false);
  assert.equal(state.abortedWindowIds.size, 0);
});

test("a gate query that fails after the removal was announced is silent", async () => {
  // The tab strip is already gone, so the query rejects, but the window object
  // still answers for a moment — so the probe would say "alive" and call a
  // routine Cmd+W a failure. The watch already knows better.
  const { fake, state } = setupThreeTabSource();
  const query = fake.api.tabs.query;
  fake.api.tabs.query = async ({ windowId }) => {
    if (windowId === 2) {
      await announceCloseOnly(fake, 2);
      throw new Error("No tab strip for window 2");
    }
    return query({ windowId });
  };

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  let cloned;
  try {
    cloned = await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(cloned, false);
  assert.deepEqual(warnings, []);
  assert.deepEqual(logs, []);
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "windows.get"),
    [],
    "nothing to ask the browser when the watch already knows",
  );
});

test("a gate query that fails with the window still open is a real failure", async () => {
  const { fake, state } = setupThreeTabSource();
  const query = fake.api.tabs.query;
  fake.api.tabs.query = async ({ windowId }) => {
    // The window is fine, so whatever went wrong here is worth finding.
    if (windowId === 2) throw new Error("something unexpected");
    return query({ windowId });
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

  assert.equal(cloned, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /^\[Tab Boss\] clone failed/);
});

// --- A rejection can prove the window is gone before the event says so ------

/** Window 1 holds two separate tab groups plus a loose active tab. */
function setupTwoGroups() {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    groups: [
      { id: 77, windowId: 1, title: "One", color: "blue" },
      { id: 78, windowId: 1, title: "Two", color: "red" },
    ],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/", groupId: 77 },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", groupId: 78 },
      { id: 12, windowId: 1, index: 2, url: "https://c.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  installWindowCloning(fake.api, state);
  return { fake, state };
}

test("a group failure that proves the window is gone aborts the whole clone", async () => {
  const { fake, state } = setupTwoGroups();
  let cut = null;
  const group = fake.api.tabs.group;
  fake.api.tabs.group = async (args) => {
    const id = await group(args);
    if (cut === null) {
      // The rejection beats windows.onRemoved to us. The per-group catch must
      // not simply fall through to the next group: that dispatches another
      // tabs.group into a tab strip we have already watched die.
      destroyWindowSilently(fake, 2);
      cut = fake.calls.length;
      throw new Error("window closed");
    }
    return id;
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.group").length,
    1,
    "the second group must not be created in a window already known to be gone",
  );
  // The probe that proved it, and nothing else: the mark stops every later
  // phase too.
  assert.deepEqual(callsAfter(fake, cut), [["windows.get", 2]]);
  assert.deepEqual(warnings, [], "a closed window is a race, not a failure");
});

test("a group failure after the removal event does not probe again", async () => {
  const { fake, state } = setupTwoGroups();
  let cut = null;
  const group = fake.api.tabs.group;
  fake.api.tabs.group = async (args) => {
    const id = await group(args);
    if (cut === null) {
      // This time the event wins the race, so the window's death is already
      // known and there is nothing left to ask the browser.
      await closeWindow(fake, 2);
      cut = fake.calls.length;
      throw new Error("window closed");
    }
    return id;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a group that cannot be recreated warns once per clone, not once per group", async () => {
  const { fake, state } = setupTwoGroups();
  // Both source groups vanish, so both lookups fail while the target lives on.
  fake.groups.delete(77);
  fake.groups.delete(78);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /^\[Tab Boss\] could not recreate/);
  // A warning is not an abort: the rest of the clone still runs.
  assert.equal(clonedTabs(fake, 2).length, 3);
  assert.equal(fake.tabs.has(20), false);
});

// --- Guards that nothing else pins ------------------------------------------

test("a window removed during the group lookup is never grouped into", async () => {
  const { fake, state } = setupGrouped();
  installWindowCloning(fake.api, state);
  let cut = null;
  const get = fake.api.tabGroups.get;
  fake.api.tabGroups.get = async (groupId) => {
    const sourceGroup = await get(groupId);
    if (cut === null) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return sourceGroup;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.group"),
    [],
    "tabs.group into a destroyed tab strip is the prime CHECK suspect",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed before the mute loop is never muted", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      {
        id: 10,
        windowId: 1,
        index: 0,
        url: "https://a.test/",
        mutedInfo: { muted: true },
      },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  installWindowCloning(fake.api, state);

  let cut = null;
  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    // The last create, so the loop exits normally and control reaches the
    // mute loop rather than returning from the create loop's own guard.
    if (createCount === 2) {
      await closeWindow(fake, 2);
      cut = fake.calls.length;
    }
    return tab;
  };

  await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });

  assert.deepEqual(
    fake.calls.filter(([name, , props]) => name === "tabs.update" && props?.muted),
    [],
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});
