/** How many snapshots to keep. At 2-minute intervals, about 40 minutes. */
export const MAX_SNAPSHOTS = 20;

const SNAPSHOTS_KEY = "snapshots";
const META_KEY = "meta";

const DEFAULT_META = {
  browserStartedAt: null,
  consecutiveSuspectedLosses: 0,
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
 * `meta` has two writers — the capture and the browser-start recorder — and
 * they overlap: a persisted alarm that is overdue fires at startup, so a
 * capture can be suspended in the middle of reading windows when onStartup
 * lands. A caller that reads the whole object, awaits several browser calls,
 * and writes a derivative back therefore clobbers whatever the other writer
 * stored in between.
 *
 * Every caller should patch only the fields it owns. That keeps the read and
 * the write one storage round trip apart instead of five, and means the loser
 * of the remaining narrow race overwrites a field with the same value rather
 * than with a stale one. It is deliberately not serialised: a lock held by a
 * service worker that Manifest V3 can evict mid-hold is worse than the race.
 */
export async function updateMeta(api, patch) {
  const meta = await readMeta(api);
  await api.storage.local.set({ [META_KEY]: { ...meta, ...patch } });
}
