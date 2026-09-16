import { WINDOW_ID_NONE, recordFocus } from "./state.js";

function isCloneSource(win) {
  return win.type === "normal" && !win.incognito;
}

/**
 * Keeps state's focus history current. Only normal, non-incognito windows are
 * recorded, because only those are ever used as a clone source.
 */
export function installFocusTracking(api, state) {
  api.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId == null || windowId === WINDOW_ID_NONE) return;
    let win;
    try {
      win = await api.windows.get(windowId);
    } catch {
      // The window closed between the event and the lookup.
      return;
    }
    if (!isCloneSource(win)) return;
    recordFocus(state, windowId);
  });
}

/**
 * Primes the focus history when the service worker starts, so the very first
 * Cmd+N after a worker eviction still has a source to clone from.
 */
export async function seedFocus(api, state) {
  let win;
  try {
    win = await api.windows.getLastFocused();
  } catch {
    // No windows open yet.
    return;
  }
  if (!isCloneSource(win)) return;
  recordFocus(state, win.id);
}
