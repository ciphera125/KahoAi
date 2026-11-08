import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, member, owner } from "./helpers.js";
import { TEMPLATES } from "../src/models/templates.js";

beforeEach(freshDb);

describe("starter templates", () => {
  it("lists ready-made agents for common jobs, without their full prompts", async () => {
    const b = await owner();
    const r = await b.get("/api/templates");
    expect(r.status).toBe(200);
    expect(r.body.map((t) => t.id)).toEqual(expect.arrayContaining(["emi_reminder", "appointment_confirmation", "lead_qualification"]));
    for (const t of r.body) {
      expect(t).toMatchObject({ id: expect.any(String), name: expect.any(String), summary: expect.any(String) });
      expect(t.prompt).toBeUndefined();
    }
  });

  it("makes a working agent from a template: prompt, questions and tools together", async () => {
    const b = await owner();
    const r = await b.post("/api/agents").send({ template: "emi_reminder" });
    expect(r.status).toBe(200);
    expect(r.body.name).toMatch(/EMI/i);
    const full = (await b.get(`/api/agents/${r.body.id}`)).body;
    expect(full.settings.capture_fields.length).toBeGreaterThan(0);
    expect(full.tools).toContain("save_answer");
    expect((await b.get(`/api/prompts/${full.active_prompt_id}`)).body.prompt).toMatch(/save_answer/);
  });

  it("lets the person rename it, and keeps what they typed over the template", async () => {
    const b = await owner();
    const r = await b.post("/api/agents").send({ template: "lead_qualification", name: "Sales Ria" });
    expect(r.body.name).toBe("Sales Ria");
  });

  it("refuses a template that does not exist", async () => {
    const b = await owner();
    expect((await b.post("/api/agents").send({ template: "nope" })).status).toBe(400);
    expect((await b.post("/api/agents").send({ template: { $ne: 1 } })).status).toBe(400);
  });

  it("only those who can build agents may use one", async () => {
    const b = await owner();
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.post("/api/agents").send({ template: "emi_reminder" })).status).toBe(403);
  });

  it("every template passes the same checks as an agent made by hand", async () => {
    const b = await owner();
    for (const t of TEMPLATES) {
      const r = await b.post("/api/agents").send({ template: t.id, name: `From ${t.id}` });
      expect(r.status, t.id).toBe(200);
    }
  });
});
