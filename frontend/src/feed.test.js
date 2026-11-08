import assert from "node:assert/strict";
import { test } from "node:test";
import { addPage, withDays } from "./feed.js";

const item = (id, at, extra = {}) => ({ id, at, text: id, ...extra });

test("an older page goes underneath, with nothing repeated", () => {
  const first = [item("c", "2026-11-08T10:00:00Z"), item("b", "2026-11-08T09:00:00Z")];
  const older = [item("b", "2026-11-08T09:00:00Z"), item("a", "2026-11-08T08:00:00Z")];
  assert.deepEqual(addPage(first, older).map((x) => x.id), ["c", "b", "a"]);
});

test("a newer arrival goes on top, and stays newest first", () => {
  const have = [item("b", "2026-11-08T09:00:00Z"), item("a", "2026-11-08T08:00:00Z")];
  assert.deepEqual(addPage(have, [item("c", "2026-11-08T10:00:00Z")]).map((x) => x.id), ["c", "b", "a"]);
});

test("items that arrive together keep their order, and a fresh copy replaces a stale one", () => {
  const have = [item("b", "2026-11-08T09:00:00Z", { unread: true })];
  const out = addPage(have, [item("b", "2026-11-08T09:00:00Z", { unread: false })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].unread, false);
});

test("nothing in, nothing out, and bad input is ignored", () => {
  assert.deepEqual(addPage([], []), []);
  assert.deepEqual(addPage(undefined, null), []);
});

test("days are labelled once, where each begins", () => {
  const now = new Date("2026-11-08T12:00:00+05:30");
  const rows = withDays([item("a", "2026-11-08T05:00:00Z"), item("b", "2026-11-08T04:00:00Z"), item("c", "2026-11-07T05:00:00Z")], now);
  assert.deepEqual(rows.map((r) => r.day), ["Today", null, "Yesterday"]);
});
