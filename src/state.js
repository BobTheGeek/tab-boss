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
 */
export function createState() {
  return {
    previousWindowId: null,
    currentWindowId: null,
    suppressedWindowIds: new Set(),
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
