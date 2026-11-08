import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, member, owner } from "./helpers.js";
import { AVATARS } from "../src/models/avatars.js";

beforeEach(freshDb);

describe("choosing an icon for yourself", () => {
  it("offers a short, playful list and starts with none chosen", async () => {
    const b = await owner();
    expect(AVATARS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(AVATARS).size).toBe(AVATARS.length);
    expect((await b.get("/api/me")).body.avatar).toBeNull();
    expect((await b.get("/api/avatars")).body).toEqual(AVATARS);
  });

  it("is saved, and shows next to the person's name for everyone", async () => {
    const b = await owner();
    const r = await b.patch("/api/me/profile").send({ avatar: AVATARS[3] });
    expect(r.status).toBe(200);
    expect(r.body.avatar).toBe(AVATARS[3]);
    expect((await b.get("/api/me")).body.avatar).toBe(AVATARS[3]);
    const m = await member(b);
    expect((await m.get("/api/team")).body.find((u) => u.id === b.user.id).avatar).toBe(AVATARS[3]);
  });

  it("can be taken off again, going back to the initials", async () => {
    const b = await owner();
    await b.patch("/api/me/profile").send({ avatar: AVATARS[0] });
    expect((await b.patch("/api/me/profile").send({ avatar: null })).body.avatar).toBeNull();
  });

  it("accepts only an icon from the list, never free text", async () => {
    const b = await owner();
    for (const bad of ["<script>alert(1)</script>", "x", "🦜🦜", 5, "", "../../etc/passwd"]) {
      const r = await b.patch("/api/me/profile").send({ avatar: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("is each person's own: a viewer can choose theirs, and it changes no one else's", async () => {
    const b = await owner();
    const m = await member(b);
    expect((await m.patch("/api/me/profile").send({ avatar: AVATARS[5] })).status).toBe(200);
    expect((await b.get("/api/me")).body.avatar).toBeNull();
  });
});
