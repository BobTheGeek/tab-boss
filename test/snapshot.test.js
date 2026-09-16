import test from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_VERSION,
  buildSnapshot,
  fingerprint,
  isSuspectedLoss,
  totalTabs,
} from "../src/snapshot.js";

function win(overrides = {}) {
  return { id: 1, type: "normal", incognito: false, focused: false, ...overrides };
}

function tab(overrides = {}) {
  return {
    url: "https://a.test/",
    title: "A",
    pinned: false,
    active: false,
    groupId: -1,
    mutedInfo: { muted: false },
    ...overrides,
  };
}

const ONE_WINDOW = [
  {
    window: win(),
    tabs: [tab(), tab({ url: "https://b.test/", title: "B", active: true })],
    groups: [],
  },
];

test("two groups in one window get distinct keys and keep their own tabs", () => {
  // One group is the case where an off-by-one in the remap is invisible: key 0
  // is what both a correct map and a broken one produce. Restore is now the
  // consumer of these keys, so a second group has to be pinned.
  const snap = buildSnapshot(
    [
      {
        window: win(),
        tabs: [
          tab({ url: "https://r1.test/", groupId: 77 }),
          tab({ url: "https://w1.test/", groupId: 88 }),
          tab({ url: "https://r2.test/", groupId: 77 }),
          tab({ url: "https://loose.test/", active: true }),
          tab({ url: "https://w2.test/", groupId: 88 }),
        ],
        groups: [
          { id: 77, title: "Research", color: "blue", collapsed: false },
          { id: 88, title: "Work", color: "red", collapsed: true },
        ],
      },
    ],
    0,
  );

  assert.deepEqual(snap.windows[0].groups, [
    { key: 0, title: "Research", color: "blue", collapsed: false },
    { key: 1, title: "Work", color: "red", collapsed: true },
  ]);
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => [t.url, t.groupKey]),
    [
      ["https://r1.test/", 0],
      ["https://w1.test/", 1],
      ["https://r2.test/", 0],
      ["https://loose.test/", null],
      ["https://w2.test/", 1],
    ],
  );
});

test("group keys follow the groups array, not the order the tabs appear in", () => {
  // The first tab belongs to the second group. A remap keyed off tab order
  // rather than group order would swap the two, and every restored tab would
  // land in the wrong group with the wrong title and colour.
  const snap = buildSnapshot(
    [
      {
        window: win(),
        tabs: [tab({ groupId: 88, active: true }), tab({ url: "https://b.test/", groupId: 77 })],
        groups: [
          { id: 77, title: "Research", color: "blue", collapsed: false },
          { id: 88, title: "Work", color: "red", collapsed: false },
        ],
      },
    ],
    0,
  );
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => t.groupKey),
    [1, 0],
  );
});

test("a snapshot carries its version and the time it was taken", () => {
  const snap = buildSnapshot(ONE_WINDOW, 123);
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.takenAt, 123);
});

test("tabs are captured in order with their flags", () => {
  const snap = buildSnapshot(
    [
      {
        window: win(),
        tabs: [
          tab({ pinned: true }),
          tab({ url: "https://b.test/", mutedInfo: { muted: true }, active: true }),
        ],
        groups: [],
      },
    ],
    0,
  );
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => [t.url, t.pinned, t.muted, t.active]),
    [
      ["https://a.test/", true, false, false],
      ["https://b.test/", false, true, true],
    ],
  );
});

test("live group ids are remapped to snapshot-local keys", () => {
  const snap = buildSnapshot(
    [
      {
        window: win(),
        tabs: [tab({ groupId: 77 }), tab({ groupId: 77 }), tab()],
        groups: [{ id: 77, title: "Research", color: "blue", collapsed: true }],
      },
    ],
    0,
  );
  assert.deepEqual(snap.windows[0].groups, [
    { key: 0, title: "Research", color: "blue", collapsed: true },
  ]);
  assert.deepEqual(
    snap.windows[0].tabs.map((t) => t.groupKey),
    [0, 0, null],
  );
});

