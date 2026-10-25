import { beforeEach, describe, expect, it } from "vitest";
import { browser, freshDb, owner, member, db } from "./helpers.js";

beforeEach(freshDb);

describe("accounts", () => {
  it("refuses every /api route but the sign-in ones without a session", async () => {
    const b = browser();
    expect((await b.get("/api/auth/state")).body).toEqual({ has_accounts: false });
    for (const path of ["/api/me", "/api/agents", "/api/contacts", "/api/numbers", "/api/dashboard"]) {
      const r = await b.get(path);
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("sign in first");
    }
  });

  it("makes the first account the owner, then signs in and out", async () => {
    const b = await owner();
    const me = await b.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ name: "Asha Rao", email: "asha@acme.in", role: "owner" });
    expect(me.body.invite_code).toBeTruthy();
    expect(JSON.stringify(me.body)).not.toMatch(/hash|salt/);
    expect((await b.post("/api/auth/logout")).body).toEqual({ signed_out: true });
    expect((await b.get("/api/me")).status).toBe(401);
    const again = browser();
    expect((await again.post("/api/auth/login").send({ email: "ASHA@acme.in ", password: "correct horse" })).status).toBe(200);
    expect((await again.get("/api/me")).status).toBe(200);
  });

  it("sets the session as an HttpOnly, SameSite=Strict cookie", async () => {
    const r = await browser().post("/api/auth/signup").send({ name: "A", email: "a@b.in", password: "12345678", organization: "Acme" });
    const cookie = r.headers["set-cookie"].find((c) => c.startsWith("kaho_session="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("stores no password and no session token in the clear", async () => {
    await owner();
    const { rows: [u] } = await db.query("SELECT * FROM users");
    expect(JSON.stringify(u)).not.toContain("correct horse");
    const { rows: s } = await db.query("SELECT token_hash FROM sessions");
    expect(s[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses bad sign ups with a plain reason", async () => {
    const b = browser();
    const cases = [
      [{ name: "", email: "a@b.in", password: "12345678", organization: "O" }, "enter your name (up to 80 characters)"],
      [{ name: "A", email: "nope", password: "12345678", organization: "O" }, "enter a valid email address"],
      [{ name: "A", email: "a@b.in", password: "short", organization: "O" }, "the password must be 8 to 200 characters"],
      [{ name: "A", email: "a@b.in", password: "12345678", organization: "x".repeat(81) }, "enter your organization's name (up to 80 characters)"],
    ];
    for (const [body, error] of cases) {
      const r = await b.post("/api/auth/signup").send(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(error);
    }
  });

  it("joins an organization only with its invite code, which works once", async () => {
    const o = await owner();
    const wrong = await browser().post("/api/auth/signup").send({ name: "X", email: "x@y.in", password: "12345678", invite: "guess" });
    expect(wrong.status).toBe(403);
    const code = (await o.get("/api/me")).body.invite_code;
    const ok = await browser().post("/api/auth/signup").send({ name: "Ravi", email: "ravi@acme.in", password: "12345678", invite: code });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("member");
    const reuse = await browser().post("/api/auth/signup").send({ name: "Y", email: "y@y.in", password: "12345678", invite: code });
    expect(reuse.status).toBe(403);
  });

  it("refuses an expired invite", async () => {
    const o = await owner();
    const code = (await o.get("/api/me")).body.invite_code;
    await db.query("UPDATE invites SET expires_at = now() - interval '1 second'");
    const r = await browser().post("/api/auth/signup").send({ name: "R", email: "r@acme.in", password: "12345678", invite: code });
    expect(r.status).toBe(403);
  });

  it("lets only the owner make a new invite, which replaces the old", async () => {
    const o = await owner();
    const old = (await o.get("/api/me")).body.invite_code;
    const m = await member(o);
    expect((await m.post("/api/auth/invite")).status).toBe(403);
    const fresh = await o.post("/api/auth/invite");
    expect(fresh.body.invite_code).not.toBe(old);
    const r = await browser().post("/api/auth/signup").send({ name: "Y", email: "y@y.in", password: "12345678", invite: old });
    expect(r.status).toBe(403);
  });

  it("signs an email up once", async () => {
    const o = await owner();
    const code = (await o.get("/api/me")).body.invite_code;
    const r = await browser().post("/api/auth/signup").send({ name: "A", email: "asha@acme.in", password: "12345678", invite: code });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("an account with this email already exists; sign in");
  });

  it("refuses a wrong password, and locks an email out after five", async () => {
    await owner();
    const b = browser();
    for (let i = 0; i < 5; i++) {
      const r = await b.post("/api/auth/login").send({ email: "asha@acme.in", password: "wrong" });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("That email and password do not match.");
    }
    const locked = await b.post("/api/auth/login").send({ email: "asha@acme.in", password: "correct horse" });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe("Too many wrong passwords. Try again in a few minutes.");
  });

  it("keeps the lockout in the database, so a restart or another server does not reset it", async () => {
    await owner();
    for (let i = 0; i < 5; i++) await browser().post("/api/auth/login").send({ email: "asha@acme.in", password: "wrong" });
    // Each wrong try from an unknown browser is counted two ways: per email+address
    // (the fast lockout) and per email alone (a slower ceiling against spread-out guessing).
    const { rows } = await db.query("SELECT count(*) FILTER (WHERE key LIKE 'pair:%')::int AS pair, count(*) FILTER (WHERE key LIKE 'email:%')::int AS email FROM login_failures");
    expect(rows[0]).toEqual({ pair: 5, email: 5 });
  });

  it("lets a browser that signed in before through while strangers are locked out", async () => {
    const o = await owner(); // this browser now has a device cookie
    await o.post("/api/auth/logout");
    for (let i = 0; i < 5; i++) await browser().post("/api/auth/login").send({ email: "asha@acme.in", password: "wrong" });
    const r = await o.post("/api/auth/login").send({ email: "asha@acme.in", password: "correct horse" });
    expect(r.status).toBe(200);
  });

  it("changes a password, signs out every other browser and keeps this one", async () => {
    const o = await owner();
    const other = browser();
    await other.post("/api/auth/login").send({ email: "asha@acme.in", password: "correct horse" });
    const wrong = await o.post("/api/auth/password").send({ current: "nope", new: "new password" });
    expect(wrong.status).toBe(401);
    const r = await o.post("/api/auth/password").send({ current: "correct horse", new: "new password" });
    expect(r.status).toBe(200);
    expect((await o.get("/api/me")).status).toBe(200);
    expect((await other.get("/api/me")).status).toBe(401);
    expect((await browser().post("/api/auth/login").send({ email: "asha@acme.in", password: "new password" })).status).toBe(200);
  });

  it("treats junk session tokens as nobody", async () => {
    await owner();
    const b = browser();
    for (const token of ["", "x", "a".repeat(500), "'; DROP TABLE users; --"]) {
      const r = await b.get("/api/me").set("Cookie", `kaho_session=${encodeURIComponent(token)}`);
      expect(r.status).toBe(401);
    }
  });

  it("ends a session when it expires", async () => {
    const o = await owner();
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await o.get("/api/me")).status).toBe(401);
  });

  it("signs in users imported from the Python Studio with their old password", async () => {
    // Made by Python's hashlib.scrypt(b"legacy pass", salt, n=2**14, r=8, p=1, dklen=32), as auth_store.py does.
    await db.query("INSERT INTO organizations (id, name) VALUES ('org_000000000001', 'Old Co')");
    await db.query(`INSERT INTO users (id, name, email, company, role, salt, hash, org_id)
      VALUES ('u_000000000001', 'Old', 'old@acme.in', '', 'owner', $1, $2, 'org_000000000001')`,
    ["00112233445566778899aabbccddeeff", "0c8d1f7485863971ed8729638ffc6022d91976113849e21df0e059d9497949dc"]);
    const r = await browser().post("/api/auth/login").send({ email: "old@acme.in", password: "legacy pass" });
    expect(r.status).toBe(200);
  });
});
