/** The id Chromium reports when focus leaves the browser entirely. */
export const WINDOW_ID_NONE = -1;

/** The groupId Chromium reports for a tab that belongs to no group. */
export const TAB_GROUP_ID_NONE = -1;

/**
 * Cross-module state shared by every Tab Boss feature.
 *
 * `previousWindowId` / `currentWindowId` together form a two-deep focus
 * history, which is all the window cloner needs to find its source.
 * `suppressedWindowIds` holds windows the cloner is currently filling, so new
 * tab placement stays out of its way.
 * `abortedWindowIds` holds the subset of those the clone has found to be gone,
 * whether from windows.onRemoved or from a call failing in a way that proves
 * it. It is only ever written for a window that is currently an in-flight
 * clone target, and the clone clears its own id when it unwinds, so it cannot
 * grow without bound.
 * `restoreInProgress` is true while restore is creating windows. Restore calls
 * windows.create, which fires windows.onCreated, which is what the cloner
 * listens for — without this the cloner would clone every restored window.
 * suppressedWindowIds cannot do the job: the id is not known until create
 * resolves, and onCreated can fire first. It is deliberately a single flag and
 * not a count: a second toolbar click during a restore does nothing, so the
 * flag has exactly one owner and cannot be lowered out from under it.
 * It also suppresses a genuine Cmd+N for the length of the restore. That is
 * the right trade — a restore is brief, and one window that did not clone is a
 * far smaller loss than a restored window with a clone dumped on top of it.
 */
export function createState() {
  return {
    previousWindowId: null,
    currentWindowId: null,
    suppressedWindowIds: new Set(),
    abortedWindowIds: new Set(),
    restoreInProgress: false,
  };
}

export function recordFocus(state, windowId) {
  if (windowId == null || windowId === WINDOW_ID_NONE) return;
  if (windowId === state.currentWindowId) return;
  state.previousWindowId = state.currentWindowId;
  state.currentWindowId = windowId;
}

/**
 * Chromium does not promise whether windows.onCreated or
 * windows.onFocusChanged fires first for a new window, so the source is
 * derived rather than read from one field. Either ordering lands on the window
 * the user actually came from.
 */
export function resolveSourceWindowId(state, newWindowId) {
  return state.currentWindowId !== newWindowId
    ? state.currentWindowId
    : state.previousWindowId;
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
