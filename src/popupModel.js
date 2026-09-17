const MAX_NAME_LENGTH = 60;

export function validateName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) return { valid: false, reason: "empty" };
  if (name.length > MAX_NAME_LENGTH) return { valid: false, reason: "too-long" };
  return { valid: true, name };
}

export function nameExists(tabsets, name) {
  return tabsets.some((set) => set.name === name);
}

export function listView(tabsets) {
  return [...tabsets]
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((set) => ({
      name: set.name,
      tabCount: Array.isArray(set.plan) ? set.plan.length : 0,
      savedAt: set.savedAt,
    }));
}
