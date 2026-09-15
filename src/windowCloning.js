import { TAB_GROUP_ID_NONE, resolveSourceWindowId } from "./state.js";

/** Exact URLs a brand new empty window may show. */
export const BLANK_TAB_URLS = ["", "about:blank"];

/**
 * Prefixes of new-tab-page URLs. ego lite is Chromium based, so it may use any
 * of these. If a future build uses something else, add it here — this list is
 * the single place blankness is decided.
 */
export const BLANK_TAB_PREFIXES = [
  "chrome://newtab",
  "chrome://new-tab-page",
  "ego://newtab",
];

export function isBlankTab(tab) {
  const url = tab.url || tab.pendingUrl || "";
  if (BLANK_TAB_URLS.includes(url)) return true;
  return BLANK_TAB_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function isCloneSource(win) {
  return win.type === "normal" && !win.incognito;
}

/**
 * Distinguishes an expected race from an unexpected failure. If the target
 * window has gone, the user closed it mid-clone and every pending call was
 * always going to fail — that is not worth logging.
 */
async function windowStillOpen(api, windowId) {
  try {
    await api.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

/** Schemes Chromium forbids an extension from opening in a new tab. */
const UNCLONABLE_PREFIXES = [
  "about:",
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "edge://",
  "ego://",
  "file://",
  "view-source:",
];

export function isClonableUrl(url) {
  if (!url) return false;
  return !UNCLONABLE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Runs a best-effort browser call whose failure must not stop the clone. */
async function ignoreFailure(promise) {
  try {
    await promise;
  } catch {
    // Best effort only.
  }
}

/**
 * Rebuilds each source group in the target window.
 *
 * Collapsed state is NOT applied here. Chromium refuses to collapse a group
 * holding the active tab, so the caller applies it after activation and lets
 * the browser refuse where it must.
 *
 * Returns Array<{ newGroupId, collapsed }>.
 */
async function recreateGroups(api, targetId, pairs) {
  const cloneIdsBySourceGroup = new Map();
  for (const { source, clone } of pairs) {
    const groupId = source.groupId;
    if (groupId == null || groupId === TAB_GROUP_ID_NONE) continue;
    if (!cloneIdsBySourceGroup.has(groupId)) {
      cloneIdsBySourceGroup.set(groupId, []);
    }
    cloneIdsBySourceGroup.get(groupId).push(clone.id);
  }

  const created = [];
  for (const [sourceGroupId, tabIds] of cloneIdsBySourceGroup) {
    try {
      const sourceGroup = await api.tabGroups.get(sourceGroupId);
      const newGroupId = await api.tabs.group({
        tabIds,
        createProperties: { windowId: targetId },
      });
      await api.tabGroups.update(newGroupId, {
        title: sourceGroup.title,
        color: sourceGroup.color,
      });
      created.push({ newGroupId, collapsed: sourceGroup.collapsed });
    } catch (error) {
      console.warn("[Tab Boss] could not recreate a tab group", error);
    }
  }
  return created;
}

/**
 * Recreates the source window's tabs in the target window.
 *
 * Ordering matters: tabs are created, then muted, then the right one is
 * activated, and only then are the rest unloaded. Discarding before activating
 * would fight the browser, which refuses to discard the active tab.
 */
async function copyTabs(api, sourceId, targetId) {
  const sourceTabs = (await api.tabs.query({ windowId: sourceId })).sort(
    (a, b) => a.index - b.index,
  );

  const pairs = [];
  let skipped = 0;

  for (const source of sourceTabs) {
    if (!isClonableUrl(source.url)) {
      skipped += 1;
      continue;
    }
    const clone = await api.tabs.create({
      windowId: targetId,
      url: source.url,
      pinned: source.pinned,
      active: false,
    });
    pairs.push({ source, clone });
  }

  if (skipped > 0) {
    console.warn(
      `[Tab Boss] skipped ${skipped} tab(s) the browser will not let an extension reopen`,
    );
  }

  for (const { source, clone } of pairs) {
    if (source.mutedInfo?.muted) {
      await ignoreFailure(api.tabs.update(clone.id, { muted: true }));
    }
  }

  const groups = await recreateGroups(api, targetId, pairs);

  const activePair = pairs.find(({ source }) => source.active);
  if (activePair) {
    await ignoreFailure(api.tabs.update(activePair.clone.id, { active: true }));
  }

  for (const { newGroupId, collapsed } of groups) {
    if (!collapsed) continue;
    await ignoreFailure(api.tabGroups.update(newGroupId, { collapsed: true }));
  }

  for (const { clone } of pairs) {
    if (clone.id === activePair?.clone.id) continue;
    await ignoreFailure(api.tabs.discard(clone.id));
  }

  return pairs;
}

/**
 * Requirement 2. Returns true when a clone actually ran.
 *
 * The one-blank-tab check is what makes this safe: a window made by dragging a
 * tab out already holds a real page, a window.open() popup already holds a URL,
 * and a session restore holds many tabs. Only a deliberate Cmd+N passes.
 */
export async function cloneIntoWindow(api, state, newWindow) {
  if (newWindow.incognito) return false;
  if (newWindow.type !== "normal") return false;

  const newTabs = await api.tabs.query({ windowId: newWindow.id });
  if (newTabs.length !== 1) return false;
  if (!isBlankTab(newTabs[0])) return false;
  const placeholder = newTabs[0];

  const sourceId = resolveSourceWindowId(state, newWindow.id);
  if (sourceId == null || sourceId === newWindow.id) return false;

  let source;
  try {
    source = await api.windows.get(sourceId);
  } catch {
    return false;
  }
  if (!isCloneSource(source)) return false;

  state.suppressedWindowIds.add(newWindow.id);
  try {
    await copyTabs(api, source.id, newWindow.id);
    await api.tabs.remove(placeholder.id);
  } catch (error) {
    // The user can close the new window mid-clone, which fails every pending
    // call. That is an expected race and stays silent. Anything else is a real
    // failure and must be findable in the service worker console.
    if (await windowStillOpen(api, newWindow.id)) {
      console.warn("[Tab Boss] clone failed", error);
    }
  } finally {
    state.suppressedWindowIds.delete(newWindow.id);
  }
  return true;
}

export function installWindowCloning(api, state) {
  api.windows.onCreated.addListener(
    async (win) => {
      await cloneIntoWindow(api, state, win);
    },
    { windowTypes: ["normal"] },
  );
}
