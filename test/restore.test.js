import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { appendSnapshot } from "../src/snapshotStore.js";
import { SNAPSHOT_VERSION } from "../src/snapshot.js";
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
 * Runs a restore whose logging is expected and asserted elsewhere, so the
 * suite's own output stays clean. Matches the convention in tabWriter.test.js.
 */
async function silently(run) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
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

test("clicking the toolbar icon restores", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await appendSnapshot(fake.api, TWO_TABS);
  installRestore(fake.api, state);
  await fake.api.action.onClicked.emit({});
  assert.equal(createdWindowIds(fake).length, 1);
});
