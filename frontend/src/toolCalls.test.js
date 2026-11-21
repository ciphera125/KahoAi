import assert from "node:assert/strict";
import { test } from "node:test";
import { dueState, liveToolLine, pillClass, RESULT_FILTERS, toolCallsUrl, weave } from "./toolCalls.js";

test("each outcome has a colour that says whether it needs you", () => {
  assert.equal(pillClass("worked"), "live");
  assert.equal(pillClass("failed"), "failed");
  assert.equal(pillClass("not_attached"), "failed");
  assert.equal(pillClass("needs_info"), "muted");
  assert.equal(pillClass("blocked"), "muted");
  assert.equal(pillClass("unknown"), "unknown");
  assert.equal(pillClass("anything else"), "unknown");
});

test("the result filter offers what needs attention first, then the rest", () => {
  assert.deepEqual(RESULT_FILTERS.map(([v]) => v), ["", "attention", "worked", "held", "unknown"]);
});

test("the request carries only the filters that are set, and the page", () => {
  assert.equal(toolCallsUrl({ tool: "", outcome: "attention", agent_id: "ag_1", contact: "98765 43210", from: "", to: "" }, 2, 25),
    "/api/calls/tools?outcome=attention&agent_id=ag_1&contact=98765+43210&page=2&per_page=25");
  assert.equal(toolCallsUrl({}, 1, 10), "/api/calls/tools?page=1&per_page=10");
});

test("tool calls are woven into the transcript exactly where they happened", () => {
  const turns = [{ seq: 2, role: "caller", text: "Bye" }, { seq: 9, role: "agent", text: "Goodbye!" }];
  const tree = { turns: [{ calls: [{ id: 5, summary: "Ended the call after the goodbye." }] }] };
  assert.deepEqual(weave(turns, tree).map((x) => [x.kind, x.text ?? x.summary]),
    [["turn", "Bye"], ["tool", "Ended the call after the goodbye."], ["turn", "Goodbye!"]]);
});

test("the order comes from each line's place in the call, never from its clock time", () => {
  // the transcript's own lines carry an `at` time; it must not be mistaken for their place
  const turns = [{ seq: 2, at: "2026-11-08T10:00:01.000Z", role: "caller", text: "Bye" },
    { seq: 9, at: "2026-11-08T10:00:03.000Z", role: "agent", text: "Goodbye!" }];
  const tree = { turns: [{ calls: [{ id: 5, at: "2026-11-08T10:00:02.000Z", summary: "Ended the call." }] }] };
  assert.deepEqual(weave(turns, tree).map((x) => x.text ?? x.summary), ["Bye", "Ended the call.", "Goodbye!"]);
  assert.equal(weave(turns, tree)[0].at, "2026-11-08T10:00:01.000Z"); // and the time is still there to show
});

test("without tool calls, or before they load, the transcript is just the transcript", () => {
  const turns = [{ seq: 2, role: "caller", text: "Hi" }];
  assert.deepEqual(weave(turns, null).map((x) => x.kind), ["turn"]);
  assert.deepEqual(weave(null, null), []);
});

test("a task is overdue, due today or later, by India's day", () => {
  const now = new Date("2026-11-09T10:00:00Z"); // 15:30 on Monday the 9th in India
  assert.equal(dueState({ status: "pending", due_at: "2026-11-08T18:30:00Z" }, now), "today"); // still the 8th in UTC, midnight of the 9th in India
  assert.equal(dueState({ status: "pending", due_at: "2026-11-08T18:29:00Z" }, now), "overdue"); // 23:59 on the 8th in India
  assert.equal(dueState({ status: "pending", due_at: "2026-11-09T03:30:00Z" }, now), "today"); // 9 am today, already gone, still today
  assert.equal(dueState({ status: "pending", due_at: "2026-11-10T03:30:00Z" }, now), "later");
  assert.equal(dueState({ status: "pending", due_at: null }, now), "none");
  assert.equal(dueState({ status: "done", due_at: "2026-11-01T03:30:00Z" }, now), "done");
});

test("the live transcript says how a tool call went, not only its name", () => {
  assert.equal(liveToolLine({ name: "capture_lead", label: "Save details", outcome: "worked" }), "Save details");
  assert.equal(liveToolLine({ name: "capture_lead", label: "Save details", outcome: "needs_info" }), "Save details: needed more from the caller");
  assert.equal(liveToolLine({ name: "end_call", label: "End the call", outcome: "blocked" }), "End the call: stopped by a safety check");
  assert.equal(liveToolLine({ name: "call_webhook", label: "Your system", outcome: "failed" }), "Your system: did not work");
  assert.equal(liveToolLine({ event: "tool_rejected", name: "get_balance", label: "get_balance", outcome: "not_attached" }),
    "Tried to use get_balance, which this agent does not have");
  assert.equal(liveToolLine({ name: "end_call" }), "end_call"); // an older line with nothing more
});
