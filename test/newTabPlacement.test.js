import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import { installNewTabPlacement } from "../src/newTabPlacement.js";

function setup(initial) {
  const fake = createFakeChrome(initial);
  const state = createState();
  installNewTabPlacement(fake.api, state);
  return { fake, state };
}

function moveCalls(fake) {
  return fake.calls.filter(([name]) => name === "tabs.move");
}

test("a tab created in a normal window is moved to the end", async () => {
  const { fake } = setup({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0 }],
  });
  await fake.api.tabs.onCreated.emit({ id: 10, windowId: 1 });
  assert.deepEqual(moveCalls(fake), [["tabs.move", 10, -1]]);
});

test("a tab created in a popup window is left alone", async () => {
  const { fake } = setup({
    windows: [{ id: 1, type: "popup" }],
    tabs: [{ id: 10, windowId: 1, index: 0 }],
  });
  await fake.api.tabs.onCreated.emit({ id: 10, windowId: 1 });
  assert.deepEqual(moveCalls(fake), []);
});

test("tabs created in a window the cloner is filling are left alone", async () => {
  const { fake, state } = setup({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0 }],
  });
  state.suppressedWindowIds.add(1);
  await fake.api.tabs.onCreated.emit({ id: 10, windowId: 1 });
  assert.deepEqual(moveCalls(fake), []);
});

test("a suppressed window checks nothing else, not even the window type", async () => {
  const { fake, state } = setup({
    windows: [{ id: 1 }],
    tabs: [{ id: 10, windowId: 1, index: 0 }],
  });
  state.suppressedWindowIds.add(1);
  await fake.api.tabs.onCreated.emit({ id: 10, windowId: 1 });
  assert.deepEqual(fake.calls, []);
});

test("a tab that vanishes before the move does not throw", async () => {
  const { fake } = setup({ windows: [{ id: 1 }], tabs: [] });
  await fake.api.tabs.onCreated.emit({ id: 999, windowId: 1 });
  assert.deepEqual(moveCalls(fake), [["tabs.move", 999, -1]]);
});

test("a window that vanishes before the lookup does not throw", async () => {
  const { fake } = setup({ windows: [], tabs: [] });
  await fake.api.tabs.onCreated.emit({ id: 10, windowId: 404 });
  assert.deepEqual(moveCalls(fake), []);
});
