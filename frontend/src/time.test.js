import assert from "node:assert/strict";
import { test } from "node:test";
import { dayWord } from "./time.js";

const NOW = new Date("2026-11-08T10:00:00+05:30");

test("a day is said the way people say it: today, yesterday, then the date", () => {
  assert.equal(dayWord("2026-11-08T03:00:00+05:30", NOW), "Today");
  assert.equal(dayWord("2026-11-07T23:30:00+05:30", NOW), "Yesterday");
  assert.equal(dayWord("2026-11-03T12:00:00+05:30", NOW), "3 Nov");
  assert.equal(dayWord("2025-12-25T12:00:00+05:30", NOW), "25 Dec 2025");
});

test("nothing to say is a dash, and a bad date is too", () => {
  assert.equal(dayWord(null, NOW), "-");
  assert.equal(dayWord("not a date", NOW), "-");
});

test("the day is India's, not the browser's", () => {
  // 00:30 India on the 8th is still the 7th in UTC.
  assert.equal(dayWord("2026-11-08T00:30:00+05:30", new Date("2026-11-08T08:00:00Z")), "Today");
});
