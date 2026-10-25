// More than one organization per account: separate environments, each with its
// own agents, contacts, numbers and team, and a role in each.
import { beforeEach, describe, expect, it } from "vitest";
import { browser, freshDb, member, owner } from "./helpers.js";

beforeEach(freshDb);

const names = async (b) => (await b.get("/api/contacts")).body.contacts.map((c) => c.name);

describe("organizations", () => {
  it("anyone can create another one; they own it and are switched into it, and its data is separate", async () => {
    const b = await owner();
    await b.post("/api/contacts").send({ name: "Asha in Acme", numbers: ["9876543210"] });
    const r = await b.post("/api/orgs").send({ name: "Acme staging" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "Acme staging", role: "owner" });
    const me = (await b.get("/api/me")).body;
    expect(me).toMatchObject({ org_name: "Acme staging", role: "owner" });
    expect(await names(b)).toEqual([]);
    const list = (await b.get("/api/orgs")).body;
    expect(list.map((o) => [o.name, o.role, o.current])).toEqual([["Acme", "owner", false], ["Acme staging", "owner", true]]);
  });

  it("switching back shows that organization's data again, and sign-in lands on the last one used", async () => {
    const b = await owner();
    await b.post("/api/contacts").send({ name: "Asha in Acme", numbers: ["9876543210"] });
    const acme = (await b.get("/api/me")).body.org_id;
    await b.post("/api/orgs").send({ name: "Acme staging" });
    expect((await b.post(`/api/orgs/${acme}/switch`)).status).toBe(200);
    expect(await names(b)).toEqual(["Asha in Acme"]);
    const staging = (await b.get("/api/orgs")).body.find((o) => o.name === "Acme staging").id;
    await b.post(`/api/orgs/${staging}/switch`);
    const again = browser();
    await again.post("/api/auth/login").send({ email: "asha@acme.in", password: "correct horse" });
    expect((await again.get("/api/me")).body.org_name).toBe("Acme staging");
  });

  it("you cannot switch into an organization you are not in", async () => {
    const a = await owner();
    const other = await owner({ email: "x@other.in", organization: "Other" });
    const otherId = (await other.get("/api/me")).body.org_id;
    expect((await a.post(`/api/orgs/${otherId}/switch`)).status).toBe(404);
    expect((await a.post("/api/orgs/org_zzzzzzzzzzzz/switch")).status).toBe(404);
    expect((await a.get("/api/me")).body.org_name).toBe("Acme");
  });

  it("a signed-in person joins another organization with its invite code, as a member there", async () => {
    const acme = await owner();
    const other = await owner({ name: "Ravi", email: "ravi@other.in", organization: "Other" });
    const code = (await acme.get("/api/me")).body.invite_code;
    const r = await other.post("/api/orgs/join").send({ invite: code });
    expect(r.status).toBe(200);
    expect((await other.get("/api/me")).body).toMatchObject({ org_name: "Acme", role: "member" });
    // A member there: admin-only things are refused, in that organization only.
    expect((await other.post("/api/numbers").send({ provider: "plivo", number: "+918065520552", credentials: {} })).status).toBe(403);
    expect((await acme.get("/api/team")).body.map((u) => [u.name, u.role])).toEqual([["Asha Rao", "owner"], ["Ravi", "member"]]);
    // Still the owner of their own.
    const own = (await other.get("/api/orgs")).body.find((o) => o.name === "Other");
    await other.post(`/api/orgs/${own.id}/switch`);
    expect((await other.get("/api/me")).body.role).toBe("owner");
    expect((await other.post("/api/orgs/join").send({ invite: code })).status).toBe(403); // used once
  });

  it("removing someone from one organization leaves their account and their other organizations", async () => {
    const acme = await owner();
    const other = await owner({ name: "Ravi", email: "ravi@other.in", organization: "Other" });
    await other.post("/api/orgs/join").send({ invite: (await acme.get("/api/me")).body.invite_code });
    const ravi = (await acme.get("/api/team")).body.find((u) => u.name === "Ravi");
    expect((await acme.delete(`/api/team/${ravi.id}`)).status).toBe(200);
    expect((await acme.get("/api/team")).body.map((u) => u.name)).toEqual(["Asha Rao"]);
    const back = browser();
    await back.post("/api/auth/login").send({ email: "ravi@other.in", password: "correct horse" });
    expect((await back.get("/api/me")).body).toMatchObject({ org_name: "Other", role: "owner" });
  });

  it("a member made in an organization by invite still works as before", async () => {
    const acme = await owner();
    const m = await member(acme);
    expect((await m.get("/api/me")).body).toMatchObject({ org_name: "Acme", role: "member" });
    expect((await m.get("/api/orgs")).body.map((o) => o.name)).toEqual(["Acme"]);
  });

  it("names are checked and the number of organizations is capped", async () => {
    const b = await owner();
    expect((await b.post("/api/orgs").send({ name: "" })).status).toBe(400);
    expect((await b.post("/api/orgs").send({ name: "x".repeat(81) })).status).toBe(400);
    for (let i = 0; i < 19; i++) expect((await b.post("/api/orgs").send({ name: `Env ${i}` })).status).toBe(200);
    const r = await b.post("/api/orgs").send({ name: "One too many" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/20/);
  });
});
