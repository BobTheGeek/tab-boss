import test from "node:test";
import assert from "node:assert/strict";
import { createAbortWatch, createState } from "../src/state.js";

test("a fresh state has the empty sets and flag the writers share", () => {
  const state = createState();
  assert.equal(state.suppressedWindowIds.size, 0);
  assert.equal(state.abortedWindowIds.size, 0);
  assert.equal(state.restoredWindowIds.size, 0);
  assert.equal(state.restoreInProgress, false);
});

test("createState returns an independent object each call", () => {
  const a = createState();
  const b = createState();
  a.suppressedWindowIds.add(1);
  assert.equal(b.suppressedWindowIds.size, 0);
});

test("an abort watch reads and marks one window's aborted state", () => {
  const state = createState();
  const watch = createAbortWatch(state, 7);
  assert.equal(watch.aborted(), false);
  watch.mark();
  assert.equal(watch.aborted(), true);
  assert.ok(state.abortedWindowIds.has(7));
  // A different window is unaffected.
  assert.equal(createAbortWatch(state, 8).aborted(), false);
});
