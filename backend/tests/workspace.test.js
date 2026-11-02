import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, owner } from "./helpers.js";

beforeEach(freshDb);

describe("GET /api/settings", () => {
  it("is the same workspace config the Settings page reads (the frontend calls /settings, not /config)", async () => {
    const b = await owner();
    const r = await b.get("/api/settings");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("limits");
    expect(r.body).toHaveProperty("max_chars");
    expect(r.body).toHaveProperty("tools");
  });
});
