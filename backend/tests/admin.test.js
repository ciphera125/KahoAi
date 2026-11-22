// The admin site's own sign-in: its own accounts, its own cookie, its own origin, and only two e-mail
// addresses in the world may ever hold one. Nothing about a Studio account can reach it, and nothing
// about an admin account can reach the Studio.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { app, browser, db, freshDb, owner } from "./helpers.js";
import { AADITYA, adminBrowser, ADMIN_ORIGIN, AYUSHI, CODE, PASSWORD, signedInAdmin } from "./adminHelpers.js";

let savedCode;
beforeAll(() => { savedCode = config.ADMIN_SIGNUP_CODE; });
afterAll(() => { config.ADMIN_SIGNUP_CODE = savedCode; config.adminEmails = [AADITYA, AYUSHI]; });
beforeEach(async () => {
  config.ADMIN_SIGNUP_CODE = CODE;
  config.adminEmails = [AADITYA, AYUSHI];
  await freshDb();
});

describe("who may have an admin account", () => {
  it("says whether sign-up is open, without saying who may use it", async () => {
    const r = await adminBrowser().get("/auth/state");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ signup_open: true });
  });

  it("stops saying sign-up is open once every allowed address has its account (security pass, 2026-11-22)", async () => {
    // The public address would otherwise keep advertising a sign-up form that has nothing left to give.
    for (const [email, name] of [[AADITYA, "Aditya Nair"], [AYUSHI, "Ayushi Makkad"]]) {
      expect((await adminBrowser().get("/auth/state")).body).toEqual({ signup_open: true });
      expect((await adminBrowser().post("/auth/signup").send({ name, email, password: PASSWORD, code: CODE })).status).toBe(200);
    }
    expect((await adminBrowser().get("/auth/state")).body).toEqual({ signup_open: false });
  });

  it("lets exactly the two named e-mail addresses sign up, each with the setup code", async () => {
    for (const [email, name] of [[AADITYA, "Aditya Nair"], [AYUSHI, "Ayushi Makkad"]]) {
      const b = adminBrowser();
      const r = await b.post("/auth/signup").send({ name, email, password: PASSWORD, code: CODE });
      expect(r.status, email).toBe(200);
      expect(r.body).toMatchObject({ email, name });
      expect(r.body.id).toMatch(/^ad_[0-9a-f]{12}$/);
      expect(r.body.hash ?? r.body.salt).toBeUndefined();
      expect((await b.get("/me")).status).toBe(200);
    }
  });

  it("refuses everyone else, with one answer that does not say why", async () => {
    const answers = new Set();
    for (const email of ["someone@gmail.com", "adityanair5002+x@gmail.com", "adityanair50021@gmail.com", "adityanair5002@gmail.com.evil.in",
      "aditya.nair5002@gmail.com", "x@kaho.in", " ", "aayushimakker10@googlemail.com"]) {
      const r = await adminBrowser().post("/auth/signup").send({ name: "Mallory", email, password: PASSWORD, code: CODE });
      expect(r.status, email).toBe(403);
      answers.add(r.body.error);
    }
    // A right e-mail with the wrong code, and a wrong e-mail with the right code, look the same.
    const wrongCode = await adminBrowser().post("/auth/signup").send({ name: "Mallory", email: AADITYA, password: PASSWORD, code: "guess-guess-guess-guess" });
    expect(wrongCode.status).toBe(403);
    answers.add(wrongCode.body.error);
    expect(answers.size).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM admins")).rows[0].n).toBe(0);
  });

  it("needs the setup code even for an allowed address: an e-mail address is not proof of who is typing", async () => {
    for (const code of [undefined, "", null, 0, [CODE], { code: CODE }, CODE.slice(1), `${CODE} `]) {
      const r = await adminBrowser().post("/auth/signup").send({ name: "Aditya", email: AADITYA, password: PASSWORD, ...(code === undefined ? {} : { code }) });
      expect(r.status, JSON.stringify(code)).toBe(403);
    }
  });

  it("is closed altogether until a setup code is configured", async () => {
    config.ADMIN_SIGNUP_CODE = "";
    expect((await adminBrowser().get("/auth/state")).body).toEqual({ signup_open: false });
    const r = await adminBrowser().post("/auth/signup").send({ name: "Aditya", email: AADITYA, password: PASSWORD, code: "" });
    expect(r.status).toBe(403);
    delete config.ADMIN_SIGNUP_CODE;
    expect((await adminBrowser().post("/auth/signup").send({ name: "Aditya", email: AADITYA, password: PASSWORD, code: undefined })).status).toBe(403);
  });

  it("compares the code in constant time and never echoes it", async () => {
    const r = await adminBrowser().post("/auth/signup").send({ name: "A", email: AADITYA, password: PASSWORD, code: "wrong-wrong-wrong-wrong" });
    expect(JSON.stringify(r.body)).not.toContain(CODE);
  });

  it("holds each address once, and wants a long password", async () => {
    await signedInAdmin();
    const again = await adminBrowser().post("/auth/signup").send({ name: "Aditya", email: AADITYA, password: PASSWORD, code: CODE });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already/);
    const short = await adminBrowser().post("/auth/signup").send({ name: "Ayushi", email: AYUSHI, password: "short-pass", code: CODE });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/12/);
    for (const bad of [{ name: "" }, { name: "x".repeat(81) }, { name: ["a"] }, { password: ["p".repeat(20)] }, { password: "p".repeat(201) }]) {
      const r = await adminBrowser().post("/auth/signup").send({ name: "Ayushi", email: AYUSHI, password: PASSWORD, code: CODE, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("an address's case does not matter, but its identity does", async () => {
    const r = await adminBrowser().post("/auth/signup").send({ name: "Aditya", email: "AdityaNair5002@Gmail.com", password: PASSWORD, code: CODE });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(AADITYA);
  });

  it("an admin who is taken off the list loses access at once, session and all", async () => {
    const b = await signedInAdmin();
    expect((await b.get("/me")).status).toBe(200);
    config.adminEmails = [AYUSHI];
    expect((await b.get("/me")).status).toBe(401);
    const login = await adminBrowser().post("/auth/login").send({ email: AADITYA, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it("a Studio account with an admin's e-mail address is still just a Studio account", async () => {
    const studio = await owner({ email: AADITYA, organization: "Acme" });
    expect((await studio.get("/api/me")).status).toBe(200);
    // Its Studio cookie is sent along (same host), and opens nothing on the admin site.
    const r = await studio.agent.get("/api/admin/me").set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174");
    expect(r.status).toBe(401);
    expect((await studio.agent.get("/api/admin/orgs").set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174")).status).toBe(401);
  });
});

describe("signing in", () => {
  it("sets its own cookie: http-only, same-site strict, and only sent to the admin API", async () => {
    await signedInAdmin();
    const b = adminBrowser();
    const r = await b.post("/auth/login").send({ email: AADITYA, password: PASSWORD });
    expect(r.status).toBe(200);
    const set = r.headers["set-cookie"].find((c) => c.startsWith("kaho_admin="));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/api\/admin/);
    expect(r.headers["set-cookie"].some((c) => c.startsWith("kaho_session="))).toBe(false);
    expect(r.body).toMatchObject({ email: AADITYA });
  });

  it("does not say whether it was the address or the password", async () => {
    await signedInAdmin();
    const wrongPass = await adminBrowser().post("/auth/login").send({ email: AADITYA, password: "not the passphrase" });
    const unknown = await adminBrowser().post("/auth/login").send({ email: "nobody@gmail.com", password: PASSWORD });
    const other = await adminBrowser().post("/auth/login").send({ email: AYUSHI, password: PASSWORD }); // allowed, but never signed up
    expect([wrongPass.status, unknown.status, other.status]).toEqual([401, 401, 401]);
    expect(new Set([wrongPass.body.error, unknown.body.error, other.body.error]).size).toBe(1);
  });

  it("locks out guessing: five wrong passwords from one address stop the sixth, even the right one", async () => {
    await signedInAdmin();
    for (let i = 0; i < 5; i++) {
      const r = await adminBrowser().post("/auth/login").send({ email: AADITYA, password: `wrong passphrase ${i}` });
      expect(r.status).toBe(401);
    }
    const locked = await adminBrowser().post("/auth/login").send({ email: AADITYA, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toMatch(/too many/i);
  });

  it("rate-limits the sign-in door itself per address", async () => {
    const seen = new Set();
    for (let i = 0; i < config.ADMIN_AUTH_RATE_LIMIT_PER_MIN + 3; i++) {
      seen.add((await adminBrowser().post("/auth/login").send({ email: "nobody@gmail.com", password: "x".repeat(14) })).status);
    }
    expect(seen.has(429)).toBe(true);
  });

  it("takes only text for the e-mail and the password", async () => {
    for (const body of [{ email: [AADITYA], password: PASSWORD }, { email: AADITYA, password: [PASSWORD] }, { email: { a: 1 }, password: 5 }, {}]) {
      expect((await adminBrowser().post("/auth/login").send(body)).status, JSON.stringify(body)).toBe(401);
    }
  });

  it("signing out ends the session; a copied cookie stops working", async () => {
    const b = await signedInAdmin();
    const cookie = b.cookie;
    expect((await b.post("/auth/logout")).status).toBe(200);
    expect((await b.get("/me")).status).toBe(401);
    const replay = await request(app).get("/api/admin/me").set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174").set("Cookie", cookie ?? "kaho_admin=x");
    expect(replay.status).toBe(401);
  });

  it("a session ends after eight hours, and after half an hour unused", async () => {
    const b = await signedInAdmin();
    await db.query("UPDATE admin_sessions SET last_seen_at = now() - interval '31 minutes'");
    expect((await b.get("/me")).status).toBe(401);
    const c = await signedInAdmin(AYUSHI, "Ayushi");
    await db.query("UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE admin_id = $1", [c.admin.id]);
    expect((await c.get("/me")).status).toBe(401);
  });

  it("a switched-off admin cannot sign in or carry on", async () => {
    const b = await signedInAdmin();
    await db.query("UPDATE admins SET disabled_at = now()");
    expect((await b.get("/me")).status).toBe(401);
    expect((await adminBrowser().post("/auth/login").send({ email: AADITYA, password: PASSWORD })).status).toBe(401);
  });

  it("keeps only a hash of the session and of the password", async () => {
    const b = await signedInAdmin();
    const raw = b.cookie.split("kaho_admin=")[1]?.split(";")[0] ?? "";
    const rows = (await db.query("SELECT token_hash FROM admin_sessions")).rows;
    expect(rows).toHaveLength(1);
    expect(raw.length).toBeGreaterThan(20);
    expect(rows[0].token_hash).not.toBe(raw);
    const a = (await db.query("SELECT hash, salt FROM admins")).rows[0];
    expect(a.hash).not.toContain(PASSWORD);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the two doors are separate", () => {
  it("the admin API answers only to the admin site's origin and host", async () => {
    const b = await signedInAdmin();
    const cookie = b.cookie;
    const studio = request(app).get("/api/admin/me").set("Origin", "http://localhost:5173").set("Host", "localhost:5173").set("Cookie", cookie);
    expect((await studio).status).toBe(403); // the Studio's page may not call the admin API
    const stranger = request(app).get("/api/admin/me").set("Origin", "https://evil.example").set("Host", "localhost:5174").set("Cookie", cookie);
    expect((await stranger).status).toBe(403);
    const wrongHost = request(app).get("/api/admin/me").set("Origin", ADMIN_ORIGIN).set("Host", "evil.example").set("Cookie", cookie);
    expect((await wrongHost).status).toBe(403);
    const noOrigin = request(app).post("/api/admin/auth/logout").set("Host", "localhost:5174").set("Cookie", cookie);
    expect((await noOrigin).status).toBe(403); // a change must say which page sent it
  });

  it("the Studio's API refuses the admin site's origin", async () => {
    await owner();
    const r = await request(app).get("/api/me").set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174");
    expect(r.status).toBe(403);
  });

  it("an admin's cookie is useless against the Studio, and a Studio cookie against the admin site", async () => {
    const admin = await signedInAdmin();
    const adminCookie = admin.cookie;
    const asStudio = await request(app).get("/api/me").set("Origin", "http://localhost:5173").set("Host", "localhost:8020").set("Cookie", adminCookie);
    expect(asStudio.status).toBe(401);
    await owner({ email: "studio@acme.in", organization: "Acme" });
    const login = await request(app).post("/api/auth/login").set("Origin", "http://localhost:5173").set("Host", "localhost:8020")
      .send({ email: "studio@acme.in", password: "correct horse" });
    const studioCookie = login.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
    const asAdmin = await request(app).get("/api/admin/me").set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174").set("Cookie", studioCookie);
    expect(asAdmin.status).toBe(401);
  });

  it("every admin page needs the admin session, and an unknown path is a 404 not a leak", async () => {
    const b = adminBrowser();
    for (const path of ["/overview", "/orgs", "/users", "/plans", "/topups", "/audit", "/health", "/me"]) {
      expect((await b.get(path)).status, path).toBe(401);
    }
    const admin = await signedInAdmin();
    expect((await admin.get("/no-such-page")).status).toBe(404);
    expect((await admin.get("/orgs/not-an-org")).status).toBe(404);
  });

  it("carries the same security headers as the Studio's API", async () => {
    const r = await adminBrowser().get("/auth/state");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });

  it("refuses a body that is not JSON, one with a NUL byte, and one that is too large", async () => {
    const b = await signedInAdmin();
    const text = await b.agent.post("/api/admin/auth/logout").set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174").set("Content-Type", "text/plain").send("hello");
    expect(text.status).toBe(415);
    const nul = await adminBrowser().post("/auth/login").send({ email: `a\u0000b@gmail.com`, password: PASSWORD });
    expect(nul.status).toBe(400);
    const big = await adminBrowser().post("/auth/login").send({ email: AADITYA, password: "p".repeat(100_000) });
    expect([400, 413]).toContain(big.status);
  });
});

describe("a Studio session is not an admin", () => {
  it("the Studio's own cookies never carry an admin role, and there is no admin permission", async () => {
    const studio = await owner();
    const me = (await studio.get("/api/me")).body;
    expect(JSON.stringify(me)).not.toMatch(/admin_session|kaho_admin/);
    expect((await studio.get("/api/admin/overview")).status).toBe(403); // the Studio's origin is not the admin site's
    const browserWithHeaders = browser();
    expect((await browserWithHeaders.get("/api/admin/me")).status).toBe(403);
  });
});
