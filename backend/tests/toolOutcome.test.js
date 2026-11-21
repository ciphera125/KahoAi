// What a tool call's result means, in words a business owner can act on (2026-11-22).
// Before this the history had two answers, "Worked" and "Did not work": a safety check doing its job
// (the agent tried to hang up before a goodbye) looked like a breakdown, an old row with no result looked
// like a success, a tool refused for bad arguments was called "not one of its tools", and a successful
// document search showed the model's instructions ("answer only from these passages") as its explanation.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classify, describeCall, GROUPS, matchReason, OUTCOME_LABELS, OUTCOMES, succeeded, parseToolText }
  from "../src/models/toolOutcome.js";

const text = (args, result) => JSON.stringify({ args, result });
const of = (name, result, extra = {}) => classify({ event: "tool", name, ok: succeeded(result), text: text({}, result), ...extra });

describe("whether a tool did what it was asked (the same rule the voice service writes `ok` with)", () => {
  it("an error, or a flag saying it did not, is a failure", () => {
    expect(succeeded({ error: "x" })).toBe(false);
    for (const flag of ["ok", "saved", "added", "moved", "done"]) expect(succeeded({ [flag]: false })).toBe(false);
  });
  it("advice on its own means it could not; advice beside `found` rides along with a good answer", () => {
    expect(succeeded({ what_to_do: "I could not add it." })).toBe(false);
    expect(succeeded({ found: false, what_to_do: "I do not have that in my documents." })).toBe(true);
    expect(succeeded({ found: true, passages: ["x"], what_to_do: "Answer only from these passages" })).toBe(true);
  });
  it("anything else ran", () => {
    expect(succeeded({ status: "ending" })).toBe(true);
    expect(succeeded(null)).toBe(true);
  });
});

describe("reading a stored line", () => {
  it("splits what was sent from what came back, and survives a cut or broken line", () => {
    expect(parseToolText('{"args":{"a":1},"result":{"b":2}}')).toEqual({ args: { a: 1 }, result: { b: 2 } });
    expect(parseToolText('{"args":{"a":1},"res')).toBeNull();
    expect(parseToolText(null)).toBeNull();
    expect(parseToolText("[1,2]")).toBeNull();
  });
});

