import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { appendSnapshot } from "../src/snapshotStore.js";
import { SNAPSHOT_VERSION } from "../src/snapshot.js";
import { installWindowCloning } from "../src/windowCloning.js";
import { installRestore, restoreNewest } from "../src/restore.js";

function snapshot(windows) {
  return { version: SNAPSHOT_VERSION, takenAt: 1, windows };
}

function tabSpec(url, overrides = {}) {
  return { url, title: url, pinned: false, muted: false, active: false, groupKey: null, ...overrides };
}

const TWO_TABS = snapshot([
  {
    focused: true,
    groups: [],
    tabs: [tabSpec("https://a.test/"), tabSpec("https://b.test/", { active: true })],
  },
]);

function tabsOf(fake, windowId) {
  return [...fake.tabs.values()]
    .filter((tab) => tab.windowId === windowId)
    .sort((a, b) => a.index - b.index);
}

function createdWindowIds(fake) {
  return [...fake.windows.keys()].filter((id) => id >= 50);
}

/**
 * Captures what a restore said, so tests can assert on silence as well as on
 * content. Matches the convention in tabWriter.test.js.
 */
async function recording(run) {
  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    return { logs, warnings, value: await run() };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

/** Runs a restore whose logging is expected and asserted elsewhere. */
async function silently(run) {
  return (await recording(run)).value;
}

/**
 * Closes a window the way Chromium does — its tabs go with it — and delivers
 * windows.onRemoved.
 *
 * installWindowCloning supplies the only listener that records a close into
 * state.abortedWindowIds, which is why the tests below install the cloner.
 * Without it the abort watch restore builds can never fire, and every guard
 * that depends on it reads false forever.
 */
async function closeWindow(fake, windowId) {
  for (const [id, tab] of [...fake.tabs]) {
    if (tab.windowId === windowId) fake.tabs.delete(id);
  }
  fake.windows.delete(windowId);
  await fake.api.windows.onRemoved.emit(windowId);
}

/**
 * Arranges for the user to close the first restored window the instant its
 * first tab appears, mid-write. Returns a reader for how many calls the fake
 * had logged at that moment, so a test can assert on everything that followed.
 */
function closeFirstWindowMidWrite(fake, state) {
  installWindowCloning(fake.api, state);
  const create = fake.api.tabs.create;
  let callsAtClose = null;
  fake.api.tabs.create = async (props) => {
    const tab = await create(props);
    if (callsAtClose === null) {
      await closeWindow(fake, props.windowId);
      callsAtClose = fake.calls.length;
    }
    return tab;
  };
  return () => callsAtClose;
}

test("restoring creates a window with the snapshot's tabs in order", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  assert.equal(await restoreNewest(fake.api, state), 1);
  const [windowId] = createdWindowIds(fake);
  assert.deepEqual(
    tabsOf(fake, windowId).map((tab) => tab.url),
    ["https://a.test/", "https://b.test/"],
  );
});

test("pinned, muted, and the active tab are reproduced", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [],
        tabs: [
          tabSpec("https://a.test/", { pinned: true, muted: true }),
          tabSpec("https://b.test/", { active: true }),
        ],
      },
    ]),
  );
  await restoreNewest(fake.api, state);
  const [windowId] = createdWindowIds(fake);
  const restored = tabsOf(fake, windowId);
  assert.equal(restored[0].pinned, true);
  assert.equal(restored[0].mutedInfo.muted, true);
  assert.equal(restored[1].active, true);
});

test("groups are recreated with title, colour, and collapsed state", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [{ key: 0, title: "Research", color: "blue", collapsed: true }],
        tabs: [
          tabSpec("https://a.test/", { groupKey: 0 }),
          tabSpec("https://b.test/", { groupKey: 0 }),
          tabSpec("https://c.test/", { active: true }),
        ],
      },
    ]),
  );
  await restoreNewest(fake.api, state);
  const [windowId] = createdWindowIds(fake);
  const restored = tabsOf(fake, windowId);
  assert.equal(restored[0].groupId, restored[1].groupId);
  assert.notEqual(restored[0].groupId, -1);
  const group = fake.groups.get(restored[0].groupId);
  assert.equal(group.title, "Research");
  assert.equal(group.color, "blue");
  assert.equal(group.collapsed, true);
});

