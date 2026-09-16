import { buildSnapshot, fingerprint, isSuspectedLoss, totalTabs } from "./snapshot.js";
import {
  appendSnapshot,
  newestSnapshot,
  readMeta,
  updateMeta,
} from "./snapshotStore.js";

export const SNAPSHOT_ALARM = "tab-boss-snapshot";
export const SNAPSHOT_PERIOD_MINUTES = 2;

/**
 * A browser that has just crashed and relaunched into a reduced set of tabs
 * must not be able to overwrite good history during its first minute.
 */
export const QUIET_PERIOD_MS = 60_000;

/**
 * How many consecutive suspected losses before we accept the low count.
 *
 * Without this, a user who deliberately closes half their tabs would block
 * every future snapshot forever.
 */
export const MAX_CONSECUTIVE_LOSSES = 3;

async function readCapturableWindows(api) {
  const windows = await api.windows.getAll();
  const described = [];
  for (const window of windows) {
    if (window.type !== "normal" || window.incognito) continue;
    const tabs = (await api.tabs.query({ windowId: window.id })).sort(
      (a, b) => a.index - b.index,
    );
    const groups = await api.tabGroups.query({ windowId: window.id });
    described.push({ window, tabs, groups });
  }
  return described;
}

/**
 * Takes one snapshot unless a refusal rule fires.
 *
 * `now` is a parameter rather than a Date.now() call so the quiet period is
 * testable without waiting a minute. `state` is the shared state object; a
 * restore in flight is a fourth reason to refuse.
 *
 * Returns "saved" | "quiet" | "loss" | "unchanged" | "restoring".
 */
export async function captureNow(api, now, state) {
  // A restore is halfway through building windows, so the browser right now is
  // a remnant plus a part-built window. Storing that makes it the newest
  // snapshot, and a click in the next two minutes would restore it. The next
  // tick self-heals, but a several-hundred-tab restore runs longer than the
  // two-minute period, which turns a possibility into a certainty.
  if (state.restoreInProgress) return "restoring";

  const meta = await readMeta(api);

  if (
    meta.browserStartedAt !== null &&
    now - meta.browserStartedAt < QUIET_PERIOD_MS
  ) {
    return "quiet";
  }

  const candidate = buildSnapshot(await readCapturableWindows(api), now);
  const newest = await newestSnapshot(api);

  // Re-checked after the last read and before any write, with no await in the
  // gap. The check at the top cannot see a toolbar click that landed while the
  // windows above were being read. It sits above the verdict as well as the
  // save because the loss counter is a write too: a half-built restore is a
  // plausible-looking "suspected loss", and counting it would spend a strike
  // on a reading of the browser that was never real.
  if (state.restoreInProgress) return "restoring";

  if (newest !== null) {
    if (fingerprint(candidate) === fingerprint(newest)) return "unchanged";

    if (isSuspectedLoss(candidate, newest)) {
      const seen = meta.consecutiveSuspectedLosses + 1;
      if (seen < MAX_CONSECUTIVE_LOSSES) {
        // Routine, not a failure: say why a snapshot is missing.
        console.log(
          `[Tab Boss] skipped a snapshot: ${totalTabs(candidate)} tabs, down from ${totalTabs(newest)}`,
        );
        // Only the counter. browserStartedAt belongs to recordStart, and a
        // whole-object write here would put back the value read before the
        // several awaits above.
        await updateMeta(api, { consecutiveSuspectedLosses: seen });
        return "loss";
      }
      // The low count has held long enough to be a decision, not a loss.
    }
  }

  await appendSnapshot(api, candidate);
  await updateMeta(api, { consecutiveSuspectedLosses: 0 });
  return "saved";
}

/**
 * Creates the alarm only when there is not already one.
 *
 * chrome.alarms.create is NOT idempotent: "If there is another alarm with the
 * same name ... it will be cancelled and replaced by this alarm", and with
 * only periodInMinutes set, "periodInMinutes is used as the default for
 * delayInMinutes" — so each call schedules the first fire at now + 2 minutes.
 *
 * This installer runs on every cold start of the service worker, and Manifest
 * V3 evicts the worker after about 30 seconds idle. Tab Boss listens for
 * tabs.onCreated, windows.onCreated, windows.onFocusChanged and
 * windows.onRemoved, so ordinary browsing cold-starts it constantly. Creating
 * unconditionally would reset the clock every time and the alarm would never
 * reach two minutes: no snapshots, no error, and an empty store the user only
 * discovers when they need it.
 */
async function ensureAlarm(api) {
  if (await api.alarms.get(SNAPSHOT_ALARM)) return;
  await api.alarms.create(SNAPSHOT_ALARM, {
    periodInMinutes: SNAPSHOT_PERIOD_MINUTES,
    persistAcrossSessions: true,
  });
}

/**
 * Returns the promise for the alarm check, so a test can await it. Nothing in
 * production waits on it: background.js installs and moves on.
 */
export function installSnapshotScheduler(api, state) {
  // Manifest V3 will not wake an evicted service worker for a listener that
  // was registered inside an awaited callback, so every registration stays
  // synchronous and above the alarm check below.
  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== SNAPSHOT_ALARM) return;
    try {
      await captureNow(api, Date.now(), state);
    } catch (error) {
      console.warn("[Tab Boss] could not take a snapshot", error);
    }
  });

  const recordStart = async () => {
    // The counter is reset alongside the clock. A fresh browser session is not
    // a continuation of yesterday's evidence that the user deliberately closed
    // half their tabs, and a counter carried across a restart would let the
    // very first capture of the new session take the escape hatch and make a
    // post-crash remnant the newest snapshot.
    //
    // KNOWN GAP: this only helps once onStartup has actually run. A persisted
    // alarm that is already overdue can fire first, and a capture at that
    // moment still sees the previous session's counter and the previous
    // session's browserStartedAt — so it bypasses the quiet period and can
    // take the escape hatch immediately. Closing that needs the counter held
    // somewhere the browser clears on restart by itself, such as
    // chrome.storage.session, rather than a reset that races the alarm.
    await updateMeta(api, {
      browserStartedAt: Date.now(),
      consecutiveSuspectedLosses: 0,
    });
  };

  api.runtime.onStartup.addListener(recordStart);
  api.runtime.onInstalled.addListener(recordStart);

  return ensureAlarm(api);
}
