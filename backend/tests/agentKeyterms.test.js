// Words an agent should listen for (2026-11-22). Speech recognition mishears names it has not met: a doctor,
// a product, a town. Each agent now carries its own list, which reaches the call with the rest of what the
// agent is set to. The list goes into a connection to the speech provider and a bad word can make that
// provider refuse the call, so it is checked here and checked again on the phone server.
import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, member, owner, publish } from "./helpers.js";

beforeEach(freshDb);

async function agent(b) {
  return (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
}
const set = (b, id, keyterms) => b.patch(`/api/agents/${id}`).send({ settings: { keyterms } });

describe("the words an agent listens for", () => {
  it("is an empty list for a new agent", async () => {
    const b = await owner();
    const a = await agent(b);
    expect(a.settings.keyterms).toEqual([]);
  });

  it("is kept as typed, trimmed, without repeats", async () => {
    const b = await owner();
    const a = await agent(b);
    const r = await set(b, a.id, ["  Dr. Mehta ", "Apollo Clinic", "dr. mehta", "", "   "]);
    expect(r.status).toBe(200);
    expect(r.body.settings.keyterms).toEqual(["Dr. Mehta", "Apollo Clinic"]);
  });

  it("is replaced whole, and an empty list clears it", async () => {
    const b = await owner();
    const a = await agent(b);
    await set(b, a.id, ["Dr. Mehta"]);
    expect((await set(b, a.id, ["Dr. Rao"])).body.settings.keyterms).toEqual(["Dr. Rao"]);
    expect((await set(b, a.id, [])).body.settings.keyterms).toEqual([]);
  });

  it("keeps the rest of the settings when only the words change", async () => {
    const b = await owner();
    const a = await agent(b);
    await b.patch(`/api/agents/${a.id}`).send({ settings: { max_minutes: 7 } });
    const r = await set(b, a.id, ["Dr. Mehta"]);
    expect(r.body.settings).toMatchObject({ max_minutes: 7, keyterms: ["Dr. Mehta"] });
  });

  it("refuses what the speech provider would read wrongly or refuse", async () => {
    const b = await owner();
    const a = await agent(b);
    const bad = [
      "not a list", { a: 1 }, 7, null,
      ["fine", 5], ["fine", null], ["fine", ["nested"]],
      ["one, two"], ["one;two"], ["one\ntwo"], ["one\rtwo"], ["one\u0000two"], ["term:0.5"],
      ["x".repeat(41)],
      Array.from({ length: 51 }, (_, i) => `word${i}`),
      Array.from({ length: 40 }, (_, i) => `a rather long doctor name number ${i}`),
    ];
    for (const value of bad) {
      expect((await set(b, a.id, value)).status, JSON.stringify(value).slice(0, 60)).toBe(400);
    }
    // Nothing the refused requests carried was kept.
    expect((await b.get(`/api/agents/${a.id}`)).body.settings.keyterms).toEqual([]);
  });

  it("counts Hindi words by the character, since that is how a speech provider counts them", async () => {
    const b = await owner();
    const a = await agent(b);
    const hindi = Array.from({ length: 30 }, (_, i) => `डॉक्टर मेहता ${i}`);
    expect((await set(b, a.id, hindi)).status).toBe(400);
    expect((await set(b, a.id, ["डॉक्टर मेहता", "अपोलो क्लिनिक"])).status).toBe(200);
  });

  it("explains a refusal in plain words", async () => {
    const b = await owner();
    const a = await agent(b);
    const r = await set(b, a.id, ["one, two"]);
    expect(r.body.error).toMatch(/comma|semicolon|line/i);
  });

  it("reaches the call once the agent is published, with the rest of what it is set to", async () => {
    const b = await owner();
    const a = await agent(b);
    await set(b, a.id, ["Dr. Mehta", "Apollo Clinic"]);
    await publish(b, a.id).catch(() => {});
    const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
    expect(r.body.config.keyterms).toEqual(["Dr. Mehta", "Apollo Clinic"]);
  });

  it("is not heard by a call while it is only a draft", async () => {
    const b = await owner();
    const a = await agent(b);
    await set(b, a.id, ["Old Name"]);
    await publish(b, a.id).catch(() => {});
    await set(b, a.id, ["New Name"]);
    const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
    expect(r.body.config.keyterms).toEqual(["Old Name"]);
  });

  it("is an empty list for an agent published before this existed", async () => {
    const b = await owner();
    const a = await agent(b);
    await publish(b, a.id).catch(() => {});
    const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
    expect(r.body.config.keyterms).toEqual([]);
  });

  it("never hands a call something that is not a list, whatever is stored", async () => {
    const b = await owner();
    const a = await agent(b);
    await publish(b, a.id).catch(() => {});
    for (const junk of ['"junk"', "5", '{"a":1}', "null"]) {
      await db.query(`UPDATE agent_versions SET settings = settings || jsonb_build_object('keyterms', $1::jsonb)`, [junk]);
      const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
      expect(r.body.config.keyterms, junk).toEqual([]);
    }
  });
});

describe("who may change the words (pen-test, 2026-11-22)", () => {
  it("is not open to another organization", async () => {
    const mine = await owner();
    const a = await agent(mine);
    const other = await owner({ email: "zed@other.in", organization: "Other Co" });
    const r = await set(other, a.id, ["Hijacked"]);
    expect([403, 404]).toContain(r.status);
    expect((await mine.get(`/api/agents/${a.id}`)).body.settings.keyterms).toEqual([]);
  });

  it("is not open to a viewer, who may only look", async () => {
    const boss = await owner();
    const a = await agent(boss);
    const viewer = await member(boss, { role: "viewer" });
    expect((await set(viewer, a.id, ["Nope"])).status).toBe(403);
    expect((await boss.get(`/api/agents/${a.id}`)).body.settings.keyterms).toEqual([]);
  });

  it("is not open to someone not signed in", async () => {
    const boss = await owner();
    const a = await agent(boss);
    const { browser } = await import("./helpers.js");
    expect((await set(browser(), a.id, ["Nope"])).status).toBe(401);
  });
});
