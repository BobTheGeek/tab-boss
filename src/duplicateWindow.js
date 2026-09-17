import { duplicateFocusedWindow } from "./windowCloning.js";

/** Keyboard command id, matched to the manifest's `commands` entry. */
export const DUPLICATE_COMMAND = "duplicate-window";

/** Context-menu item id. */
export const DUPLICATE_MENU_ID = "tab-boss-duplicate-window";

/** The label shown in the shortcut list and the right-click menu. */
export const DUPLICATE_TITLE = "Duplicate this window";

/**
 * Wires the two explicit triggers for duplicating the current window: a
 * keyboard command and a right-click menu item. Both call the same safe path.
 *
 * There is deliberately NO windows.onCreated involvement. That is the whole
 * point of making this explicit: on ego lite a new Space is indistinguishable
 * from Cmd+N, so nothing that fires on its own can safely decide to clone
 * (tb-l56). Here the user asks by name, so nothing fires on its own.
 */
export function installDuplicateWindow(api, state) {
  // Listeners register synchronously at the top level so Manifest V3 wakes an
  // evicted worker for them.
  api.commands.onCommand.addListener(async (command) => {
    if (command === DUPLICATE_COMMAND) await duplicateFocusedWindow(api, state);
  });

  api.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId === DUPLICATE_MENU_ID) {
      await duplicateFocusedWindow(api, state);
    }
  });

  // contextMenus.create throws on a duplicate id and the worker cold-starts
  // constantly, so the item is (re)created from onInstalled — which does not
  // repeat per worker start — after a removeAll, to be idempotent across
  // reloads and updates.
  api.runtime.onInstalled.addListener(() => {
    api.contextMenus.removeAll(() => {
      api.contextMenus.create({
        id: DUPLICATE_MENU_ID,
        title: DUPLICATE_TITLE,
        contexts: ["page", "action"],
      });
    });
  });
}
