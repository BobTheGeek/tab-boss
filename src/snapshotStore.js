/** How many snapshots to keep. At 2-minute intervals, about 40 minutes. */
export const MAX_SNAPSHOTS = 20;

const SNAPSHOTS_KEY = "snapshots";
const META_KEY = "meta";
const LOSS_COUNTER_KEY = "consecutiveSuspectedLosses";

const DEFAULT_META = {
  browserStartedAt: null,
};

/**
 * Storage is a backup, so a failure to read it must never break the browser.
 * Anything unreadable or malformed is reported as "nothing stored", which the
 * callers already handle.
 */
async function readKey(api, key) {
  try {
    const result = await api.storage.local.get(key);
    return result?.[key];
  } catch {
    return undefined;
  }
}

export async function readSnapshots(api) {
  const stored = await readKey(api, SNAPSHOTS_KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function newestSnapshot(api) {
  const snapshots = await readSnapshots(api);
  return snapshots.length > 0 ? snapshots.at(-1) : null;
}

/**
 * Reads without swallowing, for the one caller that must not write on a
 * guess. A rejection here aborts the append: overwriting real history with a
 * single snapshot because one read glitched is worse than skipping a save.
 *
 * Note the asymmetry with readSnapshots: a *rejected* read means we do not
 * know what is stored, so appendSnapshot must not write at all. A
 * *malformed* stored value means we do know, and it is unusable, so there is
 * no history to protect and starting fresh is correct.
 */
async function readSnapshotsForWrite(api) {
  const result = await api.storage.local.get(SNAPSHOTS_KEY);
  const stored = result?.[SNAPSHOTS_KEY];
  return Array.isArray(stored) ? stored : [];
}

export async function appendSnapshot(api, snapshot) {
  const snapshots = await readSnapshotsForWrite(api);
  snapshots.push(snapshot);
  await api.storage.local.set({
    [SNAPSHOTS_KEY]: snapshots.slice(-MAX_SNAPSHOTS),
  });
}

export async function readMeta(api) {
  const stored = await readKey(api, META_KEY);
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...DEFAULT_META };
  }
  return { ...DEFAULT_META, ...stored };
}

/** Replaces `meta` wholesale. Tests use this to seed a known starting state. */
export async function writeMeta(api, meta) {
  await api.storage.local.set({ [META_KEY]: meta });
}

/**
 * Merges `patch` into the stored `meta`.
 *
 * `meta` used to hold the suspected-loss counter too, which gave it two
 * overlapping writers: a capture that read the whole object, awaited five
 * browser calls, and wrote a derivative back would clobber a `browserStartedAt`
 * the startup recorder had stored in between. The counter now lives in
 * `chrome.storage.session`, so `meta` has exactly one field and exactly one
 * writer and the cross-field clobber is genuinely gone rather than merely
 * narrowed.
 *
 * Patching rather than replacing is kept as the writer's API so that stays
 * true if `meta` ever gains a second field. It is deliberately not serialised:
 * a lock held by a service worker that Manifest V3 can evict mid-hold is worse
 * than the race it closes.
 */
export async function updateMeta(api, patch) {
  const meta = await readMeta(api);
  await api.storage.local.set({ [META_KEY]: { ...meta, ...patch } });
}

/**
 * How many consecutive captures in THIS browser session have been refused as a
 * suspected loss.
 *
 * It lives in `chrome.storage.session`, not `storage.local`, and that choice is
 * the whole mechanism. The browser clears session storage on shutdown, so the
 * counter cannot survive a restart no matter what — the reset is a property of
 * the storage area rather than of an event we have to win a race against.
 *
 * The alternative, clearing it from `runtime.onStartup`, loses that race: a
 * persisted overdue alarm can fire before `onStartup` runs, and the capture
 * would then read the previous session's counter, find it at 2, and let the
 * escape hatch fire on the very first capture of the new session — making a
 * post-crash remnant the newest snapshot.
 *
 * Session storage survives service worker eviction, so the count still
 * accumulates correctly across the two-minute ticks within one session, which
 * is what the three-strike escape hatch needs.
 *
 * `browserStartedAt` deliberately stays in `storage.local`. In session storage
 * "absent" would be ambiguous between "fresh session" and "onStartup has not
 * run yet", and the quiet period would be back to guessing.
 *
 * An unreadable or nonsensical value reads as 0. That is the safe direction:
 * 0 means no evidence that a low tab count has persisted, so the suspected-loss
 * rule applies in full and refuses to overwrite good history.
 */
export async function readConsecutiveLosses(api) {
  try {
    const result = await api.storage.session.get(LOSS_COUNTER_KEY);
    const stored = result?.[LOSS_COUNTER_KEY];
    return Number.isInteger(stored) && stored >= 0 ? stored : 0;
  } catch {
    return 0;
  }
}

export async function writeConsecutiveLosses(api, count) {
  await api.storage.session.set({ [LOSS_COUNTER_KEY]: count });
}
