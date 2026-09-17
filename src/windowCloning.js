import { TAB_GROUP_ID_NONE, createAbortWatch } from "./state.js";
import { windowStillOpen, writeTabs } from "./tabWriter.js";

// The scheme test lives with the writer that applies it, and is re-exported
// here so importers of windowCloning keep working.
export { isClonableUrl } from "./tabWriter.js";

/**
 * Reads the source window and describes it as a plan the writer can replay.
 *
 * Every call here is against the SOURCE window, so it cannot hurt the target.
 * The watch is still consulted, because there is no point reading a source for
 * a target that has already gone.
 *
 * Returns { plan, groups } or null when the read was abandoned.
 */
export async function planFromWindow(api, sourceId, watch) {
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
    // carries its destination in pendingUrl.
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
 * Creates a new window and writes a plan into it, with every tb-084 abort
 * guard. The plan is produced by `buildPlan`, which receives the target's abort
 * watch: duplicate-window builds it from the focused window (so it can bail if
 * the target dies during the source read); tabset-open just returns a stored
 * plan. One implementation of the tagged new-window write, two callers.
 *
 * Returns true when a window was created — even if the write then aborted or
 * failed — and false only when the window itself could not be created.
 */
export async function writeIntoNewWindow(api, state, buildPlan) {
  let target;
  try {
    target = await api.windows.create({});
  } catch (error) {
    console.warn("[Tab Boss] could not create a window", error);
    return false;
  }

  // Tagged the instant it exists and NOT cleared when this finishes: nothing may
  // ever clone onto a window Tab Boss itself created. Cleared only on close
  // (windows.onRemoved). suppressedWindowIds keeps new tab placement off it.
  state.suppressedWindowIds.add(target.id);
  state.restoredWindowIds.add(target.id);
  const watch = createAbortWatch(state, target.id);
  try {
    const placeholders = await api.tabs.query({ windowId: target.id });
    const described = await buildPlan(watch);
    if (watch.aborted() || described === null) return true;
    const written = await writeTabs(
      api,
      watch,
      target.id,
      described.plan,
      described.groups,
    );
    // The placeholder belongs to a window that has gone; nothing safe to call.
    if (watch.aborted()) return true;
    // Removing a window's last tab closes it. If nothing could be written,
    // leave the blank tab rather than making the window vanish.
    if (written.length > 0 && placeholders.length === 1) {
      await api.tabs.remove(placeholders[0].id);
    }
    return true;
  } catch (error) {
    // The user can close the new window mid-write. Expected race, silent;
    // anything else must be findable.
    if (!watch.aborted() && (await windowStillOpen(api, target.id))) {
      console.warn("[Tab Boss] write into new window failed", error);
    }
    return true;
  } finally {
    state.suppressedWindowIds.delete(target.id);
    state.abortedWindowIds.delete(target.id);
  }
}

/**
 * Explicitly duplicates the user's current window into a brand new one.
 *
 * The user-triggered replacement for auto-clone-on-new-window, which cannot
 * work on ego lite: creating a Space is indistinguishable from Cmd+N (tb-l56).
 * The source is whatever window has focus when the command fires, captured
 * BEFORE the new window is created (windows.create steals focus).
 *
 * Returns true when a window was created, false when there was nothing to copy.
 */
export async function duplicateFocusedWindow(api, state) {
  let source;
  try {
    source = await api.windows.getLastFocused();
  } catch {
    // No open window to copy.
    return false;
  }
  if (!source || source.type !== "normal" || source.incognito) return false;

  return writeIntoNewWindow(api, state, (watch) =>
    planFromWindow(api, source.id, watch),
  );
}
