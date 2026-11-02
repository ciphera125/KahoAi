import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, owner } from "./helpers.js";

beforeEach(freshDb);

describe("leads", () => {
  it("records a lead from the voice service and lists it in the Studio", async () => {
    const b = await owner();
    const orgId = b.user.org_id;
    const r = await internal("post", "/internal/v1/leads").send({
      call_id: "c8eea833-f765-449e-ba8e-e7554f8f1e21", name: "Asha Rao", phone: "9876543210",
      phone_source: "caller_stated", reason: "wants a callback about pricing", org_id: orgId,
    });
    expect(r.status).toBe(200);
    const list = (await b.get("/api/leads")).body;
    expect(list.leads).toHaveLength(1);
    expect(list.leads[0]).toMatchObject({
      name: "Asha Rao", phone: "9876543210", phone_source: "caller_stated",
      reason: "wants a callback about pricing", call_id: "c8eea833-f765-449e-ba8e-e7554f8f1e21",
    });
    expect(list.leads[0].id).toBeTruthy();
    expect(list.leads[0].at).toBeTruthy();
  });

  it("also raises a notification, linked to a leads view", async () => {
    const b = await owner();
    await internal("post", "/internal/v1/leads").send({
      name: "Ravi", phone: "9999988888", phone_source: "call_metadata",
      reason: "interested", org_id: b.user.org_id,
    });
    const feed = (await b.get("/api/notifications")).body;
    const note = feed.items.find((n) => n.text.includes("Ravi"));
    expect(note).toBeTruthy();
    expect(note.view).toBe("leads");
  });

  it("rejects a lead with no name or phone", async () => {
    const r1 = await internal("post", "/internal/v1/leads").send({
      phone: "123", phone_source: "call_metadata", reason: "x", org_id: "whatever",
    });
    expect(r1.status).toBe(400);
    const r2 = await internal("post", "/internal/v1/leads").send({
      name: "Ravi", phone_source: "call_metadata", reason: "x", org_id: "whatever",
    });
    expect(r2.status).toBe(400);
  });

  it("isolates leads per organization", async () => {
    const a = await owner();
    const b = await owner({ email: "other@acme.in", organization: "Other Co" });
    await internal("post", "/internal/v1/leads").send({
      name: "A", phone: "1", phone_source: "call_metadata", reason: "x", org_id: a.user.org_id,
    });
    const list = (await b.get("/api/leads")).body;
    expect(list.leads).toHaveLength(0);
  });

  it("pages and limits the lead list", async () => {
    const b = await owner();
    for (let i = 0; i < 3; i++) {
      await internal("post", "/internal/v1/leads").send({
        name: `Lead ${i}`, phone: "1", phone_source: "call_metadata", reason: "x", org_id: b.user.org_id,
      });
    }
    const page1 = (await b.get("/api/leads?limit=2")).body;
    expect(page1.leads).toHaveLength(2);
  });
});
