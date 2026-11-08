import assert from "node:assert/strict";
import { test } from "node:test";
import { chartFacts } from "./chart.js";

const days = [
  { date: "2026-11-01", calls: 2, answered: 1 }, { date: "2026-11-02", calls: 0, answered: 0 },
  { date: "2026-11-03", calls: 9, answered: 6 }, { date: "2026-11-04", calls: 4, answered: 4 },
];

test("the top of the chart is a round number above the busiest day", () => {
  assert.equal(chartFacts(days).top, 10);
  assert.equal(chartFacts([{ date: "2026-11-01", calls: 23, answered: 1 }]).top, 25);
  assert.equal(chartFacts([{ date: "2026-11-01", calls: 3, answered: 1 }]).top, 4);
});

test("the busiest day is named, with how many were picked up", () => {
  const f = chartFacts(days);
  assert.deepEqual([f.busiest.date, f.busiest.calls, f.busiest.answered], ["2026-11-03", 9, 6]);
});

test("the totals match what the bars add up to", () => {
  const f = chartFacts(days);
  assert.deepEqual([f.calls, f.answered], [15, 11]);
});

test("a quiet stretch says so instead of drawing nothing", () => {
  const f = chartFacts([{ date: "2026-11-01", calls: 0, answered: 0 }]);
  assert.equal(f.busiest, null);
  assert.equal(f.top, 4);
  assert.equal(chartFacts([]).busiest, null);
});

test("the dates under the chart are the first, the middle and the last", () => {
  assert.deepEqual(chartFacts(days).ticks.map((t) => t.date), ["2026-11-01", "2026-11-02", "2026-11-04"]);
  assert.deepEqual(chartFacts(days.slice(0, 1)).ticks.map((t) => t.date), ["2026-11-01"]);
});
