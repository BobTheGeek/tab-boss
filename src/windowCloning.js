import {
  TAB_GROUP_ID_NONE,
  createAbortWatch,
  installAbortTracking,
  resolveSourceWindowId,
} from "./state.js";
import { windowStillOpen, writeTabs } from "./tabWriter.js";

// The scheme test lives with the writer that applies it, and is re-exported
// here so existing importers of windowCloning keep working.
export { isClonableUrl } from "./tabWriter.js";

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
 * Reads the source window and describes it as a plan the writer can replay.
 *
 * Every call here is against the SOURCE window, so it cannot hurt the target.
 * The watch is still consulted, because there is no point reading a source for
 * a target that has already gone.
 *
 * Returns { plan, groups } or null when the read was abandoned.
 */
async function planFromWindow(api, sourceId, watch) {
  // Reached when the removal event arrived during the gate but the window was
  // still queryable, so the caller's liveness probe said "alive" and only the
  // armed watch knows better.
  if (watch.aborted()) return null;
  const sourceTabs = (await api.tabs.query({ windowId: sourceId })).sort(
    (a, b) => a.index - b.index,
  );

  const groupKeyBySourceId = new Map();
  const groups = [];
  let warned = false;

  for (const tab of sourceTabs) {
    const groupId = tab.groupId;
    if (groupId == null || groupId === TAB_GROUP_ID_NONE) continue;
    if (groupKeyBySourceId.has(groupId)) continue;
    if (watch.aborted()) return null;
    try {
      const group = await api.tabGroups.get(groupId);
      const key = groups.length;
      groupKeyBySourceId.set(groupId, key);
      groups.push({
        key,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
    } catch (error) {
      // One group vanishing is worth a line. A user closing the source while
      // four groups are pending is not worth four.
      if (!warned) {
        warned = true;
        console.warn("[Tab Boss] could not recreate a tab group", error);
      }
    }
  }

  const plan = sourceTabs.map((tab) => ({
    // A tab whose navigation has not committed reports an empty url and
    // carries its destination in pendingUrl, exactly as isBlankTab assumes.
    url: tab.url || tab.pendingUrl || "",
    pinned: tab.pinned,
    muted: Boolean(tab.mutedInfo?.muted),
    active: Boolean(tab.active),
    groupKey: groupKeyBySourceId.has(tab.groupId)
      ? groupKeyBySourceId.get(tab.groupId)
      : null,
  }));

  return { plan, groups };
}

/**
 * Requirement 2. Returns true when a clone actually ran.
 *
 * The one-blank-tab check is what makes this safe: a window made by dragging a
 * tab out already holds a real page, a window.open() popup already holds a URL,
 * and a session restore holds many tabs. Only a deliberate Cmd+N passes.
 */
export async function cloneIntoWindow(api, state, newWindow) {
  // Restore creates windows of its own. Both this check and the flag's setter
  // are synchronous, so no event can interleave between them. This also
  // ignores a genuine Cmd+N for the length of the restore, which is the right
  // trade: a restore is brief, and one window that did not clone is a far
  // smaller loss than a restored window with a clone dumped on top of it.
  if (state.restoreInProgress) return false;

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
    let newTabs;
    try {
      newTabs = await api.tabs.query({ windowId: newWindow.id });
    } catch (error) {
      // The window can be closed before the service worker is even scheduled
      // to run this, which rejects the gate's very first call. Left alone that
      // escapes into the listener as an unhandled rejection: noise on an
      // expected race. Silent if the window has gone, findable if it has not.
      // The watch is consulted first because a window whose removal has been
      // announced can still answer a query for a moment, and the probe would
      // call that routine close a failure.
      if (!watch.aborted() && (await windowStillOpen(api, newWindow.id))) {
        console.warn("[Tab Boss] clone failed", error);
      }
      return false;
    }
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
      const described = await planFromWindow(api, source.id, watch);
      if (watch.aborted() || described === null) return false;
      const written = await writeTabs(
        api,
        watch,
        newWindow.id,
        described.plan,
        described.groups,
      );
      // The placeholder belongs to a window that no longer exists, so there is
      // nothing to tidy up and nothing safe to call.
      if (watch.aborted()) return false;
      // Removing a window's last tab closes the window. If every source tab
      // was unclonable there is nothing to replace the placeholder with, so
      // leave a plain empty window rather than making the new window vanish.
      if (written.length > 0) {
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

  installAbortTracking(api, state);
}
