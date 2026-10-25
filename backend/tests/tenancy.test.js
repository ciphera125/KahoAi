import { beforeEach, describe, expect, it } from "vitest";
import { browser, db, freshDb, internal, member, owner } from "./helpers.js";
import { pool } from "../src/db/pool.js";

beforeEach(freshDb);

async function twoTeams() {
  const a = await owner();
  const b = await owner({ name: "Bilal", email: "bilal@beta.in", organization: "Beta" });
  const agent = (await a.post("/api/agents").send({ name: "A agent", prompt: "secret prompt of team A" })).body;
  const prompt = (await a.post("/api/prompts").send({ name: "A loose", prompt: "loose" })).body;
  const tag = (await a.post("/api/tags").send({ name: "A tag", color: "plum" })).body;
  const contact = (await a.post("/api/contacts").send({ name: "A person", numbers: ["9876543210"], tags: [tag.id] })).body;
  const number = (await a.post("/api/numbers").send({ provider: "plivo", number: "8065520552",
    credentials: { auth_id: "AID", auth_token: "team-a-token" } })).body;
  await internal("put", "/internal/v1/calls/call-a0001").send({ agent_id: agent.id, status: "answered", peer: "+919876543210",
    at: new Date().toISOString() });
  await internal("post", "/internal/v1/calls/call-a0001/events").send({ events: [{ event: "call_start" },
    { event: "turn", role: "user", text: "team A caller words" }, { event: "call_end" }] });
  return { a, b, agent, prompt, tag, contact, number, versionId: (await a.get(`/api/prompts/${prompt.id}/versions`)).body[0].id };
}

