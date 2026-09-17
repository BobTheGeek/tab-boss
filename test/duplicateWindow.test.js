import test from "node:test";
import assert from "node:assert/strict";
import { createFakeChrome } from "./fakeChrome.js";
import { createState } from "../src/state.js";
import {
  DUPLICATE_COMMAND,
  DUPLICATE_MENU_ID,
  installDuplicateWindow,
} from "../src/duplicateWindow.js";

/** A fake with one normal window that has real tabs to copy. */
function setup() {
  const fake = createFakeChrome({
    windows: [{ id: 1 }],
    tabs: [
      { id: 10, windowId: 1, index: 0, url: "https://a.test/" },
      { id: 11, windowId: 1, index: 1, url: "https://b.test/", active: true },
    ],
  });
  const state = createState();
  installDuplicateWindow(fake.api, state);
  return { fake, state };
}

function newWindowIds(fake, before) {
  return [...fake.windows.keys()].filter((id) => !before.has(id));
}

test("the keyboard command duplicates the focused window", async () => {
  const { fake } = setup();
  const before = new Set(fake.windows.keys());
  await fake.api.commands.onCommand.emit(DUPLICATE_COMMAND);

  const [newId] = newWindowIds(fake, before);
  const urls = [...fake.tabs.values()]
    .filter((t) => t.windowId === newId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.url);
  assert.deepEqual(urls, ["https://a.test/", "https://b.test/"]);
});

test("an unrelated keyboard command does nothing", async () => {
  const { fake } = setup();
  const before = new Set(fake.windows.keys());
  await fake.api.commands.onCommand.emit("something-else");
  assert.deepEqual(newWindowIds(fake, before), []);
});

test("the context-menu item duplicates the focused window", async () => {
  const { fake } = setup();
  const before = new Set(fake.windows.keys());
  await fake.api.contextMenus.onClicked.emit({ menuItemId: DUPLICATE_MENU_ID });
  assert.equal(newWindowIds(fake, before).length, 1);
});

test("an unrelated context-menu item does nothing", async () => {
  const { fake } = setup();
  const before = new Set(fake.windows.keys());
  await fake.api.contextMenus.onClicked.emit({ menuItemId: "not-ours" });
  assert.deepEqual(newWindowIds(fake, before), []);
});

test("the menu item is created on install, idempotently", async () => {
  const { fake } = setup();
  await fake.api.runtime.onInstalled.emit();
  assert.ok(fake.menus.has(DUPLICATE_MENU_ID), "the menu item must exist");
  assert.equal(fake.menus.get(DUPLICATE_MENU_ID).title, "Duplicate this window");

  // A second install (a reload) must not throw on a duplicate id: removeAll
  // runs first.
  await fake.api.runtime.onInstalled.emit();
  assert.equal([...fake.menus.keys()].length, 1);
});
