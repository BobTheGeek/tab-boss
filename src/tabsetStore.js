/** The storage key for saved tabsets, kept apart from snapshots and meta. */
export const TABSETS_KEY = "tabsets";

/**
 * A read that does NOT swallow, for the callers that must not build a write on
 * a guess. A rejection propagates and aborts the write; overwriting the whole
 * store because one read glitched is the one way a store can lose everything.
 */
async function readForWrite(api) {
  const result = await api.storage.local.get(TABSETS_KEY);
  const stored = result?.[TABSETS_KEY];
  return Array.isArray(stored) ? stored : [];
}

export async function readTabsets(api) {
  try {
    const result = await api.storage.local.get(TABSETS_KEY);
    const stored = result?.[TABSETS_KEY];
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export async function findTabset(api, name) {
  const sets = await readTabsets(api);
  return sets.find((set) => set.name === name) ?? null;
}

export async function upsertTabset(api, tabset) {
  const sets = await readForWrite(api);
  const without = sets.filter((set) => set.name !== tabset.name);
  const replaced = without.length !== sets.length;
  without.push(tabset);
  await api.storage.local.set({ [TABSETS_KEY]: without });
  return replaced;
}

export async function deleteTabset(api, name) {
  const sets = await readForWrite(api);
  await api.storage.local.set({
    [TABSETS_KEY]: sets.filter((set) => set.name !== name),
  });
}
