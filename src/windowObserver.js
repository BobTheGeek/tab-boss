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

    const task = observe(win, createdAt, windowsCreatedInLastTwoSeconds, pending, grace)
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

  async function observe(win, createdAt, burst, pending, grace) {
    let tabs = null;
    try {
      tabs = await api.tabs.query({ windowId: win.id });
    } catch {
      // The window can be gone before the worker is even scheduled to run
      // this. Unknown is recorded as unknown, and the classifier fails closed.
    }

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
      msSinceBrowserStart:
        browserStartedAt === null ? null : createdAt - browserStartedAt,
      windowsCreatedInLastTwoSeconds: burst,
      becameFocusedWithinMs:
        pending.focusedAt === null ? null : pending.focusedAt - createdAt,
    };

    const { wouldClone, reasons } = classifyWindow(observation);

    const record = {
      version: RECORD_VERSION,
      createdAt,
      recordedAt,
      windowId: win.id,
      typeAtCreate: win.type ?? null,
      typeAfterGrace,
      incognito: win.incognito ?? null,
      focusedAtCreate: win.focused ?? null,
      tabCount: observation.tabCount,
      tabUrls: observation.tabs === null ? [] : observation.tabs.map((t) => t.url),
      browserStartedAt,
      startupSeenAt,
      msSinceBrowserStart: observation.msSinceBrowserStart,
      windowsCreatedInLastTwoSeconds: burst,
      becameFocused: pending.focusedAt !== null,
      becameFocusedWithinMs: observation.becameFocusedWithinMs,
      wouldClone,
      reasons,
    };

    // A service worker's console dies with the worker, and Manifest V3 evicts
    // it constantly, so this line is a convenience for anyone watching live.
    // The stored log is the record that actually has to survive.
    console.log(`${LOG_PREFIX} ${JSON.stringify(record)}`);

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
