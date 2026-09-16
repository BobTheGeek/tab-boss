import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createAbortWatch, createState } from "../src/state.js";
import { isClonableUrl, writeTabs } from "../src/tabWriter.js";

/** The window every test in this file writes into. */
const TARGET_ID = 2;

/**
 * A target window with an empty tab strip, plus the watch that reports whether
 * it has gone. The writer never reads the source of a plan, so no source window
 * is needed here at all.
 */
function setupTarget() {
  const fake = createFakeChrome({ windows: [{ id: TARGET_ID }] });
  const state = createState();
  return { fake, state, watch: createAbortWatch(state, TARGET_ID) };
}

/** A plan of plain clonable tabs, the first of them active. */
function planOf(...urls) {
  return urls.map((url, index) => ({
    url,
    pinned: false,
    muted: false,
    active: index === 0,
    groupKey: null,
  }));
}

function write(fake, watch, plan, groups = []) {
  return writeTabs(fake.api, watch, TARGET_ID, plan, groups);
}

/** Every tab the writer put into the target window, in tab strip order. */
function writtenTabs(fake) {
  return [...fake.tabs.values()]
    .filter((tab) => tab.windowId === TARGET_ID)
    .sort((a, b) => a.index - b.index);
}

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

test("tabs are written in plan order", async () => {
  const { fake, watch } = setupTarget();
  await write(fake, watch, planOf("https://a.test/", "https://b.test/"));
  assert.deepEqual(
    writtenTabs(fake).map((tab) => tab.url),
    ["https://a.test/", "https://b.test/"],
  );
});

