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

/**
 * Distinguishes an expected race from an unexpected failure. If the window has
 * gone, the user closed it mid-write and every pending call was always going to
 * fail — that is not worth logging.
 */
export async function windowStillOpen(api, windowId) {
  try {
    await api.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
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
 * A group that fails while the window is open is one bad group, not a dead
 * window: it is skipped and the write carries on, because a user who loses one
 * group's title is far better off than a user who loses every tab.
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
  // One group vanishing is worth a line. A user closing the window while four
  // groups are pending is not worth four.
  let warned = false;

  for (const group of groups) {
    const tabIds = tabIdsByKey.get(group.key);
    if (!tabIds || tabIds.length === 0) continue;
    if (watch.aborted()) return created;
    try {
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
      // The window is fine, so this really was just one bad group. The user
      // keeps their tabs; only this group is missing.
      if (!warned) {
        warned = true;
        console.warn("[Tab Boss] could not recreate a tab group", error);
      }
    }
  }
  return created;
}

/**
 * One tab to write. `groupKey` is a number matching some `groups[].key`, or
 * `null` for an ungrouped tab. It must be `null` and not `0` or `-1`: the
 * grouping check is `spec.groupKey == null`, so any other value is treated as a
 * real key and the tab is grouped.
 *
 * @typedef {object} TabSpec
 * @property {string} url          Absolute URL. One an extension may not reopen
 *                                 is skipped — see `isClonableUrl`.
 * @property {boolean} pinned
 * @property {boolean} muted
 * @property {boolean} active      At most one spec in a plan should set this.
 * @property {number|null} groupKey
 */

/**
 * One group to rebuild. `key` is an opaque identifier private to a single
 * `writeTabs` call — NOT a Chromium group id. It is compared to `spec.groupKey`
 * with `Map` lookup, so the types must match exactly: numeric keys against
 * numeric `groupKey`s. String keys against numeric ones silently match nothing.
 *
 * @typedef {object} GroupSpec
 * @property {number} key
 * @property {string} title
 * @property {string} color        A chrome.tabGroups.Color value.
 * @property {boolean} collapsed
 */

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
 *
 * `plan` and `groups` are coupled: every `plan[].groupKey` that is not `null`
 * should name a `groups[].key`. Neither direction is validated, and both
 * mismatches fail silently rather than throwing:
 *  - a `groupKey` naming no group leaves that tab ungrouped;
 *  - a group whose key matches no *written* tab is dropped without a call. That
 *    is deliberate — a group whose tabs were all unclonable has nothing to hold,
 *    and Chromium rejects an empty `tabs.group` — but it is also what a caller
 *    sees when its keys simply do not line up, with no error and no log.
 *
 * @param {object} api            The chrome API.
 * @param {{aborted: () => boolean, mark: () => void}} watch  See createAbortWatch.
 * @param {number} targetId       The window to write into. The only one touched.
 * @param {TabSpec[]} plan        Written in order, so index 0 lands leftmost.
 * @param {GroupSpec[]} groups    Rebuilt in order. May be empty.
 * @returns {Promise<Array<{spec: TabSpec, tab: object}>>} One entry per tab
 *   actually created, in plan order. Short of `plan.length` when tabs were
 *   skipped as unclonable, or when the write unwound on an abort.
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
