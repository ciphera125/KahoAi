// Importing the Python Studio's files (data/*.json, logs/calls) into one organization.
// The script predated organizations: it imported a helper that no longer
// exists and wrote rows with no org_id, so it could not run at all.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { browser, db, freshDb, owner } from "./helpers.js";
import { importLegacy } from "../scripts/import-legacy.js";

beforeEach(freshDb);

async function legacyFiles() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kaho-legacy-"));
  const data = path.join(dir, "data"), calls = path.join(dir, "calls");
  await mkdir(data); await mkdir(calls);
  const w = (file, obj) => writeFile(path.join(data, file), JSON.stringify(obj));
  await w("users.json", { users: [{ id: "u_000000000001", name: "Old", email: "old@acme.in", company: "Old Co", role: "owner",
    salt: "00112233445566778899aabbccddeeff", hash: "0c8d1f7485863971ed8729638ffc6022d91976113849e21df0e059d9497949dc",
    created_at: 1761000000 }] });
  await w("agents.json", { agents: { ag_0123456789ab: { id: "ag_0123456789ab", name: "Main line", tools: ["end_call"],
    settings: { opening_line: "Hi" }, active_prompt_id: "pr_0123456789ab", created_at: 1761000000, updated_at: 1761000000 } },
  prompts: { pr_0123456789ab: { id: "pr_0123456789ab", name: "Main prompt", agent_id: "ag_0123456789ab", versions: [{ id: "0123456789ab", prompt: "You are Riya.", saved_at: 1761000000 }] } },
  routes: { "+918065520552": "ag_0123456789ab" } });
  await w("contacts.json", { tags: [{ id: "0123456789aa", name: "EMI due", color: "marigold" }],
    contacts: [{ id: "0123456789ac", name: "Asha", tags: ["0123456789aa"], numbers: [{ id: "0123456789ad", number: "+919876543210", tags: [] }] }] });
  await w("numbers.json", { numbers: [{ id: "0123456789ae", provider: "plivo", number: "+918065520552", env_backed: true, is_default: true }] });
  await writeFile(path.join(calls, "c8eea833-f765-449e-ba8e-e7554f8f1e21.jsonl"),
    `${JSON.stringify({ event: "call_start", at: "2026-10-20T10:00:00Z" })}\n${JSON.stringify({ event: "turn", role: "user", text: "hello" })}\n`);
  return { data, calls };
}

describe("importing the Python Studio", () => {
  it("brings everything into one new organization, owned by the old owner, who signs in with their old password", async () => {
    const files = await legacyFiles();
    const r = await importLegacy({ ...files, orgName: "Old Co" });
    expect(r.counts).toMatchObject({ users: 1, agents: 1, prompts: 1, contacts: 1, tags: 1, numbers: 1, transcripts: 1 });
    const b = browser();
    expect((await b.post("/api/auth/login").send({ email: "old@acme.in", password: "legacy pass" })).status).toBe(200);
    expect((await b.get("/api/me")).body).toMatchObject({ org_name: "Old Co", role: "owner" });
    expect((await b.get("/api/contacts")).body.contacts.map((c) => c.name)).toEqual(["Asha"]);
    expect((await b.get("/api/agents")).body.map((a) => a.name)).toEqual(["Main line"]);
    const { rows } = await db.query("SELECT DISTINCT org_id FROM contacts UNION SELECT DISTINCT org_id FROM agents UNION SELECT org_id FROM calls");
    expect(rows).toHaveLength(1);
  });

  it("can import into an organization that already exists, and running it twice adds nothing", async () => {
    const b = await owner();
    const orgId = (await b.get("/api/me")).body.org_id;
    const files = await legacyFiles();
    await importLegacy({ ...files, orgId });
    const again = await importLegacy({ ...files, orgId });
    expect(again.counts).toEqual({});
    expect((await b.get("/api/contacts")).body.contacts.map((c) => c.name)).toEqual(["Asha"]);
    expect((await b.get("/api/team")).body.map((u) => [u.name, u.role])).toEqual([["Asha Rao", "owner"], ["Old", "admin"]]);
  });

  it("refuses an organization that does not exist", async () => {
    const files = await legacyFiles();
    await expect(importLegacy({ ...files, orgId: "org_000000000000" })).rejects.toThrow(/no organization/);
  });
});
