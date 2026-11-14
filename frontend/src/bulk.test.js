import test from "node:test";
import assert from "node:assert/strict";
import { bulkMessage, groupsText, runEach } from "./bulk.js";

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

test("groupsText says how a list is split into groups of the size chosen", () => {
  assert.equal(groupsText(22, 7), "7, 7, 7 and a last 1");
  assert.equal(groupsText(21, 7), "7, 7, 7");
  assert.equal(groupsText(5, 7), "one group of 5");
  assert.equal(groupsText(7, 7), "7");
  assert.equal(groupsText(50, 7), "7, 7, 7 \u2026 (7 groups of 7) and a last 1");
  assert.equal(groupsText(10, 1), "1, 1, 1 \u2026 (10 groups of 1)");
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
