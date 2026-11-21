// What the agent does when the caller goes quiet (owner, 2026-11-22): it waited in silence forever, so a
// caller who put the phone down or did not hear the question left the call hanging. Each agent now says
// how long to wait, what to say, how many times, and whether to say goodbye and hang up after that.
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, owner, publish } from "./helpers.js";

beforeEach(freshDb);

async function agent(b) {
  return (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
}

describe("following up when the caller goes quiet", () => {
  it("is on for every agent, after 10 seconds, twice, then a goodbye", async () => {
    const b = await owner();
    const a = await agent(b);
    expect(a.settings.silence).toEqual({ enabled: true, after_secs: 10, times: 2, message: "", hang_up: true });
  });

  it("is set per agent, and checked", async () => {
    const b = await owner();
    const a = await agent(b);
    const r = await b.patch(`/api/agents/${a.id}`).send({ settings: { silence: { after_secs: 15, times: 3, message: "  Hello, are you still there?  ", hang_up: false } } });
    expect(r.status).toBe(200);
    expect(r.body.settings.silence).toEqual({ enabled: true, after_secs: 15, times: 3, message: "Hello, are you still there?", hang_up: false });
    const off = await b.patch(`/api/agents/${a.id}`).send({ settings: { silence: { enabled: false } } });
    expect(off.body.settings.silence).toMatchObject({ enabled: false, after_secs: 15 }); // the rest is kept
    for (const bad of [{ after_secs: 2 }, { after_secs: 120 }, { after_secs: "ten" }, { times: 0 }, { times: 9 },
      { message: "x".repeat(201) }, { nonsense: 1 }, "on", [1]]) {
      expect((await b.patch(`/api/agents/${a.id}`).send({ settings: { silence: bad } })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("reaches the call with everything else the agent is set to", async () => {
    const b = await owner();
    const a = await agent(b);
    await b.patch(`/api/agents/${a.id}`).send({ settings: { silence: { after_secs: 12 } } });
    await publish(b, a.id).catch(() => {});
    const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
    expect(r.body.config.silence).toEqual({ enabled: true, after_secs: 12, times: 2, message: "", hang_up: true });
  });
});
