import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "./transcript.js";

const live = (role, text) => ({ event: "live", role, text });
const turn = (role, text) => ({ event: "turn", role, text });
const texts = (list) => list.map((m) => m.text);
const pairs = (list) => list.map((m) => [m.role, m.text]);

test("the agent's spoken words become one message, not one bubble per word", () => {
  const out = messages([live("agent", "Sorry,"), live("agent", "we're"), live("agent", "having"), live("agent", "a problem.")]);
  assert.deepEqual(texts(out), ["Sorry, we're having a problem."]);
});

test("the caller's growing interim text shows once, replacing the earlier guess", () => {
  const out = messages([live("caller", "send it"), live("caller", "send it to my"), live("caller", "send it to my mail id")]);
  assert.deepEqual(texts(out), ["send it to my mail id"]);
});

test("the finished turn replaces that speaker's captions", () => {
  const out = messages([live("agent", "Hello"), live("agent", "there."), turn("agent", "Hello there.")]);
  assert.deepEqual(pairs(out), [["agent", "Hello there."]]);
});

test("a new bubble starts when the speaker changes, in order", () => {
  const out = messages([turn("agent", "Hi."), live("caller", "yes"), live("agent", "Okay"), live("agent", "then")]);
  assert.deepEqual(pairs(out), [["agent", "Hi."], ["caller", "yes"], ["agent", "Okay then"]]);
});

test("other events pass through in place", () => {
  const out = messages([live("agent", "Hi"), { event: "tool", name: "end_call" }, live("agent", "bye")]);
  assert.deepEqual(out.map((m) => (m.event === "tool" ? "tool" : m.text)), ["Hi", "tool", "bye"]);
});
