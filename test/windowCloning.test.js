import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState, recordFocus } from "../src/state.js";
import { cloneIntoWindow, isBlankTab } from "../src/windowCloning.js";

test("isBlankTab recognises the blank URLs a new window can hold", () => {
  assert.equal(isBlankTab({ url: "" }), true);
  assert.equal(isBlankTab({ url: "about:blank" }), true);
  assert.equal(isBlankTab({ url: "chrome://newtab/" }), true);
  assert.equal(isBlankTab({ url: "chrome://new-tab-page/" }), true);
  assert.equal(isBlankTab({ url: "ego://newtab/" }), true);
  assert.equal(isBlankTab({ url: undefined, pendingUrl: "about:blank" }), true);
  assert.equal(isBlankTab({ url: "https://example.com/" }), false);
});

/**
 * Window 1 is the source with two real tabs. Window 2 is the brand new window
 * holding a single blank tab. Focus history says the user came from window 1.
 */
function setupClonable(overrides = {}) {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2, ...(overrides.newWindow ?? {}) }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
      { id: 20, windowId: 2, index: 0, url: "about:blank", active: true },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  return { fake, state };
}

test("a fresh empty window clones the window the user came from", async () => {
  const { fake, state } = setupClonable();
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, true);
});

test("an incognito new window is never cloned into", async () => {
  const { fake, state } = setupClonable({ newWindow: { incognito: true } });
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a popup new window is never cloned into", async () => {
  const { fake, state } = setupClonable({ newWindow: { type: "popup" } });
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window holding a real page is not cloned into", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 20, windowId: 2, index: 0, url: "https://dragged.test/" },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window holding several tabs is not cloned into", async () => {
  const fake = createFakeChrome({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 20, windowId: 2, index: 0, url: "about:blank" },
      { id: 21, windowId: 2, index: 1, url: "about:blank" },
    ],
  });
  const state = createState();
  recordFocus(state, 1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a window with no known source is not cloned into", async () => {
  const { fake, state } = setupClonable();
  state.previousWindowId = null;
  state.currentWindowId = null;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a source window that has closed is not cloned from", async () => {
  const { fake, state } = setupClonable();
  fake.windows.delete(1);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("an incognito source window is not cloned from", async () => {
  const { fake, state } = setupClonable();
  fake.windows.get(1).incognito = true;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("a popup source window is not cloned from", async () => {
  const { fake, state } = setupClonable();
  fake.windows.get(1).type = "popup";
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("the source is current when focus fired before creation", async () => {
  const { fake, state } = setupClonable();
  recordFocus(state, 2);
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, true);
  assert.deepEqual(
    fake.calls.filter(([name]) => name === "windows.get"),
    [["windows.get", 1]],
  );
});

test("the source is never the new window itself", async () => {
  const { fake, state } = setupClonable();
  state.previousWindowId = null;
  state.currentWindowId = 2;
  const cloned = await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(cloned, false);
});

test("the suppression flag is cleared after a successful clone", async () => {
  const { fake, state } = setupClonable();
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(state.suppressedWindowIds.has(2), false);
});

test("the suppression flag is cleared even when the clone throws", async () => {
  const { fake, state } = setupClonable();
  fake.api.tabs.create = async () => {
    throw new Error("boom");
  };
  await cloneIntoWindow(fake.api, state, fake.windows.get(2));
  assert.equal(state.suppressedWindowIds.has(2), false);
});

test("a window closing mid-clone is a silent race, not a logged failure", async () => {
  const { fake, state } = setupClonable();
  fake.api.tabs.create = async () => {
    fake.windows.delete(2);
    throw new Error("window closed");
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await cloneIntoWindow(fake.api, state, { id: 2, type: "normal", incognito: false });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
  assert.equal(state.suppressedWindowIds.has(2), false);
});
