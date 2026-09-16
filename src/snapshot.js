import { TAB_GROUP_ID_NONE } from "./state.js";

/** Bumped when the stored shape changes, so an old snapshot is skipped. */
export const SNAPSHOT_VERSION = 1;

function isCapturable(window) {
  return window.type === "normal" && !window.incognito;
}

/**
 * Builds one snapshot from live window data.
 *
 * Live Chromium group ids do not survive a browser restart, so each group is
 * remapped to a key local to the snapshot. Storing the live id would make a
 * snapshot useless for exactly the case this feature exists for.
 */
export function buildSnapshot(windows, takenAt) {
  return {
    version: SNAPSHOT_VERSION,
    takenAt,
    windows: windows.filter(({ window }) => isCapturable(window)).map(({ window, tabs, groups }) => {
      const keyByGroupId = new Map();
      const captured = [];
      for (const group of groups) {
        keyByGroupId.set(group.id, captured.length);
        captured.push({
          key: captured.length,
          title: group.title,
          color: group.color,
          collapsed: Boolean(group.collapsed),
        });
      }
      return {
        focused: Boolean(window.focused),
        groups: captured,
        tabs: tabs.map((tab) => ({
          // A tab whose navigation has not committed reports an empty url and
          // carries its destination in pendingUrl.
          url: tab.url || tab.pendingUrl || "",
          title: tab.title ?? "",
          pinned: Boolean(tab.pinned),
          muted: Boolean(tab.mutedInfo?.muted),
          active: Boolean(tab.active),
          groupKey:
            tab.groupId != null &&
            tab.groupId !== TAB_GROUP_ID_NONE &&
            keyByGroupId.has(tab.groupId)
              ? keyByGroupId.get(tab.groupId)
              : null,
        })),
      };
    }),
  };
}

export function totalTabs(snapshot) {
  return snapshot.windows.reduce((sum, window) => sum + window.tabs.length, 0);
}

/**
 * A stable string covering layout and nothing else.
 *
 * `takenAt` and `title` are excluded deliberately. Titles change as pages load
 * and as sites update them, which would defeat deduplication entirely while
 * telling us nothing about layout.
 */
export function fingerprint(snapshot) {
  return JSON.stringify(
    snapshot.windows.map((window) => [
      window.groups.map((g) => [g.key, g.title, g.color, g.collapsed]),
      window.tabs.map((t) => [t.url, t.pinned, t.muted, t.active, t.groupKey]),
    ]),
  );
}

/**
 * True when the tab count has more than halved since the newest snapshot.
 *
 * That smells like a crash or an accidental close rather than a decision, and
 * letting it overwrite good history would make the whole feature useless. The
 * scheduler owns the escape hatch for a user who really did close half.
 */
export function isSuspectedLoss(candidate, newest) {
  return totalTabs(candidate) * 2 < totalTabs(newest);
}
