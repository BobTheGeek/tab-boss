import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { appendSnapshot } from "../src/snapshotStore.js";
import { SNAPSHOT_VERSION } from "../src/snapshot.js";
import { installFocusTracking, seedFocus } from "../src/focusTracking.js";
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
 * Recording that close into state.abortedWindowIds is what arms the abort
 * watch restore builds; without it every guard that depends on it reads false
 * forever. installRestore now registers that listener itself, so these tests
 * no longer borrow it from installWindowCloning — see "restore brings its own
 * abort tracking", which installs nothing else and still catches the close.
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

test("two groups in one window are rebuilt separately with their own tabs", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      {
        focused: true,
        groups: [
          { key: 0, title: "Research", color: "blue", collapsed: false },
          { key: 1, title: "Work", color: "red", collapsed: true },
        ],
        tabs: [
          tabSpec("https://r1.test/", { groupKey: 0 }),
          tabSpec("https://w1.test/", { groupKey: 1 }),
          tabSpec("https://r2.test/", { groupKey: 0 }),
          tabSpec("https://loose.test/", { active: true }),
          tabSpec("https://w2.test/", { groupKey: 1 }),
        ],
      },
    ]),
  );

  await restoreNewest(fake.api, state);

  const [windowId] = createdWindowIds(fake);
  const byUrl = new Map(tabsOf(fake, windowId).map((tab) => [tab.url, tab]));
  const research = byUrl.get("https://r1.test/").groupId;
  const work = byUrl.get("https://w1.test/").groupId;

  assert.notEqual(research, work, "two snapshot groups must not collapse into one");
  assert.equal(byUrl.get("https://r2.test/").groupId, research);
  assert.equal(byUrl.get("https://w2.test/").groupId, work);
  assert.equal(byUrl.get("https://loose.test/").groupId, -1, "an ungrouped tab must stay ungrouped");

  assert.deepEqual(
    [fake.groups.get(research).title, fake.groups.get(research).color, fake.groups.get(research).collapsed],
    ["Research", "blue", false],
  );
  assert.deepEqual(
    [fake.groups.get(work).title, fake.groups.get(work).color, fake.groups.get(work).collapsed],
    ["Work", "red", true],
  );
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

test("restore brings its own abort tracking and is never called into a closed window", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, THREE_TABS);
  // The window cloner is deliberately NOT installed. Restore's tb-084 crash
  // protection must be wired by restore itself: with the cloner supplying the
  // only windows.onRemoved listener, deleting installWindowCloning from
  // background.js silently disarmed every abort check in the writer while the
  // whole suite stayed green.
  installRestore(fake.api, state);

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

  await fake.api.action.onClicked.emit({});

  assert.notEqual(callsAtClose, null, "the window must really have closed mid-write");
  assert.deepEqual(
    fake.calls.slice(callsAtClose),
    [],
    "a call into a destroyed tab strip can take the whole browser down",
  );
});

test("a stored snapshot with no windows array shows the badge instead of throwing", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, { version: SNAPSHOT_VERSION });
  assert.equal(await restoreNewest(fake.api, state), 0);
  assert.equal(fake.badge.text, "!");
});

test("clicking the icon with a malformed snapshot stored never does nothing at all", async () => {
  const fake = createFakeChrome();
  const state = createState();
  // A corrupted profile is one of the three scenarios this feature exists for,
  // so the corruption must not land in the one code path meant to rescue it.
  // Unguarded, this threw out of the action.onClicked listener as an unhandled
  // rejection: no window, no badge, and an icon the user clicks in vain.
  await appendSnapshot(fake.api, { version: SNAPSHOT_VERSION, windows: "nope" });
  installRestore(fake.api, state);

  await fake.api.action.onClicked.emit({});

  assert.equal(fake.badge.text, "!", "the user pressed a button; restore must never fail silently");
  assert.deepEqual(createdWindowIds(fake), []);
});

test("an unexpected throw mid-restore still flashes the badge", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  // Something below restoreWindow's own catch fails. Whatever it was, the user
  // must not be left clicking an icon that does nothing.
  state.suppressedWindowIds = {
    has: () => false,
    delete: () => {},
    add() {
      throw new Error("boom");
    },
  };

  const { warnings } = await recording(() => restoreNewest(fake.api, state));

  assert.equal(fake.badge.text, "!");
  assert.equal(warnings.length, 1, "an unexpected failure must be findable in the console");
  assert.equal(state.restoreInProgress, false);
});

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

