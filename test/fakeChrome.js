/**
 * An in-memory stand-in for the parts of the chrome API Tab Boss uses.
 *
 * Every method records itself in `calls` as [name, ...args] so tests can
 * assert on what was asked of the browser, not just the end state.
 *
 * Note: tabs.create does NOT fire tabs.onCreated. Tests emit events by hand,
 * which keeps cloning tests free of feedback loops.
 */

function createEvent() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    async emit(...args) {
      for (const fn of listeners) await fn(...args);
    },
  };
}

const WINDOW_DEFAULTS = { type: "normal", incognito: false };
const TAB_DEFAULTS = {
  pinned: false,
  active: false,
  groupId: -1,
  discarded: false,
  url: "https://example.com/",
};
const GROUP_DEFAULTS = { title: "", color: "grey", collapsed: false };

export function createFakeChrome(initial = {}) {
  const windows = new Map();
  const tabs = new Map();
  const groups = new Map();
  const storage = new Map();
  const session = new Map();
  const alarms = new Map();
  const calls = [];
  const badge = { text: "" };
  let nextTabId = 1000;
  let nextGroupId = 500;
  let nextWindowId = 50;

  for (const win of initial.windows ?? []) {
    windows.set(win.id, { ...WINDOW_DEFAULTS, ...win });
  }
  for (const tab of initial.tabs ?? []) {
    tabs.set(tab.id, {
      ...TAB_DEFAULTS,
      mutedInfo: { muted: false },
      ...tab,
    });
  }
  for (const group of initial.groups ?? []) {
    groups.set(group.id, { ...GROUP_DEFAULTS, ...group });
  }

  function requireTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id ${tabId}`);
    return tab;
  }

  /** One chrome.storage area. `name` keeps the recorded call names exact. */
  function createStorageArea(name, backing) {
    return {
      async get(keys) {
        calls.push([`storage.${name}.get`, keys]);
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of wanted) {
          if (backing.has(key)) out[key] = structuredClone(backing.get(key));
        }
        return out;
      },
      async set(items) {
        calls.push([`storage.${name}.set`, items]);
        for (const [key, value] of Object.entries(items)) {
          backing.set(key, structuredClone(value));
        }
      },
      async clear() {
        calls.push([`storage.${name}.clear`]);
        backing.clear();
      },
    };
  }

  const api = {
    tabs: {
      onCreated: createEvent(),

      async query({ windowId }) {
        calls.push(["tabs.query", windowId]);
        return [...tabs.values()]
          .filter((tab) => tab.windowId === windowId)
          .map((tab) => ({ ...tab }));
      },

      async move(tabId, { index }) {
        calls.push(["tabs.move", tabId, index]);
        const tab = requireTab(tabId);
        tab.index = index;
        return { ...tab };
      },

      async create({ windowId, url, pinned, active }) {
        calls.push(["tabs.create", windowId, url, !!pinned]);
        const id = nextTabId++;
        const index = [...tabs.values()].filter(
          (tab) => tab.windowId === windowId,
        ).length;
        const tab = {
          ...TAB_DEFAULTS,
          id,
          windowId,
          url,
          index,
          pinned: !!pinned,
          active: !!active,
          mutedInfo: { muted: false },
        };
        tabs.set(id, tab);
        return { ...tab };
      },

      async update(tabId, props) {
        calls.push(["tabs.update", tabId, props]);
        const tab = requireTab(tabId);
        if (props.muted !== undefined) tab.mutedInfo = { muted: props.muted };
        if (props.active !== undefined) tab.active = props.active;
        return { ...tab };
      },

      async remove(tabId) {
        calls.push(["tabs.remove", tabId]);
        const { windowId } = requireTab(tabId);
        tabs.delete(tabId);
        // Chromium closes a window when its last tab is removed. Modelling
        // that here is what stops an "emptied the new window" bug from
        // looking harmless in tests.
        const stillOpen = [...tabs.values()].some(
          (tab) => tab.windowId === windowId,
        );
        if (!stillOpen) windows.delete(windowId);
      },

      async discard(tabId) {
        calls.push(["tabs.discard", tabId]);
        const tab = requireTab(tabId);
        if (tab.active) throw new Error("Cannot discard the active tab");
        tab.discarded = true;
      },

      async group({ tabIds, createProperties }) {
        calls.push(["tabs.group", [...tabIds]]);
        const id = nextGroupId++;
        groups.set(id, {
          ...GROUP_DEFAULTS,
          id,
          windowId: createProperties.windowId,
        });
        for (const tabId of tabIds) requireTab(tabId).groupId = id;
        return id;
      },
    },

    tabGroups: {
      async get(groupId) {
        calls.push(["tabGroups.get", groupId]);
        const group = groups.get(groupId);
        if (!group) throw new Error(`No group with id ${groupId}`);
        return { ...group };
      },

      async update(groupId, props) {
        calls.push(["tabGroups.update", groupId, props]);
        const group = groups.get(groupId);
        if (!group) throw new Error(`No group with id ${groupId}`);
        Object.assign(group, props);
        return { ...group };
      },

      async query({ windowId }) {
        calls.push(["tabGroups.query", windowId]);
        return [...groups.values()]
          .filter((group) => group.windowId === windowId)
          .map((group) => ({ ...group }));
      },
    },

    windows: {
      onCreated: createEvent(),
      onFocusChanged: createEvent(),
      onRemoved: createEvent(),

      async get(windowId) {
        calls.push(["windows.get", windowId]);
        const win = windows.get(windowId);
        if (!win) throw new Error(`No window with id ${windowId}`);
        return { ...win };
      },

      async getLastFocused() {
        calls.push(["windows.getLastFocused"]);
        const win = [...windows.values()].at(-1);
        if (!win) throw new Error("No open windows");
        return { ...win };
      },

      async getAll() {
        calls.push(["windows.getAll"]);
        return [...windows.values()].map((win) => ({ ...win }));
      },

      async create(createData = {}) {
        calls.push(["windows.create", createData]);
        const id = nextWindowId++;
        windows.set(id, { ...WINDOW_DEFAULTS, id, ...createData });
        const tabId = nextTabId++;
        tabs.set(tabId, {
          ...TAB_DEFAULTS,
          id: tabId,
          windowId: id,
          index: 0,
          url: "about:blank",
          active: true,
        });
        const created = { ...windows.get(id) };
        // Chromium announces a new window before the create call resolves, so
        // a listener can see it BEFORE the caller learns its id. Restoring
        // depends on that being true here: suppressedWindowIds cannot cover a
        // window whose id nobody knows yet, which is the whole reason
        // state.restoreInProgress exists. A fake that only emitted after
        // returning would make that guard untestable.
        await api.windows.onCreated.emit(created);
        await api.windows.onFocusChanged.emit(id);
        return created;
      },
    },

    action: {
      onClicked: createEvent(),
      async setBadgeText(details) {
        calls.push(["action.setBadgeText", details]);
        badge.text = details.text;
      },
    },

    alarms: {
      onAlarm: createEvent(),
      async create(name, info) {
        calls.push(["alarms.create", name, info]);
        // Chromium cancels and replaces a same-name alarm rather than leaving
        // the existing one alone, and re-derives its first fire time. Set is
        // the right model: the new schedule wins.
        alarms.set(name, info);
      },
      async get(name) {
        calls.push(["alarms.get", name]);
        // chrome.alarms.get resolves with undefined for an unknown name.
        return alarms.has(name) ? { name, ...alarms.get(name) } : undefined;
      },
    },

    runtime: {
      onStartup: createEvent(),
      onInstalled: createEvent(),
    },

    storage: {
      local: createStorageArea("local", storage),
      // A separate backing map, because the real areas have different
      // lifetimes: the browser clears session storage on shutdown and keeps
      // local across restarts. A test simulates a browser restart by clearing
      // the session map and leaving the local one alone.
      session: createStorageArea("session", session),
    },
  };

  return { api, calls, tabs, windows, groups, storage, session, alarms, badge };
}
