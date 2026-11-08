import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, line, owner, publish, OURS } from "./helpers.js";
import { fileStem, transcriptText } from "../src/models/transcriptText.js";

beforeEach(freshDb);

const turns = [
  { at: "2026-11-08T10:25:12.000Z", role: "agent", text: "Hello, this is Ria." },
  { at: "2026-11-08T10:25:20.000Z", role: "caller", text: "Hi, who is this?" },
];
const call = { name: "Ravi Kumar", peer: "+919876543210", agent: "Ria", startedAt: "2026-11-08T10:25:00.000Z", durationSecs: 200 };

describe("a transcript as plain text", () => {
  it("says who, when and how long, then each line with its time in India", () => {
    const text = transcriptText({ ...call, turns, answers: [] });
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Call with Ravi Kumar (+919876543210)", "Agent: Ria", "Date: 8 Nov 2026, 3:55 pm IST", "Length: 3 min 20 sec"]);
    expect(text).toContain("[3:55:12 pm] Agent: Hello, this is Ria.");
    expect(text).toContain("[3:55:20 pm] Caller: Hi, who is this?");
  });

  it("lists what was saved on the call, and leaves the heading out when nothing was", () => {
    const withAnswers = transcriptText({ ...call, turns, answers: [{ label: "Payment date", value: "2026-11-20" }] });
    expect(withAnswers).toContain("Saved on this call:\nPayment date: 2026-11-20");
    expect(transcriptText({ ...call, turns, answers: [] })).not.toContain("Saved on this call");
  });

  it("copes with a call nobody is named on and nothing was said", () => {
    const text = transcriptText({ peer: null, turns: [], answers: [] });
    expect(text.split("\n")[0]).toBe("Call with an unknown caller");
    expect(text).toContain("Nothing was said on this call.");
  });
});

describe("the name a call's files are given", () => {
  it("is the person, the day, the time and a short id, and nothing a path could misuse", () => {
    expect(fileStem({ name: "Ravi Kumar", startedAt: "2026-11-08T10:25:00.000Z", callId: "ab12cd34-0000-4000-8000-000000000000" }))
      .toBe("Ravi-Kumar_2026-11-08_1555_ab12cd34");
    const hostile = fileStem({ name: "../../etc/passwd\u0000 \"x\"", startedAt: "2026-11-08T10:25:00.000Z", callId: "ab12cd34-0000" });
    expect(hostile).toMatch(/^[A-Za-z0-9_-]+$/);   // nothing a path or a header could misuse
    expect(hostile.endsWith("_2026-11-08_1555_ab12cd34")).toBe(true);
  });

  it("falls back to the number, then to unknown, and never gets long", () => {
    expect(fileStem({ name: null, peer: "+919876543210", startedAt: "2026-11-08T10:25:00.000Z", callId: "ab12cd34" }))
      .toBe("919876543210_2026-11-08_1555_ab12cd34");
    expect(fileStem({ startedAt: null, callId: "ab12cd34" })).toMatch(/^unknown_undated_ab12cd34$/);
    expect(fileStem({ name: "x".repeat(300), startedAt: "2026-11-08T10:25:00.000Z", callId: "ab12cd34" }).length).toBeLessThan(80);
  });
});

describe("downloading it, and finding one agent's calls", () => {
  const CALL = "99999999-9999-9999-9999-999999999999";
  async function aCall(b) {
    await line(b);
    await b.post("/api/contacts").send({ name: "Ravi Kumar", numbers: ["+919876543210"] });
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    await publish(b, a.id).catch(() => {});
    await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: "2026-11-08T10:25:00.000Z" },
      { event: "turn", role: "assistant", text: "Hello, this is Ria.", at: "2026-11-08T10:25:12.000Z" },
      { event: "turn", role: "user", text: "Hi", at: "2026-11-08T10:25:20.000Z" },
    ] });
    return a;
  }

  it("serves a text file named for the person", async () => {
    const b = await owner();
    await aCall(b);
    const r = await b.get(`/api/calls/${CALL}/transcript.txt`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect(r.headers["content-disposition"]).toContain("Ravi-Kumar_2026-11-08_1555_99999999.txt");
    expect(r.text).toContain("Call with Ravi Kumar");
    expect(r.text).toContain("Caller: Hi");
  });

  it("is not another organization's", async () => {
    const b = await owner();
    await aCall(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.get(`/api/calls/${CALL}/transcript.txt`)).status).toBe(404);
  });

  it("lists only the calls an agent took", async () => {
    const b = await owner();
    const a = await aCall(b);
    const mine = await b.get(`/api/calls?agent_id=${a.id}`);
    expect(mine.body.calls.map((c) => c.call_id)).toEqual([CALL]);
    expect((await b.get("/api/calls?agent_id=ag_000000000000")).body.calls).toEqual([]);
    expect((await b.get("/api/calls?agent_id=nope")).status).toBe(400);
  });
});
