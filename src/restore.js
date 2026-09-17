import { SNAPSHOT_VERSION } from "./snapshot.js";
import { newestSnapshot } from "./snapshotStore.js";
import { createAbortWatch, installAbortTracking } from "./state.js";
import { windowStillOpen, writeTabs } from "./tabWriter.js";

/** How long the failure badge stays up. */
export const BADGE_MS = 3000;

async function flashBadge(api) {
  await api.action.setBadgeText({ text: "!" });
  // Best effort: an evicted service worker may leave the badge up. A lingering
  // "!" is harmless and the next successful restore clears it, so this does
  // not warrant an alarm.
  setTimeout(() => {
    void api.action.setBadgeText({ text: "" });
  }, BADGE_MS);
}

/**
 * Restores one snapshot window into one brand new window.
 *
 * Returns 1 when a window was created, 0 when it could not be. One window
 * failing never stops the others: a user who gets three of their four windows
 * back is far better off than one who gets none.
 */
async function restoreWindow(api, state, snapshotWindow) {
  let target;
  try {
    target = await api.windows.create({});
  } catch (error) {
    // There is no window and so no watch yet, which means there is nothing to
    // probe and no race to stay quiet about. A browser that will not open a
    // window is a real failure, not a user closing something.
    console.warn("[Tab Boss] restore failed", error);
    return 0;
  }

  state.suppressedWindowIds.add(target.id);
  // Tagged synchronously, the instant the window exists, and deliberately NOT
  // removed when this restore ends. Cloning is decided ~400ms after
  // windows.onCreated; a brief restore can clear restoreInProgress before that
  // decision runs, so the flag alone cannot protect a window whose clone
  // verdict is still pending. This tag outlives the flag and is cleared only
  // when the window itself closes (tb-l56 restore-race).
  state.restoredWindowIds.add(target.id);
  const watch = createAbortWatch(state, target.id);
  try {
    const placeholders = await api.tabs.query({ windowId: target.id });
    const written = await writeTabs(
      api,
      watch,
      target.id,
      snapshotWindow.tabs,
      snapshotWindow.groups,
    );
    // The placeholder belongs to a window that no longer exists, so there is
    // nothing to tidy up and nothing safe to call. writeTabs unwinds on an
    // abort and returns what it had already written, so a non-empty result is
    // NOT evidence the window survived — only the watch is.
    if (watch.aborted()) return 1;
    // Removing a window's last tab closes the window. A snapshot window whose
    // tabs were all unclonable must leave a plain empty window rather than
    // vanishing. The count check keeps us off a window that opened with
    // something other than the single blank tab we expect to own.
    if (written.length > 0 && placeholders.length === 1) {
      await api.tabs.remove(placeholders[0].id);
    }
  } catch (error) {
    // The user can close a restored window mid-write, which fails every
    // pending call. A rejection can be the first news of that, arriving ahead
    // of windows.onRemoved — an ordering Chromium does not promise. That is an
    // expected race and stays silent; anything else must be findable.
    if (!watch.aborted() && (await windowStillOpen(api, target.id))) {
      console.warn("[Tab Boss] restore failed", error);
    }
  } finally {
    state.suppressedWindowIds.delete(target.id);
    state.abortedWindowIds.delete(target.id);
  }
  return 1;
}

/**
 * Restores the newest snapshot into brand new windows.
 *
 * Never modifies, reorders, or closes a window the user already has open.
 * Returns how many windows were created.
 */
export async function restoreNewest(api, state) {
  // A second toolbar click must do nothing at all. Letting it run would lower
  // the guard under the restore already going: both would set the flag, and
  // whichever finished first would clear it in its finally while the other was
  // still creating windows. Every window the survivor made after that would
  // fire windows.onCreated with the guard down and get the user's focused
  // window cloned in on top of its restored tabs. Returning early also stops
  // the duplicate windows a counter would happily let through.
  //
  // The check and the assignment are adjacent synchronous statements. That is
  // load-bearing: with the assignment left after the snapshot read, two clicks
  // landing during that read would both get past the check.
  if (state.restoreInProgress) return 0;
  // Set before the first windows.create, because that fires windows.onCreated
  // and the cloner would otherwise clone every window we make. The cloner's
  // matching check is synchronous too, so no event can interleave.
  state.restoreInProgress = true;

  let created = 0;
  try {
    const snapshot = await newestSnapshot(api);
    // `windows` is checked as well as `version`, because a corrupted profile is
    // one of the three scenarios this feature exists for and the store only
    // validates that the snapshots value is an array. A stored `{version: 1}`
    // used to reach the loop below and throw "snapshot.windows is not
    // iterable" out of the action.onClicked listener as an unhandled
    // rejection: no window, no badge, and an icon the user clicks in vain.
    if (
      snapshot === null ||
      snapshot.version !== SNAPSHOT_VERSION ||
      !Array.isArray(snapshot.windows)
    ) {
      // Restore must never fail silently: the user pressed a button.
      await flashBadge(api);
      return 0;
    }

    try {
      await api.action.setBadgeText({ text: "" });
    } catch {
      // Best effort: a badge that will not clear must not stop a restore.
    }

    try {
      for (const snapshotWindow of snapshot.windows) {
        created += await restoreWindow(api, state, snapshotWindow);
      }
    } catch (error) {
      // restoreWindow already absorbs the failures it can name, so reaching
      // here means something unanticipated broke. Whatever it was, an
      // exception escaping into the action.onClicked listener would leave the
      // user clicking an icon that does nothing, which is the one outcome this
      // feature may not have. Windows already restored are kept.
      console.warn("[Tab Boss] restore failed", error);
      await flashBadge(api);
    }
  } finally {
    state.restoreInProgress = false;
  }
  return created;
}

/**
 * NOT wired in production. The toolbar action now opens a popup
 * (manifest `default_popup`), which suppresses `action.onClicked`, so restore
 * is triggered by the popup's "Restore last backup" button — a message that
 * reaches `restoreNewest` through `handlePopupMessage`. This installer is
 * retained only so its `test/restore.test.js` cases can drive `restoreNewest`
 * and its abort tracking through the onClicked path. If restore ever needs a
 * production trigger again, wire this from `background.js`; until then, do not
 * mistake its green tests for a live code path.
 */
export function installRestore(api, state) {
  // Manifest V3 requires listeners to register synchronously at the top level.
  api.action.onClicked.addListener(async () => {
    await restoreNewest(api, state);
  });

  // Restore owns its own crash protection. The abort watch above is only armed
  // by this listener, and leaving another feature's installer to register it
  // meant restore's tb-084 protection could be removed without a single test
  // noticing. Registering it twice is harmless.
  installAbortTracking(api, state);
}
