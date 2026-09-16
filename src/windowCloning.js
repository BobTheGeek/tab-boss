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

/** The one `about:` URL an extension is allowed to reopen. */
const CLONABLE_ABOUT_URL = "about:blank";

export function isClonableUrl(url) {
  if (!url) return false;
  if (url === CLONABLE_ABOUT_URL) return true;
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
 * One clone's view of "has the window I am filling gone away?".
 *
 * `aborted()` is checked before every call. `mark()` exists because the news
 * can reach us two ways: windows.onRemoved, or a rejection that proves the
 * window has gone before the event arrives. Chromium does not promise which
 * of those two messages lands first, so whichever wins marks the window and
 * every later phase stops.
 */
function createAbortWatch(state, windowId) {
  return {
    aborted: () => state.abortedWindowIds.has(windowId),
    mark: () => state.abortedWindowIds.add(windowId),
  };
}

/**
 * Rebuilds each source group in the target window.
 *
 * Collapsed state is NOT applied here. Chromium refuses to collapse a group
 * holding the active tab, so the caller applies it after activation and lets
 * the browser refuse where it must.
 *
 * `watch.aborted()` reports that the target window has been closed. It is
 * checked before every call because a call into a destroyed window's tab strip
 * is not merely useless: it can trip a CHECK in the browser process and take
 * the whole browser down with it.
 *
 * Returns Array<{ newGroupId, collapsed }>.
 */
async function recreateGroups(api, targetId, pairs, watch) {
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
  // One group vanishing is worth a line. A user closing the window while four
  // groups are pending is not worth four.
  let warned = false;

  for (const [sourceGroupId, tabIds] of cloneIdsBySourceGroup) {
    if (watch.aborted()) return created;
    try {
      const sourceGroup = await api.tabGroups.get(sourceGroupId);
      if (watch.aborted()) return created;
      const newGroupId = await api.tabs.group({
        tabIds,
        createProperties: { windowId: targetId },
      });
      if (watch.aborted()) return created;
      await api.tabGroups.update(newGroupId, {
        title: sourceGroup.title,
        color: sourceGroup.color,
      });
      created.push({ newGroupId, collapsed: sourceGroup.collapsed });
    } catch (error) {
      if (watch.aborted()) return created;
      // A rejection here may be the first news that the window has gone,
      // arriving ahead of windows.onRemoved. Falling through to the next
      // group would dispatch another tabs.group into a tab strip we have
      // already watched die, which is the call most likely to trip a CHECK.
      if (!(await windowStillOpen(api, targetId))) {
        watch.mark();
        return created;
      }
      // The window is fine, so this really was just one bad group.
      if (!warned) {
        warned = true;
        console.warn("[Tab Boss] could not recreate a tab group", error);
      }
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
 *
 * This is five to twenty sequential calls into one window, and the user may
 * close that window at any await. `watch.aborted()` says the window has gone;
 * it is checked before every single call, and the copy then unwinds
 * immediately and silently with whatever pairs it had built. Swallowing the
 * failures instead — as `ignoreFailure` does for a one-off refusal — would
 * keep firing calls at a destroyed window, which is what crashed the browser.
 */
async function copyTabs(api, sourceId, targetId, watch) {
  // Defence in depth. The caller probes the target's liveness immediately
  // before this call with nothing awaited in between, so nothing can land
  // here — but this reads the source window, which is harmless either way.
  if (watch.aborted()) return [];
  const sourceTabs = (await api.tabs.query({ windowId: sourceId })).sort(
    (a, b) => a.index - b.index,
  );

  const pairs = [];
  let skipped = 0;

  for (const source of sourceTabs) {
    if (watch.aborted()) return pairs;
    // A tab whose navigation has not committed reports an empty url and
    // carries its destination in pendingUrl, exactly as isBlankTab assumes.
    const url = source.url || source.pendingUrl || "";
    if (!isClonableUrl(url)) {
      skipped += 1;
      continue;
    }
    const clone = await api.tabs.create({
      windowId: targetId,
      url,
      pinned: source.pinned,
      active: false,
    });
    pairs.push({ source, clone });
  }

  if (skipped > 0 && !watch.aborted()) {
    // Routine: a pinned chrome:// tab would warn on every single Cmd+N. An
    // abort says nothing at all, and the create loop can exit normally on its
    // last tab with the window already gone, so this needs its own check.
    console.log(
      `[Tab Boss] skipped ${skipped} tab(s) the browser will not let an extension reopen`,
    );
  }

  for (const { source, clone } of pairs) {
    if (!source.mutedInfo?.muted) continue;
    if (watch.aborted()) return pairs;
    await ignoreFailure(api.tabs.update(clone.id, { muted: true }));
  }

  const groups = await recreateGroups(api, targetId, pairs, watch);

  const activePair = pairs.find(({ source }) => source.active);
  if (activePair) {
    if (watch.aborted()) return pairs;
    await ignoreFailure(api.tabs.update(activePair.clone.id, { active: true }));
  }

  for (const { newGroupId, collapsed } of groups) {
    if (!collapsed) continue;
    if (watch.aborted()) return pairs;
    await ignoreFailure(api.tabGroups.update(newGroupId, { collapsed: true }));
  }

  for (const { clone } of pairs) {
    if (clone.id === activePair?.clone.id) continue;
    if (watch.aborted()) return pairs;
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
  // Resolved before the first await. Any windows.onFocusChanged landing while
  // this function is suspended rewrites the focus history the source is
  // derived from, so two quick Cmd+N presses would otherwise clone each other.
  // It is a pure read of state, so computing it for windows that later fail
  // the gate costs nothing.
  const sourceId = resolveSourceWindowId(state, newWindow.id);

  if (newWindow.incognito) return false;
  if (newWindow.type !== "normal") return false;

  // Armed before the first await, because windows.onRemoved only records a
  // window that is already an in-flight clone target. Arming any later would
  // drop a close that lands during the gate — the likeliest moment of all for
  // a reflexive Cmd+N, Cmd+W — and leave every guard below reading false.
  // The cost is that new tab placement skips this window's first tab, which is
  // a no-op: it is the only tab in a one-tab window.
  state.suppressedWindowIds.add(newWindow.id);
  const watch = createAbortWatch(state, newWindow.id);
  try {
    const newTabs = await api.tabs.query({ windowId: newWindow.id });
    if (newTabs.length !== 1) return false;
    if (!isBlankTab(newTabs[0])) return false;
    const placeholder = newTabs[0];

    if (sourceId == null || sourceId === newWindow.id) return false;
    // A window still being filled by the cloner holds no meaningful contents
    // yet, so cloning it would copy a half-built window. The line above has
    // already ruled out this window's own entry.
    if (state.suppressedWindowIds.has(sourceId)) return false;

    let source;
    try {
      source = await api.windows.get(sourceId);
    } catch {
      return false;
    }
    if (!isCloneSource(source)) return false;

    // The watch cannot see a close that landed before it was armed, and an
    // event can always be slower than we are. One read-only probe, here,
    // before the first mutating call, is the belt to that braces.
    if (!(await windowStillOpen(api, newWindow.id))) {
      watch.mark();
      return false;
    }

    try {
      const pairs = await copyTabs(api, source.id, newWindow.id, watch);
      // The placeholder belongs to a window that no longer exists, so there is
      // nothing to tidy up and nothing safe to call.
      if (watch.aborted()) return false;
      // Removing a window's last tab closes the window. If every source tab
      // was unclonable there is nothing to replace the placeholder with, so
      // leave a plain empty window rather than making the new window vanish.
      if (pairs.length > 0) {
        await api.tabs.remove(placeholder.id);
      }
    } catch (error) {
      // The user can close the new window mid-clone, which fails every pending
      // call. That is an expected race and stays silent. Anything else is a
      // real failure and must be findable in the service worker console. When
      // the window's death is already known, we do not ask the browser again.
      if (!watch.aborted() && (await windowStillOpen(api, newWindow.id))) {
        console.warn("[Tab Boss] clone failed", error);
      }
      return false;
    }
    return true;
  } finally {
    // Every exit from the gate, including a thrown one, unwinds through here.
    state.suppressedWindowIds.delete(newWindow.id);
    state.abortedWindowIds.delete(newWindow.id);
  }
}

export function installWindowCloning(api, state) {
  // Manifest V3 will not wake an evicted service worker for a listener that
  // was registered inside an awaited callback, so both registrations stay
  // synchronous at the top level of the installer.
  api.windows.onCreated.addListener(
    async (win) => {
      await cloneIntoWindow(api, state, win);
    },
    { windowTypes: ["normal"] },
  );

  api.windows.onRemoved.addListener((windowId) => {
    // Only in-flight clone targets are recorded. Remembering every window the
    // user ever closed would leak for the life of the service worker, and the
    // clone clears its own id as it unwinds.
    if (!state.suppressedWindowIds.has(windowId)) return;
    state.abortedWindowIds.add(windowId);
  });
}
