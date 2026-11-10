import test from "node:test";
import assert from "node:assert/strict";
import { bulkMessage, runEach } from "./bulk.js";

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
