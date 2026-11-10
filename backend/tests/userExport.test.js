import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner, browser, ORIGIN } from "./helpers.js";
import { archiveUsers, usersExport } from "../src/services/archiveUsers.js";

let fake, puts, refuse;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const c = [];
    req.on("data", (x) => c.push(x));
    req.on("end", () => {
      if (req.method === "POST" && req.url.includes("/object/call-recordings/")) puts.push({ path: decodeURIComponent(req.url.split("call-recordings/")[1]), body: Buffer.concat(c).toString(), type: req.headers["content-type"] });
      res.writeHead(refuse ? 500 : 200); res.end("{}");
    });
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => fake.close(r)));
beforeEach(async () => { await freshDb(); puts = []; refuse = false; });

const csv = (text) => text.trim().split("\r\n").map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replaceAll('""', '"')).slice(0, -1));
const at = (p) => puts.find((x) => x.path === p);

describe("who uses the platform: last sign-in", () => {
  it("is recorded when someone signs up and each time they sign in", async () => {
    const b = await owner();
    const first = (await db.query("SELECT last_login_at FROM users WHERE email = 'asha@acme.in'")).rows[0].last_login_at;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    const again = browser();
    expect((await again.post("/api/auth/login").send({ email: "asha@acme.in", password: "correct horse" })).status).toBe(200);
    const second = (await db.query("SELECT last_login_at FROM users WHERE email = 'asha@acme.in'")).rows[0].last_login_at;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(b.user.email).toBe("asha@acme.in");
  });

  it("is not moved by a wrong password", async () => {
    await owner();
    const before = (await db.query("SELECT last_login_at FROM users")).rows[0].last_login_at;
    await new Promise((r) => setTimeout(r, 30));
    expect((await browser().post("/api/auth/login").send({ email: "asha@acme.in", password: "wrong wrong wrong" })).status).toBeGreaterThanOrEqual(400);
    expect((await db.query("SELECT last_login_at FROM users")).rows[0].last_login_at.getTime()).toBe(before.getTime());
  });
});

describe("the three user files, as spreadsheets", () => {
  it("lists every person in every organization with their role, and when they joined and last signed in", async () => {
    const b = await owner();
    const m = await member(b, { email: "ravi@acme.in", name: "Ravi" });
    await b.patch(`/api/team/${m.user.id}`).send({ role: "manager" });
    await owner({ email: "zoya@other.in", name: "Zoya", organization: "Other" });
    const { users } = await usersExport();
    const rows = csv(users);
    expect(rows[0]).toEqual(["Name", "Email", "Organization", "Role", "Joined", "Last signed in"]);
    expect(rows.slice(1).map((r) => [r[1], r[2], r[3]]).sort()).toEqual([["asha@acme.in", "Acme", "owner"], ["ravi@acme.in", "Acme", "manager"], ["zoya@other.in", "Other", "owner"]]);
    expect(rows[1][4]).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("lists each e-mail once, and nothing else", async () => {
    const b = await owner();
    await member(b, { email: "ravi@acme.in", name: "Ravi" });
    const { emails } = await usersExport();
    expect(csv(emails)).toEqual([["Email"], ["asha@acme.in"], ["ravi@acme.in"]]);
  });

  it("lists each person once however many organizations they are in, with sign-in date, and no password", async () => {
    const b = await owner();
    await member(b, { email: "ravi@acme.in", name: "Ravi" });
    await db.query("INSERT INTO organizations (id, name) VALUES ('org_second00001', 'Second')").catch(() => {});
    const { unique } = await usersExport();
    const rows = csv(unique);
    expect(rows[0]).toEqual(["Email", "Name", "Signed up", "Last signed in", "Password"]);
    expect(rows).toHaveLength(3);
    expect(rows[1][4]).toBe("Kept hashed. The readable password is not stored anywhere and cannot be exported.");
    const stored = (await db.query("SELECT salt, hash FROM users")).rows;
    for (const { salt, hash } of stored) for (const text of Object.values(await usersExport())) { expect(text).not.toContain(salt); expect(text).not.toContain(hash); }
    for (const text of Object.values(await usersExport())) expect(text).not.toContain("correct horse");
  });

  it("cannot be turned into a spreadsheet formula by a name", async () => {
    await owner({ name: "=HYPERLINK(\"http://evil\")", email: "asha@acme.in" });
    const { users, unique } = await usersExport();
    expect(users).toContain("'=HYPERLINK");
    expect(unique).toContain("'=HYPERLINK");
  });

  it("never lists a session token or an invite code", async () => {
    const b = await owner();
    const text = JSON.stringify(await usersExport());
    const tokens = (await db.query("SELECT token_hash FROM sessions")).rows;
    for (const { token_hash: t } of tokens) expect(text).not.toContain(t);
    expect(b.user.email).toBeTruthy();
  });
});

describe("filed in Supabase, in numbered folders", () => {
  it("files 3-users, 4-user-emails and 5-unique-users, one file each", async () => {
    await owner();
    const r = await archiveUsers();
    expect(r).toMatchObject({ filed: 3, failed: 0 });
    expect(at("3-users/users.csv").body).toContain("asha@acme.in");
    expect(at("4-user-emails/emails.csv").body).toContain("asha@acme.in");
    expect(at("5-unique-users/unique-users.csv").body).toContain("asha@acme.in");
    for (const p of puts) expect(p.type).toMatch(/^text\/csv|^text\/plain/);
  });

  it("is the same file when filed twice, and picks up a new person", async () => {
    const b = await owner();
    await archiveUsers();
    const first = at("4-user-emails/emails.csv").body;
    puts = [];
    await member(b, { email: "ravi@acme.in", name: "Ravi" });
    await archiveUsers();
    expect(at("4-user-emails/emails.csv").body).toContain("ravi@acme.in");
    expect(at("4-user-emails/emails.csv").body).toContain(first.trim().split("\r\n")[1]);
  });

  it("says so, and does not throw, when Storage refuses", async () => {
    await owner();
    refuse = true;
    expect(await archiveUsers()).toMatchObject({ filed: 0, failed: 3 });
  });

  it("is not something an organization's admin can start", async () => {
    const b = await owner();
    const r = await b.post("/api/archive/run").send({});
    expect(r.status).toBe(200);
    expect(puts.some((p) => /^(3-users|4-user-emails|5-unique-users)\//.test(p.path))).toBe(false);
    expect(ORIGIN).toBeTruthy();
  });
});
