import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, member, owner } from "./helpers.js";

beforeEach(freshDb);

async function setup() {
  const b = await owner();
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  return { b, a };
}
const add = (b, a, title, text) => b.post(`/api/agents/${a.id}/knowledge`).send({ title, text });
const callOf = async (id, a) => { await internal("put", `/internal/v1/calls/${id}`).send({ agent_id: a.id }); };
const ask = (id, question) => internal("post", `/internal/v1/calls/${id}/tools/search_knowledge`).send({ question });

const FAQ = `Home loans start at 8.5 percent interest per year. The processing fee is one percent of the loan amount.

Personal loans can be taken for up to five years. Prepayment is allowed after six months with no penalty.

Our branches are open Monday to Saturday from ten in the morning to six in the evening.`;

describe("the knowledge an agent can answer from", () => {
  it("adds, lists and removes documents", async () => {
    const { b, a } = await setup();
    const made = await add(b, a, "Loan FAQ", FAQ);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ title: "Loan FAQ" });
    const list = (await b.get(`/api/agents/${a.id}/knowledge`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Loan FAQ", chars: FAQ.length });
    expect(list[0].text).toBeUndefined(); // the list is a list, not the documents
    expect((await b.delete(`/api/agents/${a.id}/knowledge/${made.body.id}`)).status).toBe(200);
    expect((await b.get(`/api/agents/${a.id}/knowledge`)).body).toEqual([]);
  });

  it("keeps documents to a size a call can use", async () => {
    const { b, a } = await setup();
    expect((await add(b, a, "", "text")).status).toBe(400);
    expect((await add(b, a, "T", "")).status).toBe(400);
    expect((await add(b, a, "T".repeat(121), "text")).status).toBe(400);
    expect((await add(b, a, "T", "x".repeat(20001))).status).toBe(400);
    for (let i = 0; i < 30; i++) expect((await add(b, a, `Doc ${i}`, "some text about loans")).status).toBe(200);
    expect((await add(b, a, "One too many", "text")).status).toBe(400);
  });

  it("can be changed only by those who build agents, and never across organizations", async () => {
    const { b, a } = await setup();
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await add(v, a, "T", "text")).status).toBe(403);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await add(other, a, "T", "text")).status).toBe(404);
    expect((await other.get(`/api/agents/${a.id}/knowledge`)).status).toBe(404);
    const made = await add(b, a, "Loan FAQ", FAQ);
    expect((await other.delete(`/api/agents/${a.id}/knowledge/${made.body.id}`)).status).toBe(404);
  });

  it("answers a question on a call with the matching passage", async () => {
    const { b, a } = await setup();
    await add(b, a, "Loan FAQ", FAQ);
    await callOf("kb-call-1", a);
    const r = await ask("kb-call-1", "what is the interest rate on a home loan");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.passages[0].text).toMatch(/8\.5 percent/);
    expect(r.body.passages[0].source).toBe("Loan FAQ");
    expect(r.body.passages.length).toBeLessThanOrEqual(3);
    expect((await ask("kb-call-1", "when are the branches open")).body.passages[0].text).toMatch(/Monday to Saturday/);
  });

  it("says plainly when it has nothing, so the agent does not invent an answer", async () => {
    const { b, a } = await setup();
    await add(b, a, "Loan FAQ", FAQ);
    await callOf("kb-call-2", a);
    const r = (await ask("kb-call-2", "do you sell insurance for pets")).body;
    expect(r.ok).toBe(true);
    expect(r.passages).toEqual([]);
    expect(r.message).toMatch(/do not have that|not have/i);
  });

  it("only ever reads the documents of the agent on the call", async () => {
    const { b, a } = await setup();
    const other = (await b.post("/api/agents").send({ name: "Sam", prompt: "You are Sam." })).body;
    await add(b, other, "Secret", "The staff discount code is ORCHID-77.");
    await add(b, a, "Loan FAQ", FAQ);
    await callOf("kb-call-3", a);
    const r = (await ask("kb-call-3", "staff discount code")).body;
    expect(JSON.stringify(r)).not.toMatch(/ORCHID/);
  });

  it("is a tool an agent can be given, and the prompt check knows it", async () => {
    const { b, a } = await setup();
    const r = await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "search_knowledge"] });
    expect(r.status).toBe(200);
    expect((await b.get("/api/tools")).body.map((t) => t.name)).toContain("search_knowledge");
  });

  it("copes with odd questions", async () => {
    const { b, a } = await setup();
    await add(b, a, "Loan FAQ", FAQ);
    await callOf("kb-call-4", a);
    for (const q of ["", "   ", "%%%", "a".repeat(5000), null, { x: 1 }]) {
      const r = await ask("kb-call-4", q);
      expect(r.status, JSON.stringify(q)?.slice(0, 20)).toBe(200);
      expect(r.body.ok === true || r.body.ok === false).toBe(true);
    }
  });
});
