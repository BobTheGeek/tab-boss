import { isBlankTab } from "./windowCloning.js";

/**
 * Pure decision logic for "did a human just press Cmd+N?".
 *
 * Nothing in this file touches the browser. It is handed an observation and
 * returns a verdict plus every reason behind it. That is deliberate: this is
 * the only part of the window-classification problem that can be tested
 * without the user's actual browser, so all of the judgement lives here and
 * `windowObserver.js` only gathers signals and writes the answer down.
 *
 * Why this exists at all: on ego lite a **Space** is an ordinary Chromium
 * window as far as the extension API is concerned, and every Space is rebuilt
 * at launch. So `windows.onCreated` fires a storm of events that look exactly
 * like the user pressing Cmd+N ten times. The old gate — one window, one blank
 * tab — cannot tell the two apart, and cloning into each of them produced ten
 * windows and roughly 350 duplicate tabs on the user's real machine.
 *
 * The rule therefore FAILS CLOSED. Every condition must be affirmatively
 * satisfied by a signal we actually have; anything missing, malformed or
 * ambiguous votes `false`. Missing a clone costs the user one Cmd+N. Guessing
 * wrong cost them an afternoon.
 */

/**
 * How long after the browser starts every new window is assumed to be a
 * session or Space restore rather than a person. This is the constant that
 * kills the restore storm, and the one most likely to need tuning from the
 * log: raise it if restored Spaces are still being classified as Cmd+N.
 *
 * It is measured against `msSinceSessionStart`, which the observer derives
 * from a marker in `chrome.storage.session`. NOT against
 * `meta.browserStartedAt`: that lives in `storage.local` and therefore
 * survives a restart, so a Space storm that beat `runtime.onStartup` would
 * read the PREVIOUS session's timestamp, come out as hours, and leave this
 * condition inert at exactly the moment it exists to fire. The browser clears
 * session storage on shutdown, so the reset is a property of the storage area
 * rather than a race we have to win — the same fix the snapshot scheduler's
 * loss counter already got, for the same reason.
 */
export const STARTUP_QUIET_MS = 90_000;

/**
 * How quickly a window must take focus to count as deliberate. A Cmd+N window
 * is focused by the browser as it opens; a window being rebuilt in the
 * background behind the Space the user is looking at is not.
 *
 * The measurement is signed, because Chromium does not promise whether
 * `windows.onCreated` or `windows.onFocusChanged` is delivered first. A focus
 * that arrives just BEFORE the create event is still the same event in the
 * real world, so the test is on the magnitude.
 */
export const FOCUS_GRACE_MS = 400;

/** The width of the burst counter's window. */
export const BURST_WINDOW_MS = 2_000;

/**
 * How many windows may be created inside `BURST_WINDOW_MS` and still count as
 * a person. One. A burst is a machine.
 */
export const MAX_WINDOWS_IN_BURST = 1;

/** Reasons are short, stable, greppable strings. `no:` prefixes a veto. */
const ok = (reason) => `ok:${reason}`;
const no = (reason) => `no:${reason}`;

/**
 * @param {object} observation - see `windowObserver.js` for the full shape.
 * @returns {{ wouldClone: boolean, reasons: string[] }}
 *
 * Every condition is evaluated, never short-circuited, so the log records why
 * a window passed as well as why it failed. When we come to read a day of
 * these, "this Space restore was rejected on four counts, and would have been
 * rejected on three of them without the quiet period" is the useful sentence.
 */
export function classifyWindow(observation) {
  if (observation === null || typeof observation !== "object") {
    return { wouldClone: false, reasons: [no("no-observation")] };
  }

  const reasons = [];
  let wouldClone = true;
  const veto = (reason) => {
    reasons.push(no(reason));
    wouldClone = false;
  };
  const pass = (reason) => reasons.push(ok(reason));

  // 1. An ordinary, non-private window. A popup, devtools window or app window
  //    is never a Cmd+N, and an incognito window must never be cloned into.
  if (observation.incognito !== false) veto("incognito-or-unknown");
  else if (observation.type !== "normal") veto(`type=${observation.type}`);
  else pass("normal-window");

  // 2. Exactly one tab, and it is blank. Blankness is decided by the same
  //    function the cloner uses, so the two can never drift apart.
  const tabs = Array.isArray(observation.tabs) ? observation.tabs : null;
  if (tabs === null || !Number.isInteger(observation.tabCount)) {
    veto("tabs-unknown");
  } else if (observation.tabCount !== 1) {
    veto(`tabCount=${observation.tabCount}`);
  } else if (tabs.length !== 1 || !isBlankTab(tabs[0])) {
    // tabs is capped to the first few URLs, so a tabCount of 1 always has its
    // one tab present here. A mismatch means the record is malformed.
    veto("tab-not-blank");
  } else {
    pass("one-blank-tab");
  }

  // 3. Well clear of the start of THIS browser session. This is what kills the
  //    Space-restore storm. An unknown start time is a veto, not a pass:
  //    `null` here means we do not know whether the browser just launched, and
  //    "do not know" resolves to "do not clone".
  const sinceStart = observation.msSinceSessionStart;
  if (!Number.isFinite(sinceStart)) veto("sessionStart-unknown");
  else if (sinceStart <= STARTUP_QUIET_MS) veto(`startup-quiet=${sinceStart}ms`);
  else pass(`sinceSessionStart=${sinceStart}ms`);

  // 4. Not part of a burst. The counter includes this window, so a lone
  //    window reads 1. Anything higher is the browser opening windows faster
  //    than a person can press a key twice.
  const burst = observation.windowsCreatedInLastTwoSeconds;
  if (!Number.isInteger(burst) || burst < 1) veto("burst-unknown");
  else if (burst > MAX_WINDOWS_IN_BURST) veto(`burst=${burst}`);
  else pass("no-burst");

  // 5. It took focus, promptly. A genuine Cmd+N window always does.
  const focusedIn = observation.becameFocusedWithinMs;
  if (!Number.isFinite(focusedIn)) veto("never-focused");
  else if (Math.abs(focusedIn) > FOCUS_GRACE_MS) {
    veto(`focused-late=${focusedIn}ms`);
  } else pass(`focused-in=${focusedIn}ms`);

  return { wouldClone, reasons };
}
