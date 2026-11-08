import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, member, owner } from "./helpers.js";
import { PERMISSIONS, ROLES, can, permissionsOf } from "../src/models/permissions.js";

beforeEach(freshDb);

describe("who can do what", () => {
  it("has the owner, an admin and four roles for the people who use the platform", () => {
    expect(ROLES.map((r) => r.id)).toEqual(["owner", "admin", "manager", "builder", "operator", "viewer"]);
    for (const r of ROLES) {
      expect(r.label.length).toBeGreaterThan(2);
      expect(r.summary.length).toBeGreaterThan(30);
    }
  });

  it("gives the owner and the admin everything an admin does", () => {
    for (const p of PERMISSIONS) expect(can("owner", p.id), p.id).toBe(true);
    for (const p of PERMISSIONS) expect(can("admin", p.id), p.id).toBe(true);
  });

  it("lets a viewer look and nothing else", () => {
    expect(permissionsOf("viewer")).toEqual(["view"]);
  });

  it("lets a caller call, listen and keep contacts, but not change agents", () => {
    for (const p of ["view", "calls.place", "recordings.listen", "contacts.edit"]) expect(can("operator", p), p).toBe(true);
    for (const p of ["agents.edit", "calls.bulk", "numbers.manage", "team.manage", "keys.manage", "contacts.delete"]) {
      expect(can("operator", p), p).toBe(false);
    }
  });

  it("lets a builder build agents and tools, but not call anyone or hear recordings", () => {
    for (const p of ["view", "agents.edit", "tools.custom"]) expect(can("builder", p), p).toBe(true);
    for (const p of ["calls.place", "calls.bulk", "recordings.listen", "numbers.manage", "agents.delete"]) {
      expect(can("builder", p), p).toBe(false);
    }
  });

  it("lets a manager run the daily work but not the organization", () => {
    for (const p of ["view", "agents.edit", "calls.place", "calls.bulk", "recordings.listen", "contacts.edit", "contacts.delete"]) {
      expect(can("manager", p), p).toBe(true);
    }
    for (const p of ["numbers.manage", "team.manage", "team.roles", "keys.manage", "org.settings", "agents.delete", "tools.custom"]) {
      expect(can("manager", p), p).toBe(false);
    }
  });

  it("gives nothing to a role it does not know, or to nobody", () => {
    expect(permissionsOf("superuser")).toEqual([]);
    expect(can(undefined, "view")).toBe(false);
    expect(can("viewer", "no.such.thing")).toBe(false);
  });
});

const asRole = async (b, role) => {
  const m = await member(b);
  const r = await b.patch(`/api/team/${m.user.id}`).send({ role });
  if (r.status !== 200) throw new Error(`could not make a ${role}: ${r.status} ${JSON.stringify(r.body)}`);
  return m;
};

