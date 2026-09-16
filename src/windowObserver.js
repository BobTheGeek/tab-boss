import { readMeta } from "./snapshotStore.js";
import { FOCUS_GRACE_MS, BURST_WINDOW_MS, classifyWindow } from "./windowClassifier.js";

/**
 * An instrument, not a feature. It watches every window the browser creates,
 * works out what the window cloner WOULD have done, and writes that down.
 *
 * It never creates, moves, removes, updates, groups or discards anything. The
 * only calls it makes are `tabs.query`, `windows.get` and `chrome.storage`.
 * That restriction is the whole design: the rule it is testing can only be
 * validated on the user's actual browser, because `test/fakeChrome.js` has no
 * concept of ego lite Spaces — which is precisely why 167 passing tests and
 * four rounds of review did not catch the bug this exists to diagnose.
 *
 * So it runs live, decides, logs, and changes nothing. After a day of real use
 * the log says whether the classifier is right. Only then does anyone turn
 * writing back on.
 */

/**
 * Its own storage key. It must never share one with `snapshots` or `meta`:
 * the user's real backup lives there, this is disposable diagnostics, and the
 * two must not be able to damage each other.
 */
export const OBSERVATIONS_KEY = "windowObservations";

/**
 * Marks the start of the current browser session, in `chrome.storage.session`.
 *
 * This is the whole mechanism behind condition 3, and the storage area is the
 * point. `meta.browserStartedAt` cannot do this job: it lives in
 * `storage.local`, so it survives a restart, and a Space storm that beats
 * `runtime.onStartup` reads the PREVIOUS session's timestamp — hours ago —
 * and sails straight through the startup quiet period at the one moment the
 * quiet period exists for. `test/snapshotScheduler.test.js` already documents
 * that exact race for the persisted alarm; the scheduler's loss counter was
 * moved here to escape it, and so is this.
 *
 * The browser clears session storage on shutdown, so "absent" means "first
 * worker start since the browser came up" as a property of the storage area
 * rather than as a race we have to win against an event.
 */
export const SESSION_START_KEY = "sessionStartedAt";

/** How many records to keep. Oldest dropped first. */
export const MAX_OBSERVATIONS = 200;

/** How many of a window's tab URLs to record. Enough to recognise it. */
export const MAX_RECORDED_TAB_URLS = 5;

/** Every observation line starts with this, so it can be filtered live. */
const LOG_PREFIX = "[Tab Boss dx]";

/** Bumped if the record shape changes, so an old log is not misread. */
const RECORD_VERSION = 1;