test("every snapshot window becomes its own new window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: false, groups: [], tabs: [tabSpec("https://a.test/", { active: true })] },
      { focused: true, groups: [], tabs: [tabSpec("https://b.test/", { active: true })] },
    ]),
  );
  assert.equal(await restoreNewest(fake.api, state), 2);
  assert.equal(createdWindowIds(fake).length, 2);
});

test("existing windows are never touched", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0, url: "https://mine.test/" }],
  });
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  await restoreNewest(fake.api, state);
  assert.deepEqual(tabsOf(fake, 1).map((tab) => tab.url), ["https://mine.test/"]);
});

test("unclonable URLs are skipped and the rest still restore", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [],
        tabs: [tabSpec("chrome://settings/"), tabSpec("https://b.test/", { active: true })],
      },
    ]),
  );
  await silently(() => restoreNewest(fake.api, state));
  const [windowId] = createdWindowIds(fake);
  assert.deepEqual(tabsOf(fake, windowId).map((tab) => tab.url), ["https://b.test/"]);
});

test("a window whose tabs are all unclonable keeps its placeholder", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: true, groups: [], tabs: [tabSpec("chrome://settings/", { active: true })] },
    ]),
  );
  await silently(() => restoreNewest(fake.api, state));
  const [windowId] = createdWindowIds(fake);
  assert.equal(tabsOf(fake, windowId).length, 1, "the window must not vanish");
});

test("nothing stored shows the badge and creates no window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  assert.equal(await restoreNewest(fake.api, state), 0);
  assert.equal(fake.badge.text, "!");
  assert.deepEqual(createdWindowIds(fake), []);
});

test("an unknown snapshot version shows the badge and creates no window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, { ...TWO_TABS, version: SNAPSHOT_VERSION + 1 });
  assert.equal(await restoreNewest(fake.api, state), 0);
  assert.equal(fake.badge.text, "!");
});

test("restoreInProgress is set during the restore and cleared after", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  let seenDuring = false;
  const create = fake.api.windows.create;
  fake.api.windows.create = async (data) => {
    seenDuring = state.restoreInProgress;
    return create(data);
  };
  await restoreNewest(fake.api, state);
  assert.equal(seenDuring, true);
  assert.equal(state.restoreInProgress, false);
});

test("restoreInProgress is cleared even when the restore throws", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  fake.api.windows.create = async () => {
    throw new Error("boom");
  };
  await silently(() => restoreNewest(fake.api, state));
  assert.equal(state.restoreInProgress, false);
});

const THREE_TABS = snapshot([
  {
    focused: true,
    groups: [],
    tabs: [
      tabSpec("https://a.test/"),
      tabSpec("https://b.test/"),
      tabSpec("https://c.test/", { active: true }),
    ],
  },
]);

test("a window closed mid-write is never called into again", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, THREE_TABS);
  const callsAtClose = closeFirstWindowMidWrite(fake, state);

  await restoreNewest(fake.api, state);

  assert.notEqual(callsAtClose(), null, "the window must really have closed mid-write");
  assert.deepEqual(
    fake.calls.slice(callsAtClose()),
    [],
    "a call into a destroyed tab strip can take the whole browser down",
  );
});

test("the placeholder of a window closed mid-write is not removed", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, THREE_TABS);
  closeFirstWindowMidWrite(fake, state);

  await restoreNewest(fake.api, state);

  // writeTabs returns the tabs it managed to create even when it unwound on an
  // abort, so a non-empty result must not be read as "the window survived".
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "tabs.remove"),
    [],
  );
});

