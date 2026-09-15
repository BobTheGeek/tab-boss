import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_ID_NONE,
  createState,
  recordFocus,
  resolveSourceWindowId,
} from "../src/state.js";

test("a fresh state has no window history and nothing suppressed", () => {
  const state = createState();
  assert.equal(state.previousWindowId, null);
  assert.equal(state.currentWindowId, null);
  assert.equal(state.suppressedWindowIds.size, 0);
});

test("createState returns an independent object each call", () => {
  const a = createState();
  const b = createState();
  a.suppressedWindowIds.add(1);
  assert.equal(b.suppressedWindowIds.size, 0);
});

test("recordFocus shifts the current window into previous", () => {
  const state = createState();
  recordFocus(state, 1);
  recordFocus(state, 2);
  assert.equal(state.previousWindowId, 1);
  assert.equal(state.currentWindowId, 2);
});

test("recordFocus ignores WINDOW_ID_NONE so leaving the browser keeps history", () => {
  const state = createState();
  recordFocus(state, 1);
  recordFocus(state, 2);
  recordFocus(state, WINDOW_ID_NONE);
  assert.equal(state.previousWindowId, 1);
  assert.equal(state.currentWindowId, 2);
});

test("recordFocus ignores a repeat of the window already focused", () => {
  const state = createState();
  recordFocus(state, 1);
  recordFocus(state, 2);
  recordFocus(state, 2);
  assert.equal(state.previousWindowId, 1);
  assert.equal(state.currentWindowId, 2);
});

test("resolveSourceWindowId picks current when focus fired after creation", () => {
  const state = createState();
  recordFocus(state, 1);
  recordFocus(state, 2);
  assert.equal(resolveSourceWindowId(state, 99), 2);
});

test("resolveSourceWindowId picks previous when focus fired before creation", () => {
  const state = createState();
  recordFocus(state, 1);
  recordFocus(state, 2);
  assert.equal(resolveSourceWindowId(state, 2), 1);
});

test("resolveSourceWindowId returns null when nothing has been focused", () => {
  const state = createState();
  assert.equal(resolveSourceWindowId(state, 99), null);
});
