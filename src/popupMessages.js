/**
 * Message types the popup sends to the service worker. Shared by both sides so
 * the string constants cannot drift.
 */
export const CAPTURE = "tabsets/capture";
export const OPEN = "tabsets/open";
export const RESTORE = "snapshots/restore";
