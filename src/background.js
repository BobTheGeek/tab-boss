import { createState } from "./state.js";
import { installFocusTracking, seedFocus } from "./focusTracking.js";
import { installNewTabPlacement } from "./newTabPlacement.js";
import { installRestore } from "./restore.js";
import { installSnapshotScheduler } from "./snapshotScheduler.js";
import { installWindowCloning } from "./windowCloning.js";

const state = createState();

// Manifest V3 requires listeners to register synchronously at the top level,
// otherwise an evicted service worker will not be woken for the event.
installFocusTracking(chrome, state);
installNewTabPlacement(chrome, state);
installWindowCloning(chrome, state);
installSnapshotScheduler(chrome);
installRestore(chrome, state);

void seedFocus(chrome, state);
