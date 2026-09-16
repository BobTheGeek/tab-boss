import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState, WINDOW_ID_NONE } from "../src/state.js";
import { installFocusTracking, seedFocus } from "../src/focusTracking.js";

function setup(windows) {
  const fake = createFakeChrome({ windows });
  const state = createState();
  installFocusTracking(fake.api, state);
  return { fake, state };
}

test("focusing normal windows builds the two-deep history", async () => {
  const { fake, state } = setup([{ id: 1 }, { id: 2 }]);
  await fake.api.windows.onFocusChanged.emit(1);
  await fake.api.windows.onFocusChanged.emit(2);
  assert.equal(state.previousWindowId, 1);
  assert.equal(state.currentWindowId, 2);
});

test("incognito windows are never recorded as a clone source", async () => {
  const { fake, state } = setup([{ id: 1 }, { id: 2, incognito: true }]);
  await fake.api.windows.onFocusChanged.emit(1);
  await fake.api.windows.onFocusChanged.emit(2);
  assert.equal(state.currentWindowId, 1);
  assert.equal(state.previousWindowId, null);
});

test("popup windows are never recorded as a clone source", async () => {
  const { fake, state } = setup([{ id: 1 }, { id: 2, type: "popup" }]);
  await fake.api.windows.onFocusChanged.emit(1);
  await fake.api.windows.onFocusChanged.emit(2);
  assert.equal(state.currentWindowId, 1);
});

test("WINDOW_ID_NONE is ignored without a browser lookup", async () => {
  const { fake, state } = setup([{ id: 1 }]);
  await fake.api.windows.onFocusChanged.emit(1);
  await fake.api.windows.onFocusChanged.emit(WINDOW_ID_NONE);
  assert.equal(state.currentWindowId, 1);
  assert.equal(
    fake.calls.filter(([name]) => name === "windows.get").length,
    1,
  );
});

test("a window closing between the event and the lookup does not throw", async () => {
  const { fake, state } = setup([{ id: 1 }]);
  await fake.api.windows.onFocusChanged.emit(404);
  assert.equal(state.currentWindowId, null);
});

test("seedFocus records the last focused normal window", async () => {
  const fake = createFakeChrome({ windows: [{ id: 7 }] });
  const state = createState();
  await seedFocus(fake.api, state);
  assert.equal(state.currentWindowId, 7);
});

test("seedFocus ignores an incognito last focused window", async () => {
  const fake = createFakeChrome({ windows: [{ id: 7, incognito: true }] });
  const state = createState();
  await seedFocus(fake.api, state);
  assert.equal(state.currentWindowId, null);
});

test("seedFocus with no open windows does not throw", async () => {
  const fake = createFakeChrome();
  const state = createState();
  await seedFocus(fake.api, state);
  assert.equal(state.currentWindowId, null);
});
