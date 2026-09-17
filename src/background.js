import {
  createState,
  installAbortTracking,
  resolveSourceWindowId,
} from "./state.js";
import { installFocusTracking, seedFocus } from "./focusTracking.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installRestore } from "./restore.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { cloneIntoWindow, installWindowCloning } from "./windowCloning.js";
import { installDuplicateWindow } from "./duplicateWindow.js";
import { installWindowObserver } from "./windowObserver.js";

/**
 * MASTER SWITCH for AUTO-clone-on-new-window, and it stays off.
 *
 * Auto-clone cloned the user's tabs into ~10 windows and ~350 tabs (tb-l56).
 * The cause was ego lite Spaces: a Space presents to the extension API as an
 * ordinary window and ego rebuilds every Space at launch. We ran observe-only
 * for a day, then live-tested on the real browser — and found the wall:
 * CREATING a new Space produces a blank window that grabs focus in ~12ms,
 * identical to Cmd+N in every signal the classifier has. There is no
 * extension-visible signal that tells a new Space from a new window, so no
 * windows.onCreated handler can safely decide to clone. Auto-clone is not
 * fixable on ego lite; this stays false.
 *
 * The user-triggered replacement is `installDuplicateWindow` below: the user
 * asks by name, so there is nothing to detect and no storm to fear. The
 * observer/classifier code is left in the tree, and installed below for its
 * logging only, as the record of what was tried.
 */
const TAB_WRITING_ENABLED = false;

const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installFocusTracking(chrome, state);
installNewTabPlacement(chrome, state);

// Abort tracking — the windows.onRemoved listener that arms the per-window
// abort watch — is needed by anything that writes tabs into a window it
// created. Duplicate-window uses it, so it is installed unconditionally,
// independent of the dead auto-clone switch.
installAbortTracking(chrome, state);

// Duplicate this window: an explicit keyboard command and right-click item.
// The safe replacement for auto-clone. Nothing here fires on a window event.
installDuplicateWindow(chrome, state);

if (TAB_WRITING_ENABLED) {
  // installWindowCloning now installs ONLY the abort tracking (the
  // windows.onRemoved listener that arms the per-window abort watch). Both the
  // observer-driven clone and restore depend on it. Cloning itself is driven
  // by the observer below.
  installWindowCloning(chrome, state);
  installRestore(chrome, state);
}

// The window observer is the single windows.onCreated brain. It classifies
// every new window and writes the verdict to its own storage key — always, so
// the log keeps working as a black box even with writing on. When writing is
// enabled it is also handed the clone action: on a "would clone" verdict it
// hands the window to the cloner, capturing the clone source synchronously at
// create time (the focus history moves during the classifier's focus-grace
// wait, so resolving it later would pick the wrong source).
installWindowObserver(chrome, {
  resolveCloneSource: TAB_WRITING_ENABLED
    ? (win) => resolveSourceWindowId(state, win.id)
    : undefined,
  performClone: TAB_WRITING_ENABLED
    ? (win, sourceId) => cloneIntoWindow(chrome, state, win, sourceId)
    : undefined,
});

// The scheduler takes the shared state so a capture can refuse while a restore
// is halfway through building windows. It only ever reads tabs, so it stays on.
void installSnapshotScheduler(chrome, state);

void seedFocus(chrome, state);
