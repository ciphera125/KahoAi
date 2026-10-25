import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, member, owner, db } from "./helpers.js";
import { config } from "../src/config/env.js";

const ENV = { PLIVO_FROM_NUMBER: undefined, PLIVO_AUTH_ID: undefined, PLIVO_AUTH_TOKEN: undefined };
beforeEach(freshDb);
afterEach(() => Object.assign(config, ENV));

const plivo = (b, body = {}) => b.post("/api/numbers").send({ provider: "plivo", number: "+91 80655 20552",
  label: "Main line", credentials: { auth_id: "MAID123", auth_token: "secret-token-9876" }, ...body });

describe("numbers", () => {
  it("lists our .env Plivo number from the start, active, without copying or showing its token", async () => {
    Object.assign(config, { PLIVO_FROM_NUMBER: "+918065520552", PLIVO_AUTH_ID: "ENVID", PLIVO_AUTH_TOKEN: "env-token-1234" });
    const b = await owner();
    const list = (await b.get("/api/numbers")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "plivo", number: "+918065520552", label: "Main line", is_default: true,
      status: "active", credentials_from_env: true, credentials: { auth_id: "ENVID", auth_token: "••••1234" }, agent_id: null });
    const { rows } = await db.query("SELECT credentials_enc FROM phone_numbers");
    expect(rows[0].credentials_enc).toBeNull();
  });

  it("keeps a deleted .env number deleted", async () => {
    Object.assign(config, { PLIVO_FROM_NUMBER: "+918065520552", PLIVO_AUTH_ID: "ENVID", PLIVO_AUTH_TOKEN: "t" });
    const b = await owner();
    const [n] = (await b.get("/api/numbers")).body;
    expect((await b.delete(`/api/numbers/${n.id}`)).body).toEqual({ deleted: n.id });
    expect((await b.get("/api/numbers")).body).toEqual([]);
  });

  it("adds, edits and deletes a number, encrypting its secret and never showing it", async () => {
    const b = await owner();
    const added = await plivo(b);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ number: "+918065520552", status: "active", is_default: true,
      credentials: { auth_id: "MAID123", auth_token: "••••9876" } });
    const { rows } = await db.query("SELECT credentials_enc FROM phone_numbers");
    expect(rows[0].credentials_enc).toMatch(/^v1\./);
    expect(rows[0].credentials_enc).not.toContain("secret-token");
    const kept = await b.patch(`/api/numbers/${added.body.id}`).send({ label: "Sales", credentials: { auth_id: "", auth_token: "" } });
    expect(kept.body).toMatchObject({ label: "Sales", credentials: { auth_id: "MAID123", auth_token: "••••9876" } });
    const changed = await b.patch(`/api/numbers/${added.body.id}`).send({ credentials: { auth_token: "new-token-5555" } });
    expect(changed.body.credentials.auth_token).toBe("••••5555");
    expect((await b.delete(`/api/numbers/${added.body.id}`)).status).toBe(200);
    expect((await b.patch(`/api/numbers/${added.body.id}`).send({ label: "x" })).status).toBe(404);
  });

  it("refuses bad numbers, missing credentials, unknown providers and duplicates", async () => {
    const b = await owner();
    expect((await plivo(b, { number: "12" })).body.error).toBe("'12' is not a phone number");
    expect((await plivo(b, { credentials: { auth_id: "x" } })).body.error).toBe("missing: Auth token");
    expect((await plivo(b, { provider: "nokia" })).body.error).toBe("unknown provider 'nokia'");
    await plivo(b);
    expect((await plivo(b)).body.error).toBe("+918065520552 is already added");
  });

  it("shows providers without telephony as not connected", async () => {
    const b = await owner();
    const r = await b.post("/api/numbers").send({ provider: "exotel", number: "9876543210",
      credentials: { account_sid: "a", api_key: "b", api_token: "c", subdomain: "d" } });
    expect(r.body.status).toBe("not_connected");
    const providers = (await b.get("/api/providers")).body;
    expect(providers.map((p) => [p.id, p.connected])).toEqual([["plivo", true], ["exotel", false], ["twilio", false], ["sip", false]]);
  });

  it("moves the default when the default is deleted, and sets a new default", async () => {
    const b = await owner();
    const one = (await plivo(b)).body;
    const two = (await plivo(b, { number: "9876543210" })).body;
    expect(two.is_default).toBe(false);
    expect((await b.post(`/api/numbers/${two.id}/default`)).body.is_default).toBe(true);
    await b.delete(`/api/numbers/${two.id}`);
    expect((await b.get("/api/numbers")).body[0]).toMatchObject({ id: one.id, is_default: true });
  });

  it("routes a number to an agent, and back to the default persona", async () => {
    const b = await owner();
    const n = (await plivo(b)).body;
    const a = (await b.post("/api/agents").send({ name: "Inbound", prompt: "Hi" })).body;
    expect((await b.post(`/api/numbers/${n.id}/agent`).send({ agent_id: a.id })).body.agent_id).toBe(a.id);
    expect((await b.get(`/api/agents/${a.id}`)).body.numbers).toEqual(["+918065520552"]);
    expect((await b.post(`/api/numbers/${n.id}/agent`).send({ agent_id: "ag_000000000000" })).status).toBe(404);
    expect((await b.post(`/api/numbers/${n.id}/agent`).send({ agent_id: null })).body.agent_id).toBeNull();
  });

  it("lets only the owner change numbers", async () => {
    const o = await owner();
    const n = (await plivo(o)).body;
    const m = await member(o);
    expect((await m.get("/api/numbers")).status).toBe(200);
    expect((await plivo(m, { number: "9876543210" })).status).toBe(403);
    expect((await m.patch(`/api/numbers/${n.id}`).send({ label: "x" })).status).toBe(403);
    expect((await m.post(`/api/numbers/${n.id}/default`)).status).toBe(403);
    expect((await m.post(`/api/numbers/${n.id}/agent`).send({ agent_id: null })).status).toBe(403);
    expect((await m.delete(`/api/numbers/${n.id}`)).status).toBe(403);
  });
});
