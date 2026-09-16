import { createState } from "./state.js";
import { installFocusTracking, seedFocus } from "./focusTracking.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installRestore } from "./restore.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { installWindowCloning } from "./windowCloning.js";
import { installWindowObserver } from "./windowObserver.js";

/**
 * TEMPORARY KILL SWITCH — see tb-dup.
 *
 * Tab Boss is duplicating the user's tabs, pinned ones included, into a window
 * that already holds them. Reported after clicking a pinned tab, with no
 * browser restart involved.
 *
 * The service worker console showed, twice:
 *
 *   [Tab Boss] skipped 1 tab(s) the browser will not let an extension reopen
 *   [Tab Boss] could not recreate a tab group
 *     Error: Tabs can only be moved to and from normal windows.
 *
 * Both come from tabWriter, so a write ran. The group error says the target is
 * not a normal window — yet the cloner's gate rejects any window whose type is
 * not "normal". Either the type changes between the gate and the write, or the
 * window reports "normal" at creation and becomes something else.
 *
 * Two features write tabs: the window cloner and restore. Until the cause is
 * known it is not certain which one ran, so BOTH are off. Nothing left running
 * can create a tab in a window that already has content.
 *
 * Still on, because neither can write tabs:
 *   - new tab placement, which only moves a newly created tab to the end
 *   - the snapshot scheduler, which only reads
 *
 * Do not turn these back on until a test reproduces the duplication.
 */
const TAB_WRITING_ENABLED = false;

const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installFocusTracking(chrome, state);
installNewTabPlacement(chrome, state);

if (TAB_WRITING_ENABLED) {
  installWindowCloning(chrome, state);
  installRestore(chrome, state);
}

// Outside the kill switch on purpose. The window observer is the instrument
// that has to run WHILE writing is off: it decides what the cloner would have
// done with each new window and writes that verdict to its own storage key,
// and it is the only thing that can tell us whether the ego lite Spaces
// hypothesis for tb-l56 is right. It replaces the ad-hoc diagnostic that used
// to live in this file. It never writes a tab or a window.
installWindowObserver(chrome);

// The scheduler takes the shared state so a capture can refuse while a restore
// is halfway through building windows. It only ever reads tabs, so it stays on.
void installSnapshotScheduler(chrome, state);

void seedFocus(chrome, state);
