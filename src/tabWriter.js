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

/** Runs a best-effort browser call whose failure must not stop the write. */
async function ignoreFailure(promise) {
  try {
    await promise;
  } catch {
    // Best effort only.
  }
}

/**
 * Rebuilds the plan's groups in the target window.
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
async function buildGroups(api, watch, targetId, written, groups) {
  const tabIdsByKey = new Map();
  for (const { spec, tab } of written) {
    if (spec.groupKey == null) continue;
    if (!tabIdsByKey.has(spec.groupKey)) tabIdsByKey.set(spec.groupKey, []);
    tabIdsByKey.get(spec.groupKey).push(tab.id);
  }

  const created = [];
  for (const group of groups) {
    const tabIds = tabIdsByKey.get(group.key);
    if (!tabIds || tabIds.length === 0) continue;
    if (watch.aborted()) return created;
    const newGroupId = await api.tabs.group({
      tabIds,
      createProperties: { windowId: targetId },
    });
    if (watch.aborted()) return created;
    await api.tabGroups.update(newGroupId, {
      title: group.title,
      color: group.color,
    });
    created.push({ newGroupId, collapsed: group.collapsed });
  }
  return created;
}

/**
 * Writes a normalised tab plan into one window.
 *
 * Ordering is load-bearing: create, then mute, then group, then activate, then
 * collapse, then discard. Discarding before activating fights the browser,
 * which refuses to discard the active tab, and collapsing before activating
 * fights it too, because it refuses to collapse a group holding the active tab.
 *
 * This is five to twenty sequential calls into one window, and the user may
 * close that window at any await. `watch.aborted()` says the window has gone;
 * it is checked immediately before every single call with no await in the gap,
 * and the write then unwinds silently with whatever it had written. Swallowing
 * the failures and pressing on is what crashed the browser in tb-084.
 *
 * Makes no calls against any window other than `targetId`.
 */
export async function writeTabs(api, watch, targetId, plan, groups) {
  const written = [];
  let skipped = 0;

  for (const spec of plan) {
    if (watch.aborted()) return written;
    if (!isClonableUrl(spec.url)) {
      skipped += 1;
      continue;
    }
    const tab = await api.tabs.create({
      windowId: targetId,
      url: spec.url,
      pinned: spec.pinned,
      active: false,
    });
    written.push({ spec, tab });
  }

  if (skipped > 0 && !watch.aborted()) {
    // Routine: a pinned chrome:// tab would warn every single time. An abort
    // says nothing at all, and the create loop can exit normally on its last
    // entry with the window already gone, so this needs its own check.
    console.log(
      `[Tab Boss] skipped ${skipped} tab(s) the browser will not let an extension reopen`,
    );
  }

  for (const { spec, tab } of written) {
    if (!spec.muted) continue;
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabs.update(tab.id, { muted: true }));
  }

  const built = await buildGroups(api, watch, targetId, written, groups);

  const activeEntry = written.find(({ spec }) => spec.active);
  if (activeEntry) {
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabs.update(activeEntry.tab.id, { active: true }));
  }

  for (const { newGroupId, collapsed } of built) {
    if (!collapsed) continue;
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabGroups.update(newGroupId, { collapsed: true }));
  }

  for (const { tab } of written) {
    if (tab.id === activeEntry?.tab.id) continue;
    if (watch.aborted()) return written;
    await ignoreFailure(api.tabs.discard(tab.id));
  }

  return written;
}