test("a window closed mid-write is a silent race that does not stop the rest", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: false,
        groups: [],
        tabs: [tabSpec("https://a.test/"), tabSpec("https://b.test/", { active: true })],
      },
      { focused: true, groups: [], tabs: [tabSpec("https://c.test/", { active: true })] },
    ]),
  );
  closeFirstWindowMidWrite(fake, state);

  const { logs, warnings } = await recording(() => restoreNewest(fake.api, state));

  assert.deepEqual(warnings, [], "the user closed it on purpose; that is not a failure");
  assert.deepEqual(logs, []);
  const open = createdWindowIds(fake);
  assert.equal(open.length, 1, "the second window must still be restored");
  assert.deepEqual(tabsOf(fake, open[0]).map((tab) => tab.url), ["https://c.test/"]);
});

test("a rejection that beats windows.onRemoved is still a silent race", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: false,
        groups: [],
        tabs: [tabSpec("https://a.test/"), tabSpec("https://b.test/", { active: true })],
      },
      { focused: true, groups: [], tabs: [tabSpec("https://c.test/", { active: true })] },
    ]),
  );
  installWindowCloning(fake.api, state);

  const create = fake.api.tabs.create;
  let gone = null;
  fake.api.tabs.create = async (props) => {
    // Chromium does not promise windows.onRemoved arrives before calls into
    // the window start failing. Here the rejection wins that race, so the
    // watch has never been armed and only the rejection knows.
    if (props.windowId === gone) throw new Error(`No window with id ${gone}`);
    const tab = await create(props);
    if (gone === null) {
      gone = props.windowId;
      for (const [id, existing] of [...fake.tabs]) {
        if (existing.windowId === gone) fake.tabs.delete(id);
      }
      fake.windows.delete(gone);
    }
    return tab;
  };

  const { logs, warnings } = await recording(() => restoreNewest(fake.api, state));

  assert.deepEqual(warnings, [], "a window that has gone is an expected race, not a failure");
  assert.deepEqual(logs, []);
  const open = createdWindowIds(fake);
  assert.equal(open.length, 1, "one window's race must not abandon the others");
  assert.deepEqual(tabsOf(fake, open[0]).map((tab) => tab.url), ["https://c.test/"]);
});

test("a second restore while one is in flight does nothing", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: false, groups: [], tabs: [tabSpec("https://a.test/", { active: true })] },
      { focused: true, groups: [], tabs: [tabSpec("https://b.test/", { active: true })] },
    ]),
  );

  const flagAtEachCreate = [];
  const create = fake.api.windows.create;
  let second = null;
  fake.api.windows.create = async (data) => {
    const win = await create(data);
    flagAtEachCreate.push(state.restoreInProgress);
    // The user clicks the toolbar icon again, mid-restore.
    if (second === null) second = restoreNewest(fake.api, state);
    return win;
  };

  const created = await restoreNewest(fake.api, state);

  assert.equal(await second, 0, "the second click must do nothing");
  assert.equal(created, 2);
  assert.equal(createdWindowIds(fake).length, 2, "not one window more than the snapshot");
  assert.deepEqual(
    flagAtEachCreate,
    [true, true],
    "the guard must never drop while windows are still being made",
  );
});

test("a created window that is not a lone placeholder is left intact", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  const create = fake.api.windows.create;
  fake.api.windows.create = async (data) => {
    const win = await create(data);
    // A window that came up holding more than the one blank tab is not ours
    // to tidy, so nothing in it may be closed.
    fake.tabs.set(9000, {
      id: 9000,
      windowId: win.id,
      index: 1,
      url: "https://theirs.test/",
      pinned: false,
      active: false,
      groupId: -1,
      discarded: false,
      mutedInfo: { muted: false },
    });
    return win;
  };

  await restoreNewest(fake.api, state);

  const [windowId] = createdWindowIds(fake);
  assert.deepEqual(
    tabsOf(fake, windowId).map((tab) => tab.url),
    ["about:blank", "https://theirs.test/", "https://a.test/", "https://b.test/"],
  );
});

test("clicking the toolbar icon restores", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  installRestore(fake.api, state);
  await fake.api.action.onClicked.emit({});
  assert.equal(createdWindowIds(fake).length, 1);
});