describe("organizations", () => {
  it("lets anyone sign up and create their own organization, as its owner", async () => {
    const a = await owner();
    const b = await owner({ name: "Bilal", email: "bilal@beta.in", organization: "Beta" });
    expect(a.user).toMatchObject({ role: "owner", org_name: "Acme" });
    expect(b.user).toMatchObject({ role: "owner", org_name: "Beta" });
    expect(a.user.org_id).not.toBe(b.user.org_id);
    const bad = await browser().post("/api/auth/signup").send({ name: "C", email: "c@c.in", password: "12345678" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("enter your organization's name (up to 80 characters)");
  });

  it("puts someone with an invite code into that organization only, as a member", async () => {
    const a = await owner();
    await owner({ name: "Bilal", email: "bilal@beta.in", organization: "Beta" });
    const m = await member(a);
    expect(m.user).toMatchObject({ role: "member", org_id: a.user.org_id, org_name: "Acme" });
  });
});

describe("one team never sees another's data", () => {
  it("hides every list", async () => {
    const { b } = await twoTeams();
    for (const path of ["/api/agents", "/api/prompts", "/api/tags", "/api/numbers"]) {
      expect((await b.get(path)).body, path).toEqual([]);
    }
    expect((await b.get("/api/contacts")).body).toMatchObject({ total: 0, contacts: [] });
    expect((await b.get("/api/calls")).body).toMatchObject({ total: 0, calls: [] });
    expect((await b.get("/api/dashboard")).body.totals.calls).toBe(0);
    const notes = (await b.get("/api/notifications")).body.items.map((n) => n.text).join(" ");
    expect(notes).not.toMatch(/A agent|A person|A tag|8065520552/);
    const me = (await b.get("/api/me")).body;
    expect(me.counts).toEqual({ numbers: 0, agents: 0, prompts: 0, contacts: 0, calls: 0, members: 1 });
    expect(me.members.map((x) => x.email)).toEqual(["bilal@beta.in"]);
  });

  it("answers 404 to every read and change of another team's records", async () => {
    const { b, agent, prompt, tag, contact, number, versionId } = await twoTeams();
    const n = contact.numbers[0].id;
    const attempts = [
      ["get", `/api/agents/${agent.id}`], ["patch", `/api/agents/${agent.id}`, { name: "x" }],
      ["delete", `/api/agents/${agent.id}`],
      ["get", `/api/prompts/${prompt.id}`], ["patch", `/api/prompts/${prompt.id}`, { text: "x" }],
      ["delete", `/api/prompts/${prompt.id}`], ["get", `/api/prompts/${prompt.id}/versions`],
      ["post", `/api/prompts/${prompt.id}/versions/${versionId}/restore`],
      ["delete", `/api/prompts/${prompt.id}/versions/${versionId}`],
      ["post", `/api/prompts/${prompt.id}/assign`, { agent_id: null }],
      ["patch", `/api/tags/${tag.id}`, { name: "x" }], ["delete", `/api/tags/${tag.id}`],
      ["patch", `/api/contacts/${contact.id}`, { name: "x" }], ["delete", `/api/contacts/${contact.id}`],
      ["post", `/api/contacts/${contact.id}/numbers`, { number: "9000000000" }],
      ["patch", `/api/contacts/${contact.id}/numbers/${n}`, { number: "9000000001" }],
      ["delete", `/api/contacts/${contact.id}/numbers/${n}`], ["get", `/api/contacts/${contact.id}/calls`],
      ["patch", `/api/numbers/${number.id}`, { label: "x" }], ["delete", `/api/numbers/${number.id}`],
      ["post", `/api/numbers/${number.id}/default`], ["post", `/api/numbers/${number.id}/agent`, { agent_id: null }],
      ["get", "/api/calls/call-a0001/transcript"], ["get", "/api/calls/call-a0001/transcript.csv"],
    ];
    for (const [method, path, body] of attempts) {
      const r = await b[method](path).send(body);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // Nothing changed for team A.
    const { rows } = await db.query("SELECT name FROM agents");
    expect(rows).toEqual([{ name: "A agent" }]);
  });

  it("will not let a team use another team's records inside its own", async () => {
    const { b, agent, tag } = await twoTeams();
    expect((await b.post("/api/prompts").send({ name: "x", prompt: "y", agent_id: agent.id })).status).toBe(404);
    expect((await b.post("/api/contacts").send({ name: "x", tags: [tag.id] })).body.error).toBe("unknown tag");
    const mine = (await b.post("/api/numbers").send({ provider: "plivo", number: "9111111111",
      credentials: { auth_id: "B", auth_token: "t" } })).body;
    expect((await b.post(`/api/numbers/${mine.id}/agent`).send({ agent_id: agent.id })).status).toBe(404);
    expect((await b.post("/api/calls").send({ from_id: mine.id, to: "9000000000", consent: true, agent_id: agent.id })).body.error)
      .toBe("choose an agent that exists");
    expect((await b.post("/api/contacts/delete").send({ ids: [(await db.query("SELECT id FROM contacts")).rows[0].id] })).body)
      .toEqual({ deleted: 0 });
  });

  it("keeps a number with the team that added it", async () => {
    const { b } = await twoTeams();
    const r = await b.post("/api/numbers").send({ provider: "plivo", number: "8065520552", credentials: { auth_id: "B", auth_token: "t" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("+918065520552 is already in use");
  });

  it("shows a call the voice service could not match to a team to no team at all", async () => {
    const { a, b } = await twoTeams();
    await internal("post", "/internal/v1/calls/call-orphan/events").send({ events: [{ event: "call_start" }] });
    for (const t of [a, b]) {
      expect((await t.get("/api/calls")).body.calls.map((c) => c.call_id)).not.toContain("call-orphan");
      expect((await t.get("/api/calls/call-orphan/transcript")).status).toBe(404);
    }
  });

  it("is enforced by the database too: the app's own connection cannot read across teams", async () => {
    const { a, b } = await twoTeams();
    const client = await pool.connect();
    try {
      // As the app runs: a transaction that drops to the restricted role.
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE kaho_app");
      expect((await client.query("SELECT current_user AS u")).rows[0].u).toBe("kaho_app");
      // No org set: a forgotten filter returns nothing, never another team's rows.
      for (const table of ["agents", "contacts", "calls", "call_events", "phone_numbers", "users"]) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, `${table}, no org`).toBe(0);
      }
      await client.query("SELECT set_config('app.org_id', $1, true)", [b.user.org_id]);
      expect((await client.query("SELECT count(*)::int AS n FROM agents")).rows[0].n).toBe(0);
      // Even naming another team's org on a write is refused by the database.
      await expect(client.query(`INSERT INTO tags (id, name, color, org_id) VALUES ('x1', 'sneak', 'plum', $1)`, [a.user.org_id]))
        .rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

describe("roles", () => {
  it("lets the owner make a member an admin, and admins run numbers and bulk deletes", async () => {
    const o = await owner();
    const m = await member(o);
    expect((await m.post("/api/numbers").send({ provider: "plivo", number: "9111111111", credentials: { auth_id: "a", auth_token: "b" } })).status).toBe(403);
    expect((await m.patch(`/api/team/${o.user.id}`).send({ role: "member" })).status).toBe(403);
    const promoted = await o.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    expect(promoted.body).toMatchObject({ id: m.user.id, role: "admin" });
    expect((await m.post("/api/numbers").send({ provider: "plivo", number: "9111111111", credentials: { auth_id: "a", auth_token: "b" } })).status).toBe(200);
    expect((await m.post("/api/contacts/delete").send({ ids: [] })).status).toBe(200);
  });

  it("never lets anyone change the owner, make a second owner, or change their own role", async () => {
    const o = await owner();
    const m = await member(o);
    await o.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    expect((await o.patch(`/api/team/${o.user.id}`).send({ role: "member" })).body.error).toBe("you cannot change your own role");
    expect((await m.patch(`/api/team/${o.user.id}`).send({ role: "member" })).status).toBe(403);
    expect((await o.patch(`/api/team/${m.user.id}`).send({ role: "owner" })).body.error).toBe("role must be admin or member");
  });

  it("removes a member, ending their sessions at once; admins cannot remove admins or the owner", async () => {
    const o = await owner();
    const m = await member(o);
    const m2 = await member(o, { email: "neha@acme.in", name: "Neha", invite: (await o.post("/api/auth/invite")).body.invite_code });
    await o.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    expect((await m.delete(`/api/team/${o.user.id}`)).status).toBe(403);
    expect((await m.delete(`/api/team/${m.user.id}`)).body.error).toBe("you cannot remove yourself");
    expect((await m.delete(`/api/team/${m2.user.id}`)).body).toEqual({ removed: m2.user.id });
    expect((await m2.get("/api/me")).status).toBe(401);
    const team = (await o.get("/api/team")).body;
    expect(team.map((u) => [u.name, u.role])).toEqual([["Asha Rao", "owner"], ["Ravi", "admin"]]);
  });

  it("will not let another team's owner touch your team", async () => {
    const o = await owner();
    const m = await member(o);
    const other = await owner({ name: "Bilal", email: "bilal@beta.in", organization: "Beta" });
    expect((await other.patch(`/api/team/${m.user.id}`).send({ role: "admin" })).status).toBe(404);
    expect((await other.delete(`/api/team/${m.user.id}`)).status).toBe(404);
    expect((await other.get("/api/team")).body.map((u) => u.email)).toEqual(["bilal@beta.in"]);
  });
});