test("a still-loading tab is captured from pendingUrl", () => {
  const snap = buildSnapshot(
    [{ window: win(), tabs: [tab({ url: "", pendingUrl: "https://c.test/" })], groups: [] }],
    0,
  );
  assert.equal(snap.windows[0].tabs[0].url, "https://c.test/");
});

test("incognito and non-normal windows are never captured", () => {
  const snap = buildSnapshot(
    [
      { window: win({ id: 1, incognito: true }), tabs: [tab()], groups: [] },
      { window: win({ id: 2, type: "popup" }), tabs: [tab()], groups: [] },
      { window: win({ id: 3 }), tabs: [tab()], groups: [] },
    ],
    0,
  );
  assert.equal(snap.windows.length, 1);
});

test("totalTabs counts across every window", () => {
  const snap = buildSnapshot(
    [
      { window: win({ id: 1 }), tabs: [tab(), tab()], groups: [] },
      { window: win({ id: 2 }), tabs: [tab()], groups: [] },
    ],
    0,
  );
  assert.equal(totalTabs(snap), 3);
});

test("the fingerprint ignores when it was taken", () => {
  assert.equal(
    fingerprint(buildSnapshot(ONE_WINDOW, 1)),
    fingerprint(buildSnapshot(ONE_WINDOW, 999)),
  );
});

test("the fingerprint ignores titles, which change as pages load", () => {
  const renamed = [
    {
      window: win(),
      tabs: [tab({ title: "changed" }), tab({ url: "https://b.test/", title: "also changed", active: true })],
      groups: [],
    },
  ];
  assert.equal(fingerprint(buildSnapshot(ONE_WINDOW, 0)), fingerprint(buildSnapshot(renamed, 0)));
});

test("the fingerprint changes on anything that is layout", () => {
  const base = fingerprint(buildSnapshot(ONE_WINDOW, 0));
  const variants = {
    reorder: [{ window: win(), tabs: [tab({ url: "https://b.test/", active: true }), tab()], groups: [] }],
    pinned: [{ window: win(), tabs: [tab({ pinned: true }), tab({ url: "https://b.test/", active: true })], groups: [] }],
    muted: [{ window: win(), tabs: [tab({ mutedInfo: { muted: true } }), tab({ url: "https://b.test/", active: true })], groups: [] }],
    active: [{ window: win(), tabs: [tab({ active: true }), tab({ url: "https://b.test/" })], groups: [] }],
    grouped: [
      {
        window: win(),
        tabs: [tab({ groupId: 5 }), tab({ url: "https://b.test/", active: true })],
        groups: [{ id: 5, title: "G", color: "red", collapsed: false }],
      },
    ],
  };
  for (const [name, windows] of Object.entries(variants)) {
    assert.notEqual(fingerprint(buildSnapshot(windows, 0)), base, name);
  }
});

test("the fingerprint changes when a group is renamed, recoloured, or collapsed", () => {
  const withGroup = (group) => [
    { window: win(), tabs: [tab({ groupId: 5 })], groups: [{ id: 5, ...group }] },
  ];
  const base = fingerprint(buildSnapshot(withGroup({ title: "G", color: "red", collapsed: false }), 0));
  assert.notEqual(fingerprint(buildSnapshot(withGroup({ title: "H", color: "red", collapsed: false }), 0)), base);
  assert.notEqual(fingerprint(buildSnapshot(withGroup({ title: "G", color: "blue", collapsed: false }), 0)), base);
  assert.notEqual(fingerprint(buildSnapshot(withGroup({ title: "G", color: "red", collapsed: true }), 0)), base);
});

test("a suspected loss is a tab count that has more than halved", () => {
  const of = (count) => ({
    windows: [{ tabs: Array.from({ length: count }, () => ({})), groups: [] }],
  });
  assert.equal(isSuspectedLoss(of(4), of(10)), true);
  assert.equal(isSuspectedLoss(of(5), of(10)), false, "exactly half is not a loss");
  assert.equal(isSuspectedLoss(of(6), of(10)), false);
  assert.equal(isSuspectedLoss(of(10), of(10)), false);
  assert.equal(isSuspectedLoss(of(12), of(10)), false, "growth is never a loss");
});
