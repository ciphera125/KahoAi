// Checks on the public website (separate from the Studio in frontend/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("no em dash anywhere in the page", () => {
  assert.equal(html.includes("—"), false);
});
test("no inline script, so a strict script policy can be used when it is hosted", () => {
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/.test(html), false);
});
test("every #anchor link points at an element that exists", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, h] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(h), `missing #${h}`);
});
test("the rate card has five plans", () => {
  assert.equal((html.match(/<th scope="col"/g) || []).length, 5);
});
test("none of the Studio's navy and gold", () => {
  assert.equal(/#0B1D4A|#F0A518|#14307A/i.test(html), false);
});
