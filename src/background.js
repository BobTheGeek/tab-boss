import { createState, installAbortTracking } from "./state.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { installDuplicateWindow } from "./duplicateWindow.js";
import { handlePopupMessage } from "./popupService.js";

/**
 * The service worker. It wires the four live features and nothing else.
 *
 * Auto-clone-on-new-window used to live here too. It cloned the user's tabs
 * into ~10 windows and ~350 tabs (tb-l56), because on ego lite a new Space is
 * indistinguishable from Cmd+N and every Space is rebuilt at launch. It was
 * proven unfixable on the real browser and removed; its user-triggered
 * replacement is `installDuplicateWindow` below. The window observer, the
 * classifier, and focus tracking went with it.
 */
const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installNewTabPlacement(chrome, state);

// Abort tracking — the windows.onRemoved listener that arms the per-window
// abort watch — is needed by anything that writes tabs into a window it
// created: duplicate-window, tabset-open, and restore.
installAbortTracking(chrome, state);

// Duplicate this window: an explicit keyboard command and right-click item.
installDuplicateWindow(chrome, state);

// The popup sends capture / open / restore messages. Restore is reached this
// way now, not through action.onClicked — a default_popup suppresses that
// event. Returning true keeps the channel open for the async reply, as
// Manifest V3 requires.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handlePopupMessage(chrome, state, message, () => Date.now()).then(sendResponse);
  return true;
});

// The scheduler takes the shared state so a capture can refuse while a restore
// is halfway through building windows. It only ever reads tabs, so it stays on.
void installSnapshotScheduler(chrome, state);
