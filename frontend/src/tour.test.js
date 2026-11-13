import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV } from "./nav.js";
import { STEPS } from "./tour.js";

const paths = NAV.flatMap(([, items]) => items.map(([path]) => path));

test("the tour visits every page in the sidebar, in the same order", () => {
  assert.deepEqual(STEPS.filter((s) => s.path).map((s) => s.path), paths);
});

test("every step says what the page is for in plain words", () => {
  for (const s of STEPS) {
    assert.ok(s.title && s.title.length <= 40, s.title);
    assert.ok(s.text && s.text.length >= 40 && s.text.length <= 320, `${s.title}: ${s.text?.length}`);
    assert.ok(!(s.title + s.text).includes(String.fromCharCode(0x2014)), "no em dashes");
  }
});

test("it starts with a welcome and ends with where to find help", () => {
  assert.equal(STEPS[0].path, undefined);
  assert.equal(STEPS.at(-1).path, undefined);
});
