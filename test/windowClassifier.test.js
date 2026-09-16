import test from "node:test";
import assert from "node:assert/strict";
import {
  BURST_WINDOW_MS,
  FOCUS_GRACE_MS,
  MAX_WINDOWS_IN_BURST,
  STARTUP_QUIET_MS,
  classifyWindow,
} from "../src/windowClassifier.js";

/**
 * A window that satisfies all five conditions. Every test below starts here
 * and breaks exactly one thing, so a test that fails names its own cause.
 */
const cmdN = (overrides = {}) => ({
  type: "normal",
  incognito: false,
  tabCount: 1,
  tabs: [{ url: "chrome://newtab/" }],
  msSinceSessionStart: STARTUP_QUIET_MS + 60_000,
  windowsCreatedInLastTwoSeconds: 1,
  becameFocusedWithinMs: 40,
  ...overrides,
});

/** Asserts a verdict of false carrying a reason that starts with `prefix`. */
function assertVetoedBy(observation, prefix) {
  const { wouldClone, reasons } = classifyWindow(observation);
  assert.equal(wouldClone, false, `expected a veto, got ${reasons.join(" ")}`);
  assert.ok(
    reasons.some((reason) => reason.startsWith(`no:${prefix}`)),
    `expected a "no:${prefix}" reason, got ${reasons.join(" ")}`,
  );
}

test("a genuine Cmd+N window would be cloned", () => {
  const { wouldClone, reasons } = classifyWindow(cmdN());
  assert.equal(wouldClone, true, reasons.join(" "));
});

test("a yes records why, not just that", () => {
  const { reasons } = classifyWindow(cmdN());
  assert.deepEqual(reasons, [
    "ok:normal-window",
    "ok:one-blank-tab",
    `ok:sinceSessionStart=${STARTUP_QUIET_MS + 60_000}ms`,
    "ok:no-burst",
    "ok:focused-in=40ms",
  ]);
});

// ---------------------------------------------------------------------------
// Each of the five conditions, independently, vetoes.
// ---------------------------------------------------------------------------

test("1. an incognito window is never cloned", () => {
  assertVetoedBy(cmdN({ incognito: true }), "incognito");
});

test("1. a window that is not type normal is never cloned", () => {
  assertVetoedBy(cmdN({ type: "popup" }), "type=popup");
  assertVetoedBy(cmdN({ type: "app" }), "type=app");
  assertVetoedBy(cmdN({ type: "devtools" }), "type=devtools");
});

test("2. a window holding more than one tab is never cloned", () => {
  assertVetoedBy(
    cmdN({ tabCount: 2, tabs: [{ url: "" }, { url: "https://a.test/" }] }),
    "tabCount=2",
  );
});

test("2. a window holding one real page is never cloned", () => {
  assertVetoedBy(
    cmdN({ tabs: [{ url: "https://example.com/" }] }),
    "tab-not-blank",
  );
});

test("2. every blank form the cloner accepts is accepted here too", () => {
  for (const url of ["", "about:blank", "chrome://newtab", "ego://newtab/x"]) {
    assert.equal(
      classifyWindow(cmdN({ tabs: [{ url }] })).wouldClone,
      true,
      `expected ${JSON.stringify(url)} to read as blank`,
    );
  }
  // A tab whose navigation has not committed carries its destination in
  // pendingUrl, exactly as the cloner's isBlankTab assumes.
  assert.equal(
    classifyWindow(cmdN({ tabs: [{ url: "", pendingUrl: "https://a.test/" }] }))
      .wouldClone,
    false,
  );
});

test("3. a window created inside the startup quiet period is never cloned", () => {
  assertVetoedBy(cmdN({ msSinceSessionStart: 0 }), "startup-quiet");
  assertVetoedBy(
    cmdN({ msSinceSessionStart: STARTUP_QUIET_MS - 1 }),
    "startup-quiet",
  );
  // The boundary is exclusive: exactly at the threshold is still quiet.
  assertVetoedBy(
    cmdN({ msSinceSessionStart: STARTUP_QUIET_MS }),
    "startup-quiet",
  );
  assert.equal(
    classifyWindow(cmdN({ msSinceSessionStart: STARTUP_QUIET_MS + 1 }))
      .wouldClone,
    true,
  );
});

test("4. a window created in a burst is never cloned", () => {
  assertVetoedBy(
    cmdN({ windowsCreatedInLastTwoSeconds: MAX_WINDOWS_IN_BURST + 1 }),
    "burst=2",
  );
  assertVetoedBy(cmdN({ windowsCreatedInLastTwoSeconds: 20 }), "burst=20");
});

test("5. a window that never took focus is never cloned", () => {
  assertVetoedBy(cmdN({ becameFocusedWithinMs: null }), "never-focused");
});

