import assert from "node:assert/strict";
import { test } from "node:test";
import { pageNumbers, paginate } from "./paginate.js";

const items = Array.from({ length: 23 }, (_, i) => i + 1);

test("a page is a slice of the list, with where it starts and ends", () => {
  const p = paginate(items, 1, 10);
  assert.deepEqual(p.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([p.page, p.pages, p.total, p.from, p.to], [1, 3, 23, 1, 10]);
});

test("the last page holds what is left", () => {
  const p = paginate(items, 3, 10);
  assert.deepEqual(p.items, [21, 22, 23]);
  assert.deepEqual([p.from, p.to], [21, 23]);
});

test("a page that does not exist is brought back to the nearest one", () => {
  assert.equal(paginate(items, 99, 10).page, 3);
  assert.equal(paginate(items, 0, 10).page, 1);
  assert.equal(paginate(items, -4, 10).page, 1);
  assert.equal(paginate(items, "x", 10).page, 1);
});

test("an empty list is one empty page, not zero pages", () => {
  const p = paginate([], 1, 10);
  assert.deepEqual([p.items.length, p.pages, p.from, p.to, p.total], [0, 1, 0, 0, 0]);
});

test("deleting the last item on the last page moves back a page", () => {
  const before = paginate(items.slice(0, 21), 3, 10);
  assert.equal(before.items.length, 1);
  assert.equal(paginate(items.slice(0, 20), before.page, 10).page, 2);
});

test("a nonsense page size falls back to ten", () => {
  assert.equal(paginate(items, 1, 0).items.length, 10);
  assert.equal(paginate(items, 1, "lots").items.length, 10);
});

test("the numbers shown are a short run around where you are, never a wall", () => {
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3]);
  assert.deepEqual(pageNumbers(1, 20), [1, 2, 3, "…", 20]);
  assert.deepEqual(pageNumbers(10, 20), [1, "…", 9, 10, 11, "…", 20]);
  assert.deepEqual(pageNumbers(20, 20), [1, "…", 18, 19, 20]);
});

test("a list paged by the server gets the same footer from its total", async () => {
  const { serverView } = await import("./paginate.js");
  assert.deepEqual(serverView({ page: 2, total: 23, size: 10 }), { page: 2, pages: 3, total: 23, from: 11, to: 20 });
  assert.deepEqual(serverView({ page: 3, total: 23, size: 10 }), { page: 3, pages: 3, total: 23, from: 21, to: 23 });
  assert.deepEqual(serverView({ page: 1, total: 0, size: 10 }), { page: 1, pages: 1, total: 0, from: 0, to: 0 });
});

test("every page offers the same three sizes, and the server accepts exactly those", async () => {
  const { SIZES } = await import("./paginate.js");
  assert.deepEqual(SIZES, [10, 25, 50]);
});