describe("the six outcomes", () => {
  it("has a plain label for each, and groups them the way the filter offers them", () => {
    expect(OUTCOMES).toEqual(["worked", "needs_info", "blocked", "failed", "not_attached", "unknown"]);
    for (const o of OUTCOMES) expect(OUTCOME_LABELS[o]).toMatch(/\w/);
    expect(GROUPS).toEqual({ worked: ["worked"], attention: ["failed", "not_attached"], held: ["needs_info", "blocked"], unknown: ["unknown"] });
  });

  it("a tool that did its job worked, whatever advice came with it", () => {
    expect(of("end_call", { status: "ending" })).toBe("worked");
    expect(of("search_knowledge", { found: false, what_to_do: "I do not have that in my documents." })).toBe("worked");
    expect(of("capture_lead", { status: "already_saved", phone_saved: "XXXXXX1234" })).toBe("worked");
  });

  it("the result decides, not an `ok` an older voice service got wrong", () => {
    expect(classify({ event: "tool", name: "search_knowledge", ok: false,
      text: text({ question: "fees" }, { found: true, passages: ["500"], what_to_do: "Answer only from these passages" }) })).toBe("worked");
  });

  it("an old row with no result and no `ok` is 'not recorded', never quietly 'worked'", () => {
    expect(classify({ event: "tool", name: "capture_lead", ok: null, text: null })).toBe("unknown");
    expect(classify({ event: "tool", name: "capture_lead", ok: null, text: "{}" })).toBe("unknown");
    // a line too long to keep whole falls back to the `ok` that was written with it
    expect(classify({ event: "tool", name: "end_call", ok: true, text: '{"args":{},"res' })).toBe("worked");
    expect(classify({ event: "tool", name: "end_call", ok: false, text: '{"args":{},"res' })).toBe("failed");
  });

  it("a safety check that stopped the agent is not a breakdown", () => {
    expect(of("end_call", { error: "the caller has not said goodbye, so do not hang up; keep helping, or ask if there is anything else you can do for them" })).toBe("blocked");
    expect(of("capture_lead", { error: "the caller has not said anything yet; never save a lead before they ask for a callback and give their details" })).toBe("blocked");
    expect(of("capture_lead", { error: "do not guess; ask the caller for their real name" })).toBe("blocked");
    expect(of("capture_lead", { error: "the caller has not told you that name; ask them for their name" })).toBe("blocked");
    expect(of("save_answer", { saved: false, what_to_do: "That is not one of this call's questions. Carry on." })).toBe("blocked");
  });

  it("a tool waiting on something only the caller can give needed more info", () => {
    expect(of("capture_lead", { error: "a name and a reason are both needed; ask the caller for the missing one" })).toBe("needs_info");
    expect(of("add_task", { added: false, what_to_do: "I did not catch the date. Please ask for the exact date, like the fifteenth of December." })).toBe("needs_info");
    expect(of("reschedule_task", { moved: false, what_to_do: "I could not find that task on their list. Please check with them." })).toBe("needs_info");
    expect(of("save_answer", { saved: false, what_to_do: "I could not tell whether that was a yes or a no. Please ask again." })).toBe("needs_info");
    expect(of("look_up_contact", { what_to_do: "I do not have their details. Ask them for anything you need." })).toBe("needs_info");
    expect(of("check_stock", { ok: false, what_to_do: "Ask them for the order number first." })).toBe("needs_info");
  });

  it("something that broke failed, and anything it cannot place counts as failed so it is seen", () => {
    expect(of("call_webhook", { error: "the business system did not answer; tell the caller you could not" })).toBe("failed");
    expect(of("call_webhook", { error: "the business system refused (HTTP 500); tell the caller" })).toBe("failed");
    expect(of("get_tasks", { what_to_do: "I could not read the list just now." })).toBe("failed");
    expect(of("transfer_to_human", { error: "this call cannot be transferred from here; offer to take a message" })).toBe("failed");
    expect(of("add_task", { added: false, what_to_do: "I do not know whose list to add that to. Carry on with the call." })).toBe("failed");
    expect(of("end_call", { error: "something nobody has written a rule for" })).toBe("failed");
  });

  it("a refused tool call is 'not switched on' only when the agent really did not have it", () => {
    const rejected = (name, attached) => classify({ event: "tool_rejected", name, ok: false, text: "Error code: 400 -", attached });
    expect(rejected("get_balance", ["end_call", "capture_lead"])).toBe("not_attached");
    // it had the tool and sent it the wrong details: that is a failure, not a missing switch
    expect(rejected("capture_lead", ["end_call", "capture_lead"])).toBe("failed");
    // nothing known about the agent: the old reading stands, unless no tool was named at all
    expect(rejected("get_balance", null)).toBe("not_attached");
    expect(rejected("unknown", null)).toBe("failed");
  });
});

