import { buildSnapshot, fingerprint, isSuspectedLoss, totalTabs } from "./snapshot.js";
import {
  appendSnapshot,
  newestSnapshot,
  readMeta,
  writeMeta,
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
 * testable without waiting a minute.
 *
 * Returns "saved" | "quiet" | "loss" | "unchanged".
 */
export async function captureNow(api, now) {
  const meta = await readMeta(api);

  if (
    meta.browserStartedAt !== null &&
    now - meta.browserStartedAt < QUIET_PERIOD_MS
  ) {
    return "quiet";
  }

  const candidate = buildSnapshot(await readCapturableWindows(api), now);
  const newest = await newestSnapshot(api);

  if (newest !== null) {
    if (fingerprint(candidate) === fingerprint(newest)) return "unchanged";

    if (isSuspectedLoss(candidate, newest)) {
      const seen = meta.consecutiveSuspectedLosses + 1;
      if (seen < MAX_CONSECUTIVE_LOSSES) {
        // Routine, not a failure: say why a snapshot is missing.
        console.log(
          `[Tab Boss] skipped a snapshot: ${totalTabs(candidate)} tabs, down from ${totalTabs(newest)}`,
        );
        await writeMeta(api, { ...meta, consecutiveSuspectedLosses: seen });
        return "loss";
      }
      // The low count has held long enough to be a decision, not a loss.
    }
  }

  await appendSnapshot(api, candidate);
  await writeMeta(api, { ...meta, consecutiveSuspectedLosses: 0 });
  return "saved";
}

export function installSnapshotScheduler(api) {
  // Manifest V3 evicts the service worker when idle and a setInterval dies
  // with it. An alarm wakes the worker back up. alarms.create is idempotent
  // for a given name, so this needs no onInstalled/onStartup creation path.
  void api.alarms.create(SNAPSHOT_ALARM, {
    periodInMinutes: SNAPSHOT_PERIOD_MINUTES,
  });

  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== SNAPSHOT_ALARM) return;
    try {
      await captureNow(api, Date.now());
    } catch (error) {
      console.warn("[Tab Boss] could not take a snapshot", error);
    }
  });

  const recordStart = async () => {
    const meta = await readMeta(api);
    await writeMeta(api, { ...meta, browserStartedAt: Date.now() });
  };

  api.runtime.onStartup.addListener(recordStart);
  api.runtime.onInstalled.addListener(recordStart);
}
