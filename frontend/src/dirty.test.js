import assert from "node:assert/strict";
import { test } from "node:test";
import { changed, sameQuestions, sameSet } from "./dirty.js";

test("nothing changed means nothing to save, whatever the key order", () => {
  assert.equal(changed({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), false);
  assert.equal(changed({ a: 1 }, { a: 2 }), true);
  assert.equal(changed("Hello", "Hello "), true); // a space typed is an edit
});

test("numbers typed into a box are the same as the numbers saved", () => {
  assert.equal(changed({ max: 10 }, { max: "10" }), false);
  assert.equal(changed({ max: 10 }, { max: "11" }), true);
});

test("tools switched on are a set: the order they were pressed in does not matter", () => {
  assert.equal(sameSet(["end_call", "add_task"], ["add_task", "end_call"]), true);
  assert.equal(sameSet(["end_call"], ["end_call", "add_task"]), false);
});

test("questions compare by what a person edits, not by what the server adds", () => {
  const saved = [{ key: "payment_date", label: "Payment date", kind: "date", required: true, ask: "", choices: [], made_by: "builder" }];
  const onScreen = [{ label: "Payment date", kind: "date", required: true, ask: "", choices: [] }];
  assert.equal(sameQuestions(saved, onScreen), true);
  assert.equal(sameQuestions(saved, [{ ...onScreen[0], ask: "When?" }]), false);
  assert.equal(sameQuestions(saved, []), false);
});