test("5. a window that took focus too late is never cloned", () => {
  assertVetoedBy(
    cmdN({ becameFocusedWithinMs: FOCUS_GRACE_MS + 1 }),
    "focused-late",
  );
  assert.equal(
    classifyWindow(cmdN({ becameFocusedWithinMs: FOCUS_GRACE_MS })).wouldClone,
    true,
  );
});

test("5. focus delivered just before the create event still counts", () => {
  // Chromium does not promise which of the two events lands first, so the
  // measurement is signed and the test is on its magnitude.
  assert.equal(classifyWindow(cmdN({ becameFocusedWithinMs: -30 })).wouldClone, true);
  assertVetoedBy(
    cmdN({ becameFocusedWithinMs: -(FOCUS_GRACE_MS + 1) }),
    "focused-late",
  );
});

// ---------------------------------------------------------------------------
// Failing closed.
// ---------------------------------------------------------------------------

test("a missing session start is a no, not a yes", () => {
  assertVetoedBy(cmdN({ msSinceSessionStart: null }), "sessionStart-unknown");
  assertVetoedBy(
    cmdN({ msSinceSessionStart: undefined }),
    "sessionStart-unknown",
  );
  assertVetoedBy(cmdN({ msSinceSessionStart: NaN }), "sessionStart-unknown");
  assertVetoedBy(
    cmdN({ msSinceSessionStart: "90001" }),
    "sessionStart-unknown",
  );
});

test("a tabs.query that failed is a no, not a yes", () => {
  assertVetoedBy(cmdN({ tabCount: null, tabs: null }), "tabs-unknown");
  assertVetoedBy(cmdN({ tabs: null }), "tabs-unknown");
  assertVetoedBy(cmdN({ tabCount: null }), "tabs-unknown");
});

test("an unknown incognito flag is a no, not a yes", () => {
  assertVetoedBy(cmdN({ incognito: undefined }), "incognito");
  // Truthiness is not enough: only an explicit false passes.
  assertVetoedBy(cmdN({ incognito: 0 }), "incognito");
});

test("an unknown burst count is a no, not a yes", () => {
  assertVetoedBy(cmdN({ windowsCreatedInLastTwoSeconds: null }), "burst-unknown");
  assertVetoedBy(cmdN({ windowsCreatedInLastTwoSeconds: 0 }), "burst-unknown");
});

test("a missing or malformed observation is a no", () => {
  for (const observation of [null, undefined, "window", 7]) {
    const { wouldClone, reasons } = classifyWindow(observation);
    assert.equal(wouldClone, false);
    assert.deepEqual(reasons, ["no:no-observation"]);
  }
  // An empty object has no signals at all, so every condition vetoes.
  const { wouldClone, reasons } = classifyWindow({});
  assert.equal(wouldClone, false);
  assert.equal(reasons.length, 5);
  assert.ok(reasons.every((reason) => reason.startsWith("no:")));
});

// ---------------------------------------------------------------------------
// The scenario that caused all of this.
// ---------------------------------------------------------------------------

test("a Space-restore storm is rejected window by window", () => {
  // Twenty windows inside a second, shortly after launch. ego lite rebuilds
  // every Space at startup and each one arrives as an ordinary normal window
  // holding a single blank tab — indistinguishable from Cmd+N on the two
  // signals the old gate used. Only the Space the user left focused takes
  // focus; the other nineteen are rebuilt behind it.
  const storm = [];
  for (let i = 0; i < 20; i += 1) {
    storm.push(
      cmdN({
        msSinceSessionStart: 1_200 + i * 45,
        windowsCreatedInLastTwoSeconds: i + 1,
        becameFocusedWithinMs: i === 7 ? 30 : null,
      }),
    );
  }

  for (const [index, observation] of storm.entries()) {
    const { wouldClone, reasons } = classifyWindow(observation);
    assert.equal(
      wouldClone,
      false,
      `storm window ${index} would have been cloned: ${reasons.join(" ")}`,
    );
  }

  // And the first of them is rejected on the quiet period even before the
  // burst counter has anything to say, so losing either guard is survivable.
  assert.ok(
    classifyWindow(storm[0]).reasons.some((r) =>
      r.startsWith("no:startup-quiet"),
    ),
  );
});

test("a genuine Cmd+N arriving during a storm is still refused", () => {
  // The user pressed Cmd+N while the Spaces were still being rebuilt. This is
  // a real clone the user does not get, and that is the correct trade: one
  // missed Cmd+N against ten clone windows and 350 duplicate tabs.
  assertVetoedBy(
    cmdN({ msSinceSessionStart: 3_000, windowsCreatedInLastTwoSeconds: 6 }),
    "startup-quiet",
  );
});

test("the burst window is two seconds", () => {
  // Documented here because the observer ages the counter out against it and
  // the two must agree.
  assert.equal(BURST_WINDOW_MS, 2_000);
});