describe("what the history says, in plain words", () => {
  const say = (name, args, result, extra = {}) => {
    const outcome = classify({ event: "tool", name, ok: succeeded(result), text: text(args, result) });
    return describeCall({ event: "tool", name, label: extra.label ?? name, outcome, args, result, ...extra });
  };

  it("says what a tool that worked actually did", () => {
    expect(say("end_call", {}, { status: "ending" }).summary).toBe("Ended the call after the goodbye.");
    expect(say("capture_lead", { name: "Asha", reason: "Wants a home loan" }, { status: "saved", phone_saved: "XXXXXX1234" }).summary)
      .toBe("Saved their details: Asha, “Wants a home loan”.");
    expect(say("capture_lead", { name: "Asha", reason: "x" }, { status: "already_saved" }).summary).toBe("Their details were already saved earlier on this call.");
    expect(say("get_tasks", { range: "today" }, { tasks: [{ id: "tk_1" }, { id: "tk_2" }], count: 2 }).summary).toBe("Read their task list (due today): 2 tasks.");
    expect(say("get_tasks", {}, { tasks: [], count: 0 }).summary).toBe("Read their task list: nothing to do.");
    expect(say("add_task", { title: "Pay the EMI", due: "Friday" }, { added: true, task_id: "tk_1", due: "2026-11-13T03:30:00.000Z" }).summary)
      .toBe("Added a task: “Pay the EMI”, due Fri 13 Nov, 9:00 am.");
    expect(say("add_task", { title: "Call back" }, { added: true, task_id: "tk_1", due: null }).summary).toBe("Added a task: “Call back”, with no date.");
    expect(say("reschedule_task", { task_id: "tk_1", due: "Friday" }, { moved: true, due: "2026-11-20T03:30:00.000Z" }, { taskTitles: { tk_1: "Pay EMI" } }).summary)
      .toBe("Moved “Pay EMI” to Fri 20 Nov, 9:00 am.");
    expect(say("mark_task_done", { task_id: "tk_1" }, { done: true, title: "Pay EMI" }).summary).toBe("Ticked off “Pay EMI”.");
    expect(say("save_answer", { field_key: "pay_date", said: "15th" }, { saved: true, value: "2026-12-15" }, { fieldLabels: { pay_date: "Payment date" } }).summary)
      .toBe("Saved Payment date: 2026-12-15.");
    expect(say("search_knowledge", { question: "fees" }, { found: true, passages: ["x"], what_to_do: "Answer only from these passages" }).summary)
      .toBe("Found the answer to “fees” in your documents.");
    expect(say("transfer_to_human", {}, { status: "transferring" }).summary).toBe("Passed the call to your team.");
    expect(say("check_stock", { item: "shoes" }, { ok: true }, { label: "Check stock" }).summary).toBe("Used “Check stock”: your system answered.");
  });

  it("never shows the model's own instructions as the explanation of a success", () => {
    const r = say("search_knowledge", { question: "fees" }, { found: true, passages: ["x"], what_to_do: "Answer only from these passages, in your own words" });
    expect(r.why).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/answer only from these passages/i);
  });

  it("an empty document search worked, and says what to add", () => {
    const r = say("search_knowledge", { question: "the moon" }, { found: false, what_to_do: "I do not have that in my documents." });
    expect(r.summary).toBe("Nothing in your documents answers “the moon”.");
    expect(r.fix).toMatch(/Knowledge/);
  });

  it("explains a held-back or failed call in plain words, and says what to do when there is something to do", () => {
    const held = say("end_call", {}, { error: "the caller has not said goodbye, so do not hang up; keep helping, or ask if there is anything else you can do for them" });
    expect(held.summary).toBe("Did not hang up: a safety check stopped it.");
    expect(held.why).toMatch(/had not said goodbye/i);
    expect(held.fix).toBeNull(); // nothing for the owner to do: the check worked

    const needs = say("capture_lead", {}, { error: "a name and a reason are both needed; ask the caller for the missing one" });
    expect(needs.summary).toBe("Did not save their details yet: it needed more from the caller.");
    expect(needs.why).toMatch(/name/i);

    const broke = say("add_task", { title: "Pay" }, { added: false, what_to_do: "I do not know whose list to add that to. Carry on with the call." });
    expect(broke.summary).toBe("Could not add the task.");
    expect(broke.fix).toMatch(/Contacts/);

    const odd = say("end_call", {}, { error: "something nobody has written a rule for" });
    expect(odd.why).toBe("something nobody has written a rule for"); // the tool's own words, when there is no plainer reading
  });

  it("names a refused tool call for what it was", () => {
    const off = describeCall({ event: "tool_rejected", name: "get_balance", label: "get_balance", outcome: "not_attached" });
    expect(off.summary).toBe("Tried to use “get_balance”, which this agent does not have. It answered in words instead.");
    expect(off.fix).toMatch(/Agents, then Tools/);
    const bad = describeCall({ event: "tool_rejected", name: "capture_lead", label: "Save details", outcome: "failed" });
    expect(bad.summary).toBe("Tried to use “Save details” with details that did not fit, so it was refused. It answered in words instead.");
  });

  it("says plainly when nothing was recorded", () => {
    expect(describeCall({ event: "tool", name: "capture_lead", label: "Save details", outcome: "unknown" }).summary)
      .toBe("Used “Save details”. Whether it worked was not recorded on this older call.");
  });

  it("keeps long caller words short", () => {
    const long = "a".repeat(300);
    expect(say("capture_lead", { name: "Asha", reason: long }, { status: "saved" }).summary.length).toBeLessThan(140);
  });
});

describe("every message a tool can send back has a reading (so a new one cannot slip by unclassified)", () => {
  const source = (p) => readFileSync(new URL(`../src/models/${p}`, import.meta.url), "utf8");
  const literals = (code, re) => [...code.matchAll(re)].map((m) => m[1].split("${")[0]).filter((s) => s.trim().length > 3);

  it("the Studio's own tool replies", () => {
    const messages = [
      ...literals(source("CallTool.js"), /no\(["`]([^"`]+)["`]\)/g),
      ...literals(source("CallTool.js"), /const [A-Z_]+ = "([^"]+)";/g),
      ...literals(source("answerValue.js"), /refuse\(["`]([^"`]+)["`]\)/g),
      ...literals(source("CallAnswer.js"), /say\(["`]([^"`]+)["`]/g),
      ...literals(source("CustomTool.js"), /message: ["`]([^"`]+)["`]/g),
    ];
    expect(messages.length).toBeGreaterThan(20);
    const unread = messages.filter((m) => !matchReason(m) && !/do not have that in my documents/i.test(m));
    expect(unread).toEqual([]);
  });
});
