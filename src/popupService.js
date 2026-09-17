import { findTabset, upsertTabset } from "./tabsetStore.js";
import { validateName } from "./popupModel.js";
import { planFromWindow, writeIntoNewWindow } from "./windowCloning.js";
import { restoreNewest } from "./restore.js";
import { CAPTURE, OPEN, RESTORE } from "./popupMessages.js";

export { CAPTURE, OPEN, RESTORE };

/** A watch that never aborts, for reads with no target window to guard. */
const NEVER_ABORTS = { aborted: () => false, mark: () => {} };

/**
 * Handles the popup's messages. The popup does its own storage reads for the
 * list, the toggle, and deletes; only these operations, which touch live
 * windows through the crash-hardened write path, come through the worker.
 *
 * `now` is injected so the save timestamp is testable.
 */
export async function handlePopupMessage(api, state, message, now) {
  if (!message || typeof message !== "object") {
    return { ok: false, reason: "bad-message" };
  }
  switch (message.type) {
    case CAPTURE:
      return captureCurrentWindow(api, message.name, now);
    case OPEN:
      return openTabset(api, state, message.name);
    case RESTORE: {
      const created = await restoreNewest(api, state);
      return { ok: true, created };
    }
    default:
      return { ok: false, reason: "unknown" };
  }
}

async function captureCurrentWindow(api, name, now) {
  // The worker is the trust boundary: the popup validates too, but a buggy or
  // crafted message could arrive with an empty or oversized name. Validate with
  // the same rule the popup uses, so the two cannot drift, and store the
  // trimmed form.
  const check = validateName(name);
  if (!check.valid) return { ok: false, reason: "bad-name" };

  let source;
  try {
    source = await api.windows.getLastFocused();
  } catch {
    return { ok: false, reason: "no-window" };
  }
  if (!source || source.type !== "normal" || source.incognito) {
    return { ok: false, reason: "not-normal" };
  }
  const described = await planFromWindow(api, source.id, NEVER_ABORTS);
  if (described === null) return { ok: false, reason: "read-failed" };
  const overwritten = await upsertTabset(api, {
    name: check.name,
    savedAt: now(),
    plan: described.plan,
    groups: described.groups,
  });
  return { ok: true, overwritten };
}

async function openTabset(api, state, name) {
  const set = await findTabset(api, name);
  if (set === null) return { ok: false, reason: "not-found" };
  const created = await writeIntoNewWindow(api, state, () => ({
    plan: set.plan,
    groups: set.groups,
  }));
  return created ? { ok: true, created: 1 } : { ok: false, reason: "create-failed" };
}
