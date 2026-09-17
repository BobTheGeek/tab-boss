import { createState, resolveSourceWindowId } from "./state.js";
import { installFocusTracking, seedFocus } from "./focusTracking.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installRestore } from "./restore.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { cloneIntoWindow, installWindowCloning } from "./windowCloning.js";
import { installWindowObserver } from "./windowObserver.js";

/**
 * MASTER SWITCH for everything that writes tabs.
 *
 * History: Tab Boss cloned the user's tabs into ~10 windows and ~350 tabs
 * (tb-l56). The cause was ego lite Spaces: a Space presents to the extension
 * API as an ordinary window and ego rebuilds every Space at launch, so a
 * restart replays a storm of windows.onCreated events indistinguishable, to
 * the old gate, from pressing Cmd+N. The extension ran observe-only for a day;
 * the log, checked against ground truth on the real browser, showed the
 * discriminator: a genuine Cmd+N grabs focus within ~11ms, a mid-session Space
 * never takes focus, and a restart-storm Space (which DOES focus fast) is
 * caught by the startup quiet period and the burst counter. Focus and the
 * quiet period are both load-bearing and cover different cases.
 *
 * So cloning is back on, but behind the classifier. The window observer is the
 * single windows.onCreated handler; when it classifies a window as a deliberate
 * Cmd+N it hands it to the cloner, which runs its own gate and every tb-084
 * abort guard on top. Set this to false and the extension returns to
 * observe-only: it classifies and logs, and writes nothing. It remains the one
 * lever that disables all tab writing.
 */
const TAB_WRITING_ENABLED = false;

const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installFocusTracking(chrome, state);
installNewTabPlacement(chrome, state);

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
