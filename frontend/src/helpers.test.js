import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fmtBytes } from "./format.js";
import { debounce } from "./debounce.js";
import { callsUrl, recordingMessage } from "./recording.js";

test("fmtBytes: bytes, KB and MB, one decimal for MB", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2 KB");
  assert.equal(fmtBytes(1572864), "1.5 MB");
  assert.equal(fmtBytes(null), "");
  assert.equal(fmtBytes(-5), "");
});

test("debounce: only the last call in the window runs, and cancel stops it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const seen = [];
  const d = debounce((v) => seen.push(v), 300);
  d("a"); mock.timers.tick(200); d("ab"); mock.timers.tick(299);
  assert.deepEqual(seen, []);
  mock.timers.tick(1);
  assert.deepEqual(seen, ["ab"]);
  d("x"); d.cancel(); mock.timers.tick(1000);
  assert.deepEqual(seen, ["ab"]);
  mock.timers.reset();
});

test("callsUrl: keeps the query and page, trims, and encodes", () => {
  assert.equal(callsUrl({ page: 1, perPage: 10, q: "" }), "/api/calls?page=1&per_page=10");
  assert.equal(callsUrl({ page: 2, perPage: 10, q: "  refund & more " }), "/api/calls?page=2&per_page=10&q=refund%20%26%20more");
});

test("recordingMessage: friendly text for 404 and 503, generic otherwise", () => {
  assert.match(recordingMessage({ status: 404 }), /no recording/i);
  assert.match(recordingMessage({ status: 503 }), /not set up|not configured/i);
  assert.match(recordingMessage({ status: 500 }), /could not load/i);
});
