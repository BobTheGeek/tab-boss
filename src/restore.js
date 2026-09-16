import { SNAPSHOT_VERSION } from "./snapshot.js";
import { newestSnapshot } from "./snapshotStore.js";
import { createAbortWatch } from "./state.js";
import { writeTabs } from "./tabWriter.js";

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
 * Restores the newest snapshot into brand new windows.
 *
 * Never modifies, reorders, or closes a window the user already has open.
 * Returns how many windows were created.
 */
export async function restoreNewest(api, state) {
  const snapshot = await newestSnapshot(api);
  if (snapshot === null || snapshot.version !== SNAPSHOT_VERSION) {
    // Restore must never fail silently: the user pressed a button.
    await flashBadge(api);
    return 0;
  }

  // Set synchronously before the first windows.create, because that fires
  // windows.onCreated and the cloner would otherwise clone every window we
  // make. The cloner's matching check is synchronous too.
  state.restoreInProgress = true;
  let created = 0;
  try {
    await api.action.setBadgeText({ text: "" });
    for (const window of snapshot.windows) {
      const target = await api.windows.create({});
      created += 1;
      state.suppressedWindowIds.add(target.id);
      try {
        const placeholders = await api.tabs.query({ windowId: target.id });
        const watch = createAbortWatch(state, target.id);
        const written = await writeTabs(
          api,
          watch,
          target.id,
          window.tabs,
          window.groups,
        );
        // Removing a window's last tab closes the window. A snapshot window
        // whose tabs were all unclonable must leave a plain empty window
        // rather than vanishing.
        if (written.length > 0 && placeholders.length === 1) {
          await api.tabs.remove(placeholders[0].id);
        }
      } finally {
        state.suppressedWindowIds.delete(target.id);
        state.abortedWindowIds.delete(target.id);
      }
    }
  } catch (error) {
    console.warn("[Tab Boss] restore failed", error);
  } finally {
    state.restoreInProgress = false;
  }
  return created;
}

export function installRestore(api, state) {
  // Manifest V3 requires listeners to register synchronously at the top level.
  api.action.onClicked.addListener(async () => {
    await restoreNewest(api, state);
  });
}
