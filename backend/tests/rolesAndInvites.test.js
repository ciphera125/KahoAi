// One role in charge, and invite codes that carry the role they give (owner, 2026-11-15: "keep admin only", and
// "whatever code we give them, that code gives them that particular role only").
//
// The owner role did one real job: someone in an organization could never be removed or demoted by another person,
// so it could never be left without anyone in charge. That job is kept as a rule (an organization always has an
// admin), without a second kind of admin.
import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner, browser } from "./helpers.js";
import { ASSIGNABLE, can, PERMISSIONS, ROLES } from "../src/models/permissions.js";

beforeEach(freshDb);

const INVITABLE = ["manager", "builder", "operator", "viewer"];

async function joinWith(code, email, extra = {}) {
  const b = browser();
  const r = await b.post("/api/auth/signup").send({ name: "New Person", email, password: "another pass", invite: code, ...extra });
  return { b, r };
}

describe("there is one role in charge", () => {
  it("is called admin, and the owner role is gone", () => {
    expect(ROLES.map((r) => r.id)).toEqual(["admin", "manager", "builder", "operator", "viewer"]);
    expect(ASSIGNABLE).toEqual(["admin", "manager", "builder", "operator", "viewer"]);
    for (const p of PERMISSIONS) expect(can("admin", p.id), p.id).toBe(true);
    expect(can("owner", "view")).toBe(false);
  });

  it("whoever creates an organization is its admin, in sign-up and when making another organization", async () => {
    const b = await owner();
    expect(b.user.role).toBe("admin");
    expect((await b.get("/api/me")).body.role).toBe("admin");
    const made = await b.post("/api/orgs").send({ name: "Second" });
    expect(made.body.role).toBe("admin");
    expect((await b.get("/api/orgs")).body.map((o) => o.role)).toEqual(["admin", "admin"]);
  });

  it("the database refuses the old role", async () => {
    const b = await owner();
    await expect(db.query("UPDATE memberships SET role = 'owner' WHERE user_id = $1", [b.user.id])).rejects.toThrow(/memberships_role_check|violates check/);
  });

  it("an admin can make anyone an admin, and take it back from another admin", async () => {
    const a = await owner();
    const m = await member(a);
    expect((await a.patch(`/api/team/${m.user.id}`).send({ role: "admin" })).body.role).toBe("admin");
    expect((await m.get("/api/me")).body.role).toBe("admin");
    expect((await m.patch(`/api/team/${a.user.id}`).send({ role: "viewer" })).body.role).toBe("viewer"); // the other admin may demote the first
    expect((await a.get("/api/me")).body.role).toBe("viewer");
  });

  it("an admin cannot change their own role or remove themselves, so someone is always left in charge", async () => {
    const a = await owner();
    const r = await a.patch(`/api/team/${a.user.id}`).send({ role: "viewer" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/your own role/);
    expect((await a.delete(`/api/team/${a.user.id}`)).status).toBe(400);
    expect((await a.get("/api/me")).body.role).toBe("admin");
  });

  it("two admins cannot leave the organization without one: each is protected from being the last to go", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    expect((await a.patch(`/api/team/${m.user.id}`).send({ role: "viewer" })).status).toBe(200); // a stays admin
    // m is now a viewer and can do nothing about a
    expect((await m.patch(`/api/team/${a.user.id}`).send({ role: "viewer" })).status).toBe(403);
    expect((await m.delete(`/api/team/${a.user.id}`)).status).toBe(403);
    const count = (await db.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'admin'", [a.user.org_id])).rows[0].n;
    expect(count).toBe(1);
  });

  it("two admins demoting each other at the same moment cannot leave nobody in charge", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    for (let round = 0; round < 6; round++) {
      await db.query("UPDATE memberships SET role = 'admin' WHERE org_id = $1 AND user_id IN ($2, $3)", [a.user.org_id, a.user.id, m.user.id]);
      const results = await Promise.all([
        a.patch(`/api/team/${m.user.id}`).send({ role: "viewer" }),
        m.patch(`/api/team/${a.user.id}`).send({ role: "viewer" }),
      ]);
      const n = (await db.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'admin'", [a.user.org_id])).rows[0].n;
      expect(n, `round ${round}: ${results.map((r) => r.status)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("an admin removing another admin while that admin demotes them also leaves one", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    await Promise.all([a.delete(`/api/team/${m.user.id}`), m.delete(`/api/team/${a.user.id}`)]);
    const n = (await db.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'admin'", [a.user.org_id])).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("an admin can remove another admin", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "admin" });
    expect((await a.delete(`/api/team/${m.user.id}`)).status).toBe(200);
  });

  it("only an admin changes roles; nobody else, whatever they are told", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "manager" });
    const v = await member(a, { email: "second@acme.in" });
    expect((await m.patch(`/api/team/${v.user.id}`).send({ role: "admin" })).status).toBe(403);
    expect((await v.patch(`/api/team/${v.user.id}`).send({ role: "admin" })).status).toBe(403);
    expect((await a.patch(`/api/team/${v.user.id}`).send({ role: "emperor" })).status).toBe(400);
    expect((await a.patch(`/api/team/${v.user.id}`).send({ role: ["admin"] })).status).toBe(400);
  });

  it("the team is listed with admins first", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "operator" });
    const v = await member(a, { email: "second@acme.in", name: "Zed" });
    await a.patch(`/api/team/${v.user.id}`).send({ role: "admin" });
    expect((await a.get("/api/team")).body.map((u) => u.role)).toEqual(["admin", "admin", "operator"]);
  });
});

describe("an invite code gives the role it was made for, and only that", () => {
  it.each(INVITABLE)("a %s code makes a %s", async (role) => {
    const a = await owner();
    const made = await a.post("/api/invites").send({ role });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ role });
    expect(made.body.code).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(made.body.expires).toBeGreaterThan(Date.now() / 1000 + 6 * 86400);
    const { b, r } = await joinWith(made.body.code, `${role}@acme.in`);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe(role);
    expect((await b.get("/api/me")).body.role).toBe(role);
    expect((await b.get("/api/me")).body.permissions).toEqual(ROLES.find((x) => x.id === role).permissions);
  });

  it("an admin cannot be invited directly: invite them, then make them an admin from the list", async () => {
    const a = await owner();
    const r = await a.post("/api/invites").send({ role: "admin" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/one of: manager, builder, operator, viewer/);
  });

  it("takes only a role it knows", async () => {
    const a = await owner();
    for (const bad of [undefined, "", "owner", "root", "Manager", ["manager"], { role: "manager" }, null, 5]) {
      const r = await a.post("/api/invites").send(bad === undefined ? {} : { role: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("works once, and the person cannot choose a better role by asking for one", async () => {
    const a = await owner();
    const { body: made } = await a.post("/api/invites").send({ role: "viewer" });
    const first = await joinWith(made.code, "one@acme.in", { role: "admin", role_id: "admin", invite_role: "admin" });
    expect(first.r.status).toBe(200);
    expect(first.r.body.role).toBe("viewer");
    const again = await joinWith(made.code, "two@acme.in");
    expect(again.r.status).toBe(403);
  });

  it("an existing account joins with the role of the code too", async () => {
    const a = await owner();
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const { body: made } = await a.post("/api/invites").send({ role: "builder" });
    expect((await other.post("/api/orgs/join").send({ invite: made.code })).status).toBe(200);
    const orgs = (await other.get("/api/orgs")).body;
    expect(orgs.find((o) => o.id === a.user.org_id).role).toBe("builder");
  });

  it("there can be several codes at once, even for the same role, and each is listed with its role", async () => {
    const a = await owner();
    await a.post("/api/invites").send({ role: "manager" });
    await a.post("/api/invites").send({ role: "manager" });
    await a.post("/api/invites").send({ role: "viewer" });
    const list = (await a.get("/api/invites")).body;
    expect(list.map((i) => i.role).sort()).toEqual(["manager", "manager", "viewer"]);
    expect(list[0]).toMatchObject({ code: expect.any(String), expires: expect.any(Number), made_by: "Asha Rao" });
  });

  it("an admin can cancel a code before it is used, and only their own organization's", async () => {
    const a = await owner();
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const { body: made } = await a.post("/api/invites").send({ role: "operator" });
    expect((await other.delete(`/api/invites/${made.code}`)).status).toBe(404);
    expect((await a.delete(`/api/invites/${made.code}`)).status).toBe(200);
    expect((await joinWith(made.code, "late@acme.in")).r.status).toBe(403);
    expect((await a.delete(`/api/invites/${made.code}`)).status).toBe(404);
    expect((await a.get("/api/invites")).body).toEqual([]);
  });

  it("only an admin can make, see or cancel codes", async () => {
    const a = await owner();
    const m = await member(a);
    await a.patch(`/api/team/${m.user.id}`).send({ role: "manager" });
    expect((await m.post("/api/invites").send({ role: "viewer" })).status).toBe(403);
    expect((await m.get("/api/invites")).status).toBe(403);
    const { body: made } = await a.post("/api/invites").send({ role: "viewer" });
    expect((await m.delete(`/api/invites/${made.code}`)).status).toBe(403);
  });

  it("a code that has run out is not listed and does not work", async () => {
    const a = await owner();
    const { body: made } = await a.post("/api/invites").send({ role: "viewer" });
    await db.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE code = $1", [made.code]);
    expect((await a.get("/api/invites")).body).toEqual([]);
    expect((await joinWith(made.code, "late@acme.in")).r.status).toBe(403);
  });

  it("at most 25 are open at once, so nobody can fill the table", async () => {
    const a = await owner();
    for (let i = 0; i < 25; i++) expect((await a.post("/api/invites").send({ role: "viewer" })).status).toBe(200);
    const r = await a.post("/api/invites").send({ role: "viewer" });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/25/);
  });

  it("making a code is recorded for the team, without the code in the text", async () => {
    const a = await owner();
    const { body: made } = await a.post("/api/invites").send({ role: "builder" });
    const notes = (await a.get("/api/notifications")).body.items.map((i) => i.text);
    expect(notes.some((t) => /invite code/i.test(t) && /agent builder/i.test(t))).toBe(true);
    expect(JSON.stringify(notes)).not.toContain(made.code);
    const audit = (await a.get("/api/audit?page=1&per_page=50")).body.entries.map((e) => e.detail);
    expect(JSON.stringify(audit)).not.toContain(made.code);
  });

  it("the old single code is gone: /api/me carries none and /api/auth/invite does not exist", async () => {
    const a = await owner();
    expect((await a.get("/api/me")).body).not.toHaveProperty("invite_code");
    expect((await a.post("/api/auth/invite").send({})).status).toBe(404);
  });
});
