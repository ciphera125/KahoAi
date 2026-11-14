import test from "node:test";
import assert from "node:assert/strict";
import { bulkMessage, runEach, slotsText } from "./bulk.js";

test("runEach reports how many worked and how many failed, and tries every one", async () => {
  const seen = [];
  const r = await runEach(["a", "b", "c"], async (id) => { seen.push(id); if (id === "b") throw new Error("nope"); });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(r, { done: 2, failed: 1, firstError: "nope" });
});

test("runEach with nothing failing has no error", async () => {
  assert.deepEqual(await runEach(["a"], async () => {}), { done: 1, failed: 0, firstError: null });
});

test("a message never claims success it did not have", () => {
  assert.deepEqual(bulkMessage("deleted", { done: 3, failed: 0 }), { text: "3 contacts deleted.", bad: false });
  assert.deepEqual(bulkMessage("deleted", { done: 1, failed: 0 }), { text: "1 contact deleted.", bad: false });
  assert.deepEqual(bulkMessage("marked Do not call", { done: 2, failed: 1, firstError: "forbidden" }),
    { text: "2 contacts marked Do not call. 1 could not be changed (forbidden). Try again.", bad: true });
  assert.deepEqual(bulkMessage("deleted", { done: 0, failed: 2, firstError: "x" }),
    { text: "None were deleted. 2 could not be changed (x). Try again.", bad: true });
});

test("slotsText says how many are on the line at once and that a new call starts as each one ends", () => {
  assert.equal(slotsText(50, 7), "7 at a time: a new call starts as soon as one ends.");
  assert.equal(slotsText(5, 7), "all 5 at once.");
  assert.equal(slotsText(7, 7), "all 7 at once.");
  assert.equal(slotsText(10, 1), "1 at a time: a new call starts as soon as one ends.");
  assert.equal(slotsText(1, 1), "just 1 call.");
});


test("countsKey changes when anything the rows depend on changes, and only then", async () => {
  const { countsKey } = await import("./bulk.js");
  const run = { status: "running", waiting: null, counts: { queued: 5, calling: 2, done: 3, answered: 1, skipped: 0, failed: 0, total: 10 } };
  assert.equal(countsKey(run), countsKey({ ...run }));
  assert.notEqual(countsKey(run), countsKey({ ...run, counts: { ...run.counts, calling: 1, done: 4 } }));
  assert.notEqual(countsKey(run), countsKey({ ...run, status: "paused" }));
  assert.notEqual(countsKey(run), countsKey({ ...run, counts: { ...run.counts, answered: 2 } }));
  assert.equal(countsKey(null), "");
});
