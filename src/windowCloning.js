import { resolveSourceWindowId } from "./state.js";

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
 * Distinguishes an expected race from an unexpected failure. If the target
 * window has gone, the user closed it mid-clone and every pending call was
 * always going to fail — that is not worth logging.
 */
async function windowStillOpen(api, windowId) {
  try {
    await api.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

async function copyTabs(api, sourceId, targetId) {
  // Replaced in Task 5.
  await api.tabs.create({ windowId: targetId, url: "about:blank" });
}

/**
 * Requirement 2. Returns true when a clone actually ran.
 *
 * The one-blank-tab check is what makes this safe: a window made by dragging a
 * tab out already holds a real page, a window.open() popup already holds a URL,
 * and a session restore holds many tabs. Only a deliberate Cmd+N passes.
 */
export async function cloneIntoWindow(api, state, newWindow) {
  if (newWindow.incognito) return false;
  if (newWindow.type !== "normal") return false;

  const newTabs = await api.tabs.query({ windowId: newWindow.id });
  if (newTabs.length !== 1) return false;
  if (!isBlankTab(newTabs[0])) return false;
  const placeholder = newTabs[0];

  const sourceId = resolveSourceWindowId(state, newWindow.id);
  if (sourceId == null || sourceId === newWindow.id) return false;

  let source;
  try {
    source = await api.windows.get(sourceId);
  } catch {
    return false;
  }
  if (!isCloneSource(source)) return false;

  state.suppressedWindowIds.add(newWindow.id);
  try {
    await copyTabs(api, source.id, newWindow.id);
    await api.tabs.remove(placeholder.id);
  } catch (error) {
    // The user can close the new window mid-clone, which fails every pending
    // call. That is an expected race and stays silent. Anything else is a real
    // failure and must be findable in the service worker console.
    if (await windowStillOpen(api, newWindow.id)) {
      console.warn("[Tab Boss] clone failed", error);
    }
  } finally {
    state.suppressedWindowIds.delete(newWindow.id);
  }
  return true;
}

export function installWindowCloning(api, state) {
  api.windows.onCreated.addListener(
    async (win) => {
      await cloneIntoWindow(api, state, win);
    },
    { windowTypes: ["normal"] },
  );
}