describe("the roles are enforced, not just described", () => {
  it("someone who joins with an invite can only look until they are given a role", async () => {
    const b = await owner();
    const m = await member(b);
    expect(m.user.role).toBe("viewer");
    expect((await m.post("/api/agents").send({ name: "X", prompt: "Hi" })).status).toBe(403);
    expect((await m.get("/api/agents")).status).toBe(200);
  });

  it("the owner can give someone any of the four roles, and the change takes effect at once", async () => {
    const b = await owner();
    const m = await member(b);
    for (const role of ["manager", "builder", "operator", "viewer"]) {
      expect((await b.patch(`/api/team/${m.user.id}`).send({ role })).status, role).toBe(200);
    }
    expect((await b.patch(`/api/team/${m.user.id}`).send({ role: "owner" })).status).toBe(400);
    expect((await b.patch(`/api/team/${m.user.id}`).send({ role: "wizard" })).status).toBe(400);
  });

  it("an admin can set the four lower roles but not make another admin", async () => {
    const b = await owner();
    const a = await asRole(b, "admin");
    const other = await member(b, { email: "c@acme.in" });
    expect((await a.patch(`/api/team/${other.user.id}`).send({ role: "operator" })).status).toBe(200);
    expect((await a.patch(`/api/team/${other.user.id}`).send({ role: "admin" })).status).toBe(403);
  });

  it("a builder can make and publish an agent but cannot place a call or play a recording", async () => {
    const b = await owner();
    const m = await asRole(b, "builder");
    const made = await m.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    expect(made.status).toBe(200);
    expect((await m.post("/api/calls").send({ to: "9876543210", consent: true })).status).toBe(403);
    expect((await m.get("/api/calls/99999999-9999-9999-9999-999999999999/recording")).status).toBe(403);
  });

  it("a caller can reach the calling and contact routes but not the agents", async () => {
    const b = await owner();
    const m = await asRole(b, "operator");
    const made = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    expect((await m.patch(`/api/agents/${made.id}`).send({ description: "x" })).status).toBe(403);
    expect((await m.post("/api/agents").send({ name: "Y", prompt: "Hi" })).status).toBe(403);
    expect((await m.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] })).status).toBe(200);
    const call = await m.post("/api/calls").send({ to: "9876543210", consent: true });
    expect(call.status).not.toBe(403);        // it is refused for another reason: no number is set up
    expect((await m.post("/api/bulk-calls").send({})).status).toBe(403);
  });

  it("a manager can run bulk calls and delete contacts but not touch numbers, keys or people", async () => {
    const b = await owner();
    const m = await asRole(b, "manager");
    expect((await m.post("/api/bulk-calls").send({})).status).not.toBe(403);
    expect((await m.post("/api/contacts/delete").send({ ids: [] })).status).not.toBe(403);
    expect((await m.post("/api/numbers").send({})).status).toBe(403);
    expect((await m.post("/api/api-keys").send({ name: "x" })).status).toBe(403);
    expect((await m.post("/api/auth/invite").send({})).status).toBe(403);
  });

  it("a viewer cannot change a single thing", async () => {
    const b = await owner();
    const m = await asRole(b, "viewer");
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const tries = [
      m.post("/api/agents").send({ name: "Y", prompt: "Hi" }),
      m.patch(`/api/agents/${a.id}`).send({ description: "x" }),
      m.post(`/api/agents/${a.id}/publish`).send({}),
      m.post("/api/contacts").send({ name: "R", numbers: ["+919876543210"] }),
      m.post("/api/tasks").send({ title: "x" }),
      m.post("/api/tags").send({ name: "x" }),
      m.post("/api/calls").send({ to: "9876543210", consent: true }),
      m.post("/api/custom-tools").send({}),
    ];
    for (const r of await Promise.all(tries)) expect(r.status).toBe(403);
    expect((await m.get("/api/dashboard")).status).toBe(200);
    expect((await m.get("/api/calls")).status).toBe(200);
  });

  it("only an admin can run the whole organization's call settings", async () => {
    const b = await owner();
    const m = await asRole(b, "manager");
    expect((await m.patch("/api/org/settings").send({ max_minutes: 5 })).status).toBe(403);
    expect((await b.patch("/api/org/settings").send({ max_minutes: 5 })).status).toBe(200);
  });
});

describe("the page can ask what each role may do", () => {
  it("serves the same table the server enforces", async () => {
    const b = await owner();
    const r = await b.get("/api/roles");
    expect(r.status).toBe(200);
    expect(r.body.roles.map((x) => x.id)).toEqual(ROLES.map((x) => x.id));
    expect(r.body.permissions.map((x) => x.id)).toEqual(PERMISSIONS.map((x) => x.id));
    expect(r.body.roles.find((x) => x.id === "viewer").permissions).toEqual(["view"]);
  });

  it("tells a signed-in person what they themselves may do", async () => {
    const b = await owner();
    const m = await asRole(b, "operator");
    const me = (await m.get("/api/me")).body;
    expect(me.permissions).toEqual(permissionsOf("operator"));
  });
});
