const SETTINGS_KEY = "settings";
const DEFAULTS = { snapshotsEnabled: true };

export async function readSettings(api) {
  try {
    const result = await api.storage.local.get(SETTINGS_KEY);
    const stored = result?.[SETTINGS_KEY];
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
      return { ...DEFAULTS };
    }
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeSettings(api, patch) {
  const current = await readSettings(api);
  await api.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}
