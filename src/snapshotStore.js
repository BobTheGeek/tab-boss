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

export async function writeMeta(api, meta) {
  await api.storage.local.set({ [META_KEY]: meta });
}
