import { createState } from "./state.js";
import { installFocusTracking, seedFocus } from "./focusTracking.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installRestore } from "./restore.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { installWindowCloning } from "./windowCloning.js";

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

/**
 * Diagnostic for tb-dup. Logs what every newly created window actually looks
 * like, and what the cloner WOULD have done, without writing anything.
 *
 * This exists because the gate and the failure disagree about the window's
 * type, and no fake can tell us what ego lite really reports. Remove it once
 * tb-dup is understood.
 */
function installWindowDiagnostic(api) {
  api.windows.onCreated.addListener(async (win) => {
    try {
      const tabs = await api.tabs.query({ windowId: win.id });
      const now = await api.windows.get(win.id);
      console.log(
        "[Tab Boss dx] window created",
        JSON.stringify({
          id: win.id,
          typeAtCreate: win.type,
          typeNow: now.type,
          incognito: win.incognito,
          state: now.state,
          tabCount: tabs.length,
          urls: tabs.map((t) => t.url || t.pendingUrl || "").slice(0, 5),
        }),
      );
    } catch (error) {
      console.log("[Tab Boss dx] window vanished before inspection", error);
    }
  });

  api.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId == null || windowId < 0) return;
    try {
      const win = await api.windows.get(windowId);
      console.log(
        "[Tab Boss dx] focus",
        JSON.stringify({ id: win.id, type: win.type }),
      );
    } catch {
      // Window closed between the event and the lookup.
    }
  });
}

const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installFocusTracking(chrome, state);
installNewTabPlacement(chrome, state);

if (TAB_WRITING_ENABLED) {
  installWindowCloning(chrome, state);
  installRestore(chrome, state);
}

installWindowDiagnostic(chrome);

// The scheduler takes the shared state so a capture can refuse while a restore
// is halfway through building windows. It only ever reads tabs, so it stays on.
void installSnapshotScheduler(chrome, state);

void seedFocus(chrome, state);