test("pinned state is reproduced", async () => {
  const { fake, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/");
  plan[0].pinned = true;
  await write(fake, watch, plan);
  assert.deepEqual(
    writtenTabs(fake).map((tab) => tab.pinned),
    [true, false],
  );
});

test("muted state is reproduced", async () => {
  const { fake, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/");
  plan[0].muted = true;
  await write(fake, watch, plan);
  assert.deepEqual(
    writtenTabs(fake).map((tab) => tab.mutedInfo.muted),
    [true, false],
  );
});

test("the tab the plan marks active ends up active", async () => {
  const { fake, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/");
  plan[0].active = false;
  plan[1].active = true;
  await write(fake, watch, plan);
  const active = writtenTabs(fake).filter((tab) => tab.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].url, "https://b.test/");
});

test("background tabs are unloaded but the active one is not", async () => {
  const { fake, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/");
  plan[0].active = false;
  plan[1].active = true;
  await write(fake, watch, plan);
  const byUrl = Object.fromEntries(
    writtenTabs(fake).map((tab) => [tab.url, tab.discarded]),
  );
  assert.equal(byUrl["https://a.test/"], true);
  assert.equal(byUrl["https://b.test/"], false);
});

test("unclonable tabs are skipped and the rest still write", async () => {
  const { fake, watch } = setupTarget();
  const plan = planOf("chrome://settings/", "https://b.test/");
  plan[0].active = false;
  plan[1].active = true;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  let written;
  try {
    written = await write(fake, watch, plan);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(
    writtenTabs(fake).map((tab) => tab.url),
    ["https://b.test/"],
  );
  assert.equal(written.length, 1);
});

test("skipped tabs are routine news, not a warning", async () => {
  const { fake, watch } = setupTarget();
  const plan = planOf("chrome://settings/", "https://b.test/");
  plan[0].active = false;
  plan[1].active = true;

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    await write(fake, watch, plan);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /^\[Tab Boss\] skipped 1 tab/);
});

test("a refused discard does not stop the write", async () => {
  const { fake, watch } = setupTarget();
  fake.api.tabs.discard = async () => {
    throw new Error("cannot discard");
  };
  const written = await write(
    fake,
    watch,
    planOf("https://a.test/", "https://b.test/"),
  );
  assert.equal(written.length, 2);
  assert.equal(writtenTabs(fake).length, 2);
});

/**
 * Two grouped tabs and one loose active tab, exactly the shape the cloner's
 * plan builder produces for a source window holding one group.
 */
function groupedPlan(groupOverrides = {}) {
  const plan = planOf("https://a.test/", "https://b.test/", "https://c.test/");
  plan[0].active = false;
  plan[0].groupKey = 0;
  plan[1].groupKey = 0;
  plan[2].active = true;
  const groups = [
    { key: 0, title: "Research", color: "blue", collapsed: false, ...groupOverrides },
  ];
  return { plan, groups };
}

test("grouped tabs land in one new group in the target window", async () => {
  const { fake, watch } = setupTarget();
  const { plan, groups } = groupedPlan();
  await write(fake, watch, plan, groups);
  const groupIds = writtenTabs(fake).map((tab) => tab.groupId);
  assert.equal(groupIds[0], groupIds[1]);
  assert.notEqual(groupIds[0], -1);
  assert.equal(groupIds[2], -1);
});

test("the new group keeps the planned title and colour", async () => {
  const { fake, watch } = setupTarget();
  const { plan, groups } = groupedPlan();
  await write(fake, watch, plan, groups);
  const newGroupId = writtenTabs(fake)[0].groupId;
  const group = fake.groups.get(newGroupId);
  assert.equal(group.title, "Research");
  assert.equal(group.color, "blue");
  assert.equal(group.windowId, TARGET_ID);
});

test("a collapsed group is recreated collapsed", async () => {
  const { fake, watch } = setupTarget();
  const { plan, groups } = groupedPlan({ collapsed: true });
  await write(fake, watch, plan, groups);
  const newGroupId = writtenTabs(fake)[0].groupId;
  assert.equal(fake.groups.get(newGroupId).collapsed, true);
});

test("collapse is applied after activation so the browser can refuse it", async () => {
  const { fake, watch } = setupTarget();
  const { plan, groups } = groupedPlan({ collapsed: true });
  await write(fake, watch, plan, groups);
  const names = fake.calls.map(([name, ...args]) =>
    name === "tabs.update" && args[1]?.active ? "activate" : name,
  );
  const collapseIndex = fake.calls.findIndex(
    ([name, , props]) => name === "tabGroups.update" && props?.collapsed,
  );
  assert.ok(collapseIndex > names.indexOf("activate"));
});

test("ungrouped tabs never trigger a group call", async () => {
  const { fake, watch } = setupTarget();
  await write(fake, watch, planOf("https://a.test/", "https://b.test/"));
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.group"),
    [],
  );
});

test("a group with no written tabs is never created", async () => {
  // Every tab of the group was unclonable, so the group has nothing to hold.
  const { fake, watch } = setupTarget();
  const plan = planOf("chrome://settings/", "https://b.test/");
  plan[0].active = false;
  plan[0].groupKey = 0;
  plan[1].active = true;

  const originalLog = console.log;
  console.log = () => {};
  try {
    await write(fake, watch, plan, [
      { key: 0, title: "Gone", color: "blue", collapsed: false },
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.group"),
    [],
  );
});

// --- The user closes the target window mid-write ----------------------------
//
// Every call issued into a destroyed window is another chance to trip a
// browser-side CHECK, which aborts the whole browser process. These tests
// assert on the call log, because "nothing threw" is not the property we need:
// the property we need is that we stop calling.

/**
 * Closes the target the way the browser does: the window object goes, and the
 * windows.onRemoved listener records the id — which is all the watch reads.
 */
function closeTarget(fake, state) {
  fake.windows.delete(TARGET_ID);
  state.abortedWindowIds.add(TARGET_ID);
}

/** Names of every call recorded after `cut`. */
function callsAfter(fake, cut) {
  return fake.calls.slice(cut);
}

test("a window removed during the create loop stops further creates", async () => {
  const { fake, state, watch } = setupTarget();
  let cut = null;
  const create = fake.api.tabs.create;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    if (cut === null) {
      closeTarget(fake, state);
      cut = fake.calls.length;
    }
    return tab;
  };

  await write(
    fake,
    watch,
    planOf("https://a.test/", "https://b.test/", "https://c.test/"),
  );

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.create").length,
    1,
    "the create loop must stop at the removal, not run to completion",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed before the mute loop is never muted", async () => {
  const { fake, state, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/");
  plan[0].muted = true;

  let cut = null;
  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    // The last create, so the loop exits normally and control reaches the
    // mute loop rather than returning from the create loop's own guard.
    if (createCount === 2) {
      closeTarget(fake, state);
      cut = fake.calls.length;
    }
    return tab;
  };

  await write(fake, watch, plan);

  assert.deepEqual(
    fake.calls.filter(([name, , props]) => name === "tabs.update" && props?.muted),
    [],
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed before the group phase is never grouped into", async () => {
  const { fake, state, watch } = setupTarget();
  const { plan, groups } = groupedPlan();

  let cut = null;
  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    // The last create, so the create loop exits normally and control reaches
    // the group phase rather than returning from the create loop's own guard.
    if (createCount === 3) {
      closeTarget(fake, state);
      cut = fake.calls.length;
    }
    return tab;
  };

  await write(fake, watch, plan, groups);

  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.group"),
    [],
    "tabs.group into a destroyed window is the most likely CHECK trigger",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed inside the group loop stops the remaining groups", async () => {
  const { fake, state, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/", "https://c.test/");
  plan[0].active = false;
  plan[0].groupKey = 0;
  plan[1].groupKey = 1;
  plan[2].active = true;
  const groups = [
    { key: 0, title: "One", color: "blue", collapsed: false },
    { key: 1, title: "Two", color: "red", collapsed: false },
  ];

  let cut = null;
  const group = fake.api.tabs.group;
  fake.api.tabs.group = async (args) => {
    const id = await group(args);
    if (cut === null) {
      closeTarget(fake, state);
      cut = fake.calls.length;
    }
    return id;
  };

  await write(fake, watch, plan, groups);

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.group").length,
    1,
    "the second group must not be created in a window that is gone",
  );
  // The first group's title and colour are never applied either: the check
  // between tabs.group and tabGroups.update is its own guard.
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("a window removed during activation stops collapse and discard", async () => {
  const { fake, state, watch } = setupTarget();
  const { plan, groups } = groupedPlan({ collapsed: true });

  let cut = null;
  const update = fake.api.tabs.update;
  fake.api.tabs.update = async (tabId, props) => {
    const tab = await update(tabId, props);
    if (props.active && cut === null) {
      closeTarget(fake, state);
      cut = fake.calls.length;
    }
    return tab;
  };

  await write(fake, watch, plan, groups);

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
  const { fake, state, watch } = setupTarget();
  const plan = planOf("https://a.test/", "https://b.test/", "https://c.test/");
  plan[0].active = false;
  plan[2].active = true;

  let cut = null;
  const discard = fake.api.tabs.discard;
  fake.api.tabs.discard = async (tabId) => {
    await discard(tabId);
    if (cut === null) {
      closeTarget(fake, state);
      cut = fake.calls.length;
    }
  };

  await write(fake, watch, plan);

  assert.equal(
    fake.calls.filter(([name]) => name === "tabs.discard").length,
    1,
    "two tabs would be discarded normally; the removal must stop the second",
  );
  assert.deepEqual(callsAfter(fake, cut), []);
});

test("an aborted write logs nothing at all", async () => {
  // The plan holds an unclonable tab, so a write that ran to completion would
  // print the routine "skipped 1 tab" line. A user closing a window is not news
  // of any kind, so an aborted write must not print even that.
  //
  // The removal lands on the LAST create, so the create loop exits normally and
  // control reaches the skipped-tab log rather than returning before it.
  const { fake, state, watch } = setupTarget();
  const plan = planOf("chrome://settings/", "https://b.test/", "https://c.test/");
  plan[0].active = false;
  plan[2].active = true;

  const create = fake.api.tabs.create;
  let createCount = 0;
  fake.api.tabs.create = async (args) => {
    const tab = await create(args);
    createCount += 1;
    if (createCount === 2) closeTarget(fake, state);
    return tab;
  };

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    await write(fake, watch, plan);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
  assert.deepEqual(logs, []);
});
