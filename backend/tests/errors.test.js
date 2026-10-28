import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, owner } from "./helpers.js";

beforeEach(freshDb);

describe("error logs", () => {
  it("records an error from the voice service and lists it in the Studio", async () => {
    const b = await owner();
    const orgId = b.user.org_id;
    const r = await internal("post", "/internal/v1/errors").send({
      level: "error", source: "tts", message: "Smallest returned 503", org_id: orgId,
    });
    expect(r.status).toBe(200);
    const list = (await b.get("/api/errors")).body;
    expect(list.errors).toHaveLength(1);
    expect(list.errors[0]).toMatchObject({ level: "error", source: "tts", message: "Smallest returned 503" });
    expect(list.errors[0].id).toBeTruthy();
    expect(list.errors[0].at).toBeTruthy();
  });

  it("associates errors with a call when a call_id is given", async () => {
    const b = await owner();
    await internal("post", "/internal/v1/errors").send({
      level: "warn", source: "llm", message: "Groq 429: rate limited", call_id: null, org_id: b.user.org_id,
    });
    const list = (await b.get("/api/errors")).body;
    expect(list.errors[0]).toMatchObject({ source: "llm", call_id: null });
  });

  it("pages and limits the error list", async () => {
    const b = await owner();
    const orgId = b.user.org_id;
    for (let i = 0; i < 3; i++) {
      await internal("post", "/internal/v1/errors").send({ level: "error", source: "tts", message: `err ${i}`, org_id: orgId });
    }
    const page1 = (await b.get("/api/errors?limit=2")).body;
    expect(page1.errors).toHaveLength(2);
  });
});
