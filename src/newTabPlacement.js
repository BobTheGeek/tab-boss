/**
 * Requirement 1: every new tab lands at the bottom of the tab strip.
 *
 * This deliberately overrides Chromium's "open next to the parent tab"
 * behaviour, so a Cmd+clicked link goes to the bottom too.
 *
 * Index -1 means "last position". Chromium refuses to place an unpinned tab
 * above a pinned one, so pinned tabs need no special case here.
 */
export function installNewTabPlacement(api, state) {
  api.tabs.onCreated.addListener(async (tab) => {
    if (state.suppressedWindowIds.has(tab.windowId)) return;
    try {
      const win = await api.windows.get(tab.windowId);
      if (win.type !== "normal") return;
      await api.tabs.move(tab.id, { index: -1 });
    } catch {
      // The tab or window can close between the event and the move.
    }
  });
}
