import test from "node:test";
import assert from "node:assert/strict";
import { listView, nameExists, validateName } from "../src/popupModel.js";

test("a name is trimmed and accepted", () => {
  assert.deepEqual(validateName("  Daily Work  "), { valid: true, name: "Daily Work" });
});

test("an empty or whitespace name is rejected", () => {
  assert.equal(validateName("").valid, false);
  assert.equal(validateName("   ").valid, false);
});

test("a non-string name is rejected", () => {
  assert.equal(validateName(undefined).valid, false);
});

test("an over-long name is rejected", () => {
  assert.equal(validateName("x".repeat(61)).valid, false);
  assert.equal(validateName("x".repeat(60)).valid, true);
});

test("nameExists is exact", () => {
  const sets = [{ name: "Daily" }];
  assert.equal(nameExists(sets, "Daily"), true);
  assert.equal(nameExists(sets, "daily"), false);
});

test("listView is newest-first with a tab count", () => {
  const sets = [
    { name: "Old", savedAt: 1, plan: [{}, {}] },
    { name: "New", savedAt: 2, plan: [{}] },
  ];
  assert.deepEqual(listView(sets), [
    { name: "New", tabCount: 1, savedAt: 2 },
    { name: "Old", tabCount: 2, savedAt: 1 },
  ]);
});

test("listView tolerates a set with no plan array", () => {
  assert.deepEqual(listView([{ name: "X", savedAt: 1 }]), [
    { name: "X", tabCount: 0, savedAt: 1 },
  ]);
});
