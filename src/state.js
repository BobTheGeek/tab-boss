/** The groupId Chromium reports for a tab that belongs to no group. */
export const TAB_GROUP_ID_NONE = -1;

/**
 * Cross-module state shared by every feature that writes tabs into a window it
 * created — duplicate-window, tabset-open, and restore.
 *
 * `suppressedWindowIds` holds windows a writer is currently filling, so new tab
 * placement stays out of its way.
 * `abortedWindowIds` holds the subset a writer has found to be gone, whether
 * from windows.onRemoved or from a call failing in a way that proves it. It is
 * only ever written for a window that is currently an in-flight write target,
 * and the writer clears its own id when it unwinds, so it cannot grow without
 * bound.
 * `restoreInProgress` is true while restore is creating windows; a snapshot
 * capture refuses while it is set, so a half-built restore is never stored.
 * `restoredWindowIds` holds every window Tab Boss itself created (restore,
 * duplicate, tabset-open). A window Tab Boss made is never a clone target, and
 * this outlives `restoreInProgress` — it is tagged synchronously as each window
 * is created and cleared only when the window itself closes (tb-l56).
 */
export function createState() {
  return {
    suppressedWindowIds: new Set(),
    abortedWindowIds: new Set(),
    restoreInProgress: false,
    restoredWindowIds: new Set(),
  };
}

/**
 * Registers the one event-driven writer of `state.abortedWindowIds`.
 *
 * This lives beside `createAbortWatch` because the two are halves of the same
 * mechanism: without this listener every `watch.aborted()` in the project
 * reads false forever and the tb-084 crash protection is silently gone. It is
 * installed once from background.js, and covers every writer that builds an
 * abort watch — duplicate-window, tabset-open, and restore.
 *
 * Installing it twice is harmless: the guard is a pure read and `Set.add` is
 * idempotent, so a second delivery of the same id changes nothing.
 */
export function installAbortTracking(api, state) {
  api.windows.onRemoved.addListener((windowId) => {
    // A window restore created is never a clone target; once it is gone we can
    // forget it. Cleared here to bound `restoredWindowIds` over a long session
    // with many restores. Chromium does not reuse window ids within a session,
    // so this can never drop a tag a live window still needs.
    state.restoredWindowIds.delete(windowId);
    // Only in-flight write targets are recorded. Remembering every window the
    // user ever closed would leak for the life of the service worker, and each
    // writer clears its own id as it unwinds.
    if (!state.suppressedWindowIds.has(windowId)) return;
    state.abortedWindowIds.add(windowId);
  });
}

/**
 * A one-window view of the abort set, so callers ask "has my window gone?"
 * rather than reaching into shared state. `mark()` is for a caller that learns
 * the window is gone from a failed call rather than from windows.onRemoved.
 *
 * `aborted()` is checked before every call into the window. `mark()` exists
 * because the news can reach us two ways: windows.onRemoved, or a rejection
 * that proves the window has gone before the event arrives. Chromium does not
 * promise which of those two messages lands first, so whichever wins marks the
 * window and every later phase stops.
 */
export function createAbortWatch(state, windowId) {
  return {
    aborted: () => state.abortedWindowIds.has(windowId),
    mark: () => state.abortedWindowIds.add(windowId),
  };
}
