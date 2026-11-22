import assert from "node:assert/strict";
import { test } from "node:test";
import { publishState } from "./publish.js";

const ok = { problems: [], test_required: false };

test("nothing changed means everything is published, and there is nothing to press", () => {
  const s = publishState({ draft_changed: false }, ok);
  assert.equal(s.mode, "published");
  assert.equal(s.draft, false);
});

test("an edit that passes every check can be published in one press", () => {
  const s = publishState({ draft_changed: true }, ok);
  assert.equal(s.mode, "ready");
  assert.equal(s.blocked, false);
});

test("an edit with a problem sends the person to the checks instead of publishing", () => {
  const s = publishState({ draft_changed: true }, { problems: [{ code: "x" }, { code: "y" }], test_required: false });
  assert.equal(s.mode, "review");
  assert.equal(s.blocked, true);
  assert.equal(s.reasons, 2);
});

test("an edit that has not been tested needs the test first when a test is required", () => {
  assert.equal(publishState({ draft_changed: true }, { problems: [], test_required: true, test: { status: "failed" } }).mode, "review");
  assert.equal(publishState({ draft_changed: true }, { problems: [], test_required: true }).mode, "review");
  assert.equal(publishState({ draft_changed: true }, { problems: [], test_required: true, test: { status: "passed" } }).mode, "ready");
});

test("a missing or odd answer never lets an unchecked edit through", () => {
  assert.equal(publishState({ draft_changed: true }, undefined).mode, "ready"); // no checks known: the server still refuses what it must
  assert.equal(publishState(undefined, undefined).mode, "published");
  assert.equal(publishState({ draft_changed: "yes" }, null).draft, true);
});