test("two clicks landing during the snapshot read cannot both start a restore", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: false, groups: [], tabs: [tabSpec("https://a.test/", { active: true })] },
      { focused: true, groups: [], tabs: [tabSpec("https://b.test/", { active: true })] },
    ]),
  );

  // Hold the snapshot read open so both clicks are still inside it. This is
  // the window the bail alone does not close: only setting the flag in the
  // same tick as the check does.
  const get = fake.api.storage.local.get;
  fake.api.storage.local.get = async (keys) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return get(keys);
  };

  const [first, second] = await Promise.all([
    restoreNewest(fake.api, state),
    restoreNewest(fake.api, state),
  ]);

  assert.deepEqual(
    [first, second],
    [2, 0],
    "state.restoreInProgress must be set in the same tick as the check that guards it: " +
      "with the assignment left below the snapshot read, both clicks get past the check " +
      "and the loser's finally clears the flag under the winner",
  );
  assert.equal(
    createdWindowIds(fake).length,
    2,
    "a two-window snapshot must yield two windows however many times it is clicked",
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

test("a restored window is not cloned by the window cloner", async () => {
  // The whole feature wired together: the user has a focused window of their
  // own, the cloner and focus tracking are live, and the fake announces a new
  // window the way Chromium does — windows.onCreated BEFORE windows.create
  // resolves, so suppressedWindowIds cannot possibly cover it yet. Only
  // state.restoreInProgress stands between the restored window and a copy of
  // the user's tabs landing on top of it.
  const fake = createFakeChrome({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://mine-1.test/", active: true },
      { id: 11, windowId: 1, index: 1, url: "https://mine-2.test/" },
    ],
  });
  const state = createState();
  installFocusTracking(fake.api, state);
  installWindowCloning(fake.api, state);
  await seedFocus(fake.api, state);
  assert.equal(state.currentWindowId, 1, "the cloner must have a source to copy from");

  await appendSnapshot(fake.api, TWO_TABS);
  installRestore(fake.api, state);

  await silently(() => fake.api.action.onClicked.emit({}));

  const restored = createdWindowIds(fake);
  assert.equal(restored.length, 1);
  assert.deepEqual(
    tabsOf(fake, restored[0]).map((tab) => tab.url),
    ["https://a.test/", "https://b.test/"],
    "the cloner dumped the user's focused window on top of the restored tabs",
  );
  assert.deepEqual(
    tabsOf(fake, 1).map((tab) => tab.url),
    ["https://mine-1.test/", "https://mine-2.test/"],
    "the window the user already had open must be left exactly as it was",
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

test("restore tags every window it creates so a deferred clone cannot target it", async () => {
  // The tb-l56 restore-race fix: restoreInProgress is cleared when the restore
  // ends, but the clone decision runs ~400ms later. restore must leave a tag
  // that outlives the flag, so the cloner still refuses the restored window.
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: false, groups: [], tabs: [tabSpec("https://a.test/", { active: true })] },
      { focused: true, groups: [], tabs: [tabSpec("https://b.test/", { active: true })] },
    ]),
  );

  await restoreNewest(fake.api, state);

  const created = createdWindowIds(fake);
  assert.equal(created.length, 2);
  for (const id of created) {
    assert.ok(
      state.restoredWindowIds.has(id),
      `restored window ${id} must be tagged`,
    );
  }
  // And the flag is back down: the tag is the only thing protecting these now.
  assert.equal(state.restoreInProgress, false);
});

test("an all-unclonable snapshot window is still tagged, since that is the window at risk", async () => {
  // This is the exact reproduction shape: a snapshot window whose only tab is
  // unclonable comes back blank, and a blank window is precisely what a clone
  // would overwrite. It must be tagged even though nothing was written into it.
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(
    fake.api,
    snapshot([
      { focused: true, groups: [], tabs: [tabSpec("chrome://settings/", { active: true })] },
    ]),
  );

  await restoreNewest(fake.api, state);

  const [id] = createdWindowIds(fake);
  assert.equal(tabsOf(fake, id).length, 1, "the window came back blank");
  assert.ok(state.restoredWindowIds.has(id), "the blank restored window must be tagged");
});