export async function readObservations(api) {
  try {
    const result = await api.storage.local.get(OBSERVATIONS_KEY);
    const stored = result?.[OBSERVATIONS_KEY];
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/**
 * Appends one record, keeping the newest MAX_OBSERVATIONS.
 *
 * A *rejected* read means we do not know what is stored, so we do not write at
 * all — replacing a day of evidence with one record because a read glitched is
 * the one way a read-only instrument can still destroy something. A
 * *malformed* stored value means we do know, and it is unusable, so starting
 * fresh is correct. Same asymmetry as `appendSnapshot`, for the same reason.
 */
/**
 * Reads the session marker, claiming it if this is the first worker start
 * since the browser came up.
 *
 * Get-then-set-if-absent, deliberately not serialised. Manifest V3 evicts and
 * cold-starts this worker constantly, so `installWindowObserver` runs many
 * times per session, but only the run that finds the key absent writes it.
 * Two near-simultaneous cold starts could both find it absent and both write;
 * that race is harmless, because they would write timestamps milliseconds
 * apart and the value is only ever compared against a 90-second threshold.
 *
 * Fails closed: anything unreadable returns null, condition 3 vetoes, and the
 * worst case is that the user loses a Cmd+N clone.
 *
 * A mid-session claim is possible in two ways — a transient storage failure on
 * a previous attempt, or an extension reload, which also clears session
 * storage. Both make the session look brand new and so suppress cloning for
 * `STARTUP_QUIET_MS`. That is the safe direction, and it is the direction this
 * whole rule is built to fail in.
 */
async function claimSessionStart(api, now) {
  try {
    const result = await api.storage.session.get(SESSION_START_KEY);
    const stored = result?.[SESSION_START_KEY];
    if (Number.isFinite(stored)) return stored;
    const startedAt = now();
    await api.storage.session.set({ [SESSION_START_KEY]: startedAt });
    return startedAt;
  } catch {
    return null;
  }
}

async function appendObservation(api, record) {
  const result = await api.storage.local.get(OBSERVATIONS_KEY);
  const stored = result?.[OBSERVATIONS_KEY];
  const log = Array.isArray(stored) ? stored : [];
  log.push(record);
  await api.storage.local.set({
    [OBSERVATIONS_KEY]: log.slice(-MAX_OBSERVATIONS),
  });
}

/**
 * Wires the observer to a browser.
 *
 * `now` and `wait` are injected so tests can drive the grace period by hand
 * rather than by sleeping. Production passes neither.
 *
 * Returns a handle whose `idle()` resolves once every in-flight observation
 * has been written. Nothing in production waits on it; it exists so tests can
 * be deterministic about work that is, by design, deferred.
 */
export function installWindowObserver(api, options = {}) {
  const now = options.now ?? (() => Date.now());
  const wait =
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const focusGraceMs = options.focusGraceMs ?? FOCUS_GRACE_MS;

  /** Creation timestamps inside the burst window. Held in memory only. */
  let recentCreations = [];

  /** windowId -> { createdAt, focusedAt } for observations still in flight. */
  const pendingFocus = new Map();

  /**
   * windowId -> timestamp, for focus that arrives BEFORE the create event.
   * Chromium does not promise the ordering of the two, and `state.js` already
   * derives the clone source that way rather than trusting one of them.
   */
  const recentFocus = new Map();

  /**
   * Set when this service worker sees the browser start. `browserStartedAt`
   * lives in storage.local and therefore SURVIVES a restart, so a record with
   * a large `msSinceBrowserStart` and `startupSeenAt: null` is the signature
   * of a stale previous-session timestamp rather than a genuinely old session.
   * Recorded, not acted on — reading the log is how we find out whether it
   * matters.
   */
  let startupSeenAt = null;

  /** When the previous window was created, so a storm is visible at a glance. */
  let previousWindowCreatedAt = null;

  /**
   * Claimed at install, not lazily on the first window, so the marker is
   * anchored to when the worker came up rather than to whenever the first
   * window happens to arrive. Kicked off without awaiting, because every
   * listener below must be registered synchronously at the top level or
   * Manifest V3 will not wake an evicted worker for the event.
   *
   * Re-attempted when it resolves to null, so one transient storage failure
   * does not blind the quiet period for the whole life of the worker.
   */
  let sessionStart = claimSessionStart(api, now);
  async function readSessionStart() {
    const startedAt = await sessionStart;
    if (startedAt !== null) return startedAt;
    sessionStart = claimSessionStart(api, now);
    return sessionStart;
  }

  const inFlight = new Set();

  /**
   * Appends are serialised. Twenty Space restores land twenty concurrent
   * read-modify-write cycles on one storage key, and without this the log
   * would lose most of the very storm it exists to capture.
   */
  let writes = Promise.resolve();
  function enqueueWrite(task) {
    const next = writes.then(task, task);
    writes = next.catch(() => {});
    return next;
  }

  function pruneFocus(at) {
    for (const [windowId, focusedAt] of recentFocus) {
      if (focusedAt < at - focusGraceMs) recentFocus.delete(windowId);
    }
  }

  const recordStart = () => {
    startupSeenAt = now();
  };
  api.runtime.onStartup.addListener(recordStart);
  api.runtime.onInstalled.addListener(recordStart);

  api.windows.onFocusChanged.addListener((windowId) => {
    // -1 is "focus left the browser entirely".
    if (windowId == null || windowId < 0) return;
    const at = now();
    pruneFocus(at);
    recentFocus.set(windowId, at);
    const pending = pendingFocus.get(windowId);
    // First focus wins: we are measuring how fast the window took focus, not
    // the last time the user came back to it.
    if (pending && pending.focusedAt === null) pending.focusedAt = at;
  });

  // Deliberately NOT filtered to windowTypes: ["normal"] the way the cloner
  // is. We do not yet know what an ego lite Space reports at creation, and a
  // filter would hide exactly the events we are here to look at.
  api.windows.onCreated.addListener((win) => {
    const createdAt = now();

    // Everything up to the first await runs synchronously, so a storm of
    // events cannot interleave and miscount itself.
    recentCreations = recentCreations.filter(
      (at) => at > createdAt - BURST_WINDOW_MS,
    );
    recentCreations.push(createdAt);
    const windowsCreatedInLastTwoSeconds = recentCreations.length;

    // The gap to the window before it, so a human scanning the log can tell a
    // launch storm from one window in the middle of the afternoon without
    // doing arithmetic. A column of 40s is a machine; a lone null or a gap of
    // minutes is a person.
    const msSincePreviousWindow =
      previousWindowCreatedAt === null ? null : createdAt - previousWindowCreatedAt;
    previousWindowCreatedAt = createdAt;

    const pending = { createdAt, focusedAt: null };
    const priorFocus = recentFocus.get(win.id);
    if (priorFocus != null && priorFocus >= createdAt - focusGraceMs) {
      pending.focusedAt = priorFocus;
    }
    pendingFocus.set(win.id, pending);
    pruneFocus(createdAt);

    // Started here, before the tabs.query, so the grace period is measured
    // from the create event rather than from whenever the query happens to
    // come back.
    const grace = wait(focusGraceMs);

    const task = observe(win, {
      createdAt,
      burst: windowsCreatedInLastTwoSeconds,
      msSincePreviousWindow,
      pending,
      grace,
    })
      .catch(() => {
        // An instrument that throws into the browser's event loop is worse
        // than one that misses a record.
      })
      .finally(() => {
        pendingFocus.delete(win.id);
        inFlight.delete(task);
      });
    inFlight.add(task);
    return task;
  });

  async function observe(win, { createdAt, burst, msSincePreviousWindow, pending, grace }) {
    let tabs = null;
    try {
      tabs = await api.tabs.query({ windowId: win.id });
    } catch {
      // The window can be gone before the worker is even scheduled to run
      // this. Unknown is recorded as unknown, and the classifier fails closed.
    }

    // The signal condition 3 actually keys off.
    const sessionStartedAt = await readSessionStart();

    // Still recorded, no longer decisive. These two are how we check whether
    // storage.session behaves on ego lite the way the docs say it does: a
    // record with a large `msSinceBrowserStart`, a small `msSinceSessionStart`
    // and `startupSeenAt: null` is a restart where the local timestamp was
    // stale and the session marker caught it — which is the bug this rule was
    // rewritten to close, caught in the act.
    const meta = await readMeta(api);
    const browserStartedAt = Number.isFinite(meta.browserStartedAt)
      ? meta.browserStartedAt
      : null;

    await grace;

    let typeAfterGrace = null;
    try {
      // Kept from the diagnostic this replaces: the cloner's gate and the
      // failure it produced disagreed about the window's type, so whether the
      // type changes after creation is still an open question.
      typeAfterGrace = (await api.windows.get(win.id)).type;
    } catch {
      // Closed during the grace period. Expected, and worth recording as null.
    }

    const recordedAt = now();
    const observation = {
      type: win.type,
      incognito: win.incognito,
      tabCount: tabs === null ? null : tabs.length,
      tabs:
        tabs === null
          ? null
          : tabs
              .slice(0, MAX_RECORDED_TAB_URLS)
              .map((tab) => ({ url: tab.url || tab.pendingUrl || "" })),
      msSinceSessionStart:
        sessionStartedAt === null ? null : createdAt - sessionStartedAt,
      windowsCreatedInLastTwoSeconds: burst,
      becameFocusedWithinMs:
        pending.focusedAt === null ? null : pending.focusedAt - createdAt,
    };

    const { wouldClone, reasons } = classifyWindow(observation);

    const record = {
      version: RECORD_VERSION,
      // Wall clock first, so scanning the log reads as a timeline rather than
      // as a column of epoch milliseconds.
      at: new Date(createdAt).toISOString(),
      createdAt,
      recordedAt,
      msSincePreviousWindow,
      windowId: win.id,
      typeAtCreate: win.type ?? null,
      typeAfterGrace,
      incognito: win.incognito ?? null,
      focusedAtCreate: win.focused ?? null,
      tabCount: observation.tabCount,
      tabUrls: observation.tabs === null ? [] : observation.tabs.map((t) => t.url),
      sessionStartedAt,
      msSinceSessionStart: observation.msSinceSessionStart,
      browserStartedAt,
      startupSeenAt,
      msSinceBrowserStart:
        browserStartedAt === null ? null : createdAt - browserStartedAt,
      windowsCreatedInLastTwoSeconds: burst,
      becameFocused: pending.focusedAt !== null,
      becameFocusedWithinMs: observation.becameFocusedWithinMs,
      wouldClone,
      reasons,
    };

    // A service worker's console dies with the worker, and Manifest V3 evicts
    // it constantly, so this line is a convenience for anyone watching live.
    // The stored log is the record that actually has to survive.
    //
    // The summary leads, so a storm is obvious as a shape in the console —
    // a run of lines with a rising burst= and a tiny gap= is a machine — and
    // the full record follows for anyone who wants to read or replay it.
    const gap =
      msSincePreviousWindow === null ? "first" : `gap=${msSincePreviousWindow}ms`;
    console.log(
      `${LOG_PREFIX} ${record.at} window=${win.id} ${
        wouldClone ? "WOULD CLONE" : "would not clone"
      } burst=${burst} ${gap}`,
      JSON.stringify(record),
    );

    await enqueueWrite(async () => {
      try {
        await appendObservation(api, record);
      } catch {
        // Storage being unavailable must never break the browser, and this is
        // diagnostics: a lost record is a lost record.
      }
    });
  }

  return {
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      await writes;
    },
  };
}
