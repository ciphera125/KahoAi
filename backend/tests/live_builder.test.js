// Real model, real network: only runs with GROQ_LIVE=1 (npx cross-env GROQ_LIVE=1 vitest run tests/live_builder.test.js).
const live = process.env.GROQ_LIVE ? it : it.skip;
import { beforeEach, expect, it } from "vitest";
import { freshDb, owner } from "./helpers.js";
import { readFileSync } from "node:fs";
import { config } from "../src/config/env.js";
import { useModel } from "../src/models/llm.js";
config.GROQ_API_KEY = /^GROQ_API_KEY=(.+)$/m.exec(readFileSync(new URL("../.env", import.meta.url), "utf8"))?.[1]?.trim();
beforeEach(freshDb);
const PROMPTS = [
  "I need to fetch the details of users when they are going to pay their next loan amount, and the exact date they will be able to pay",
  "Ask the customer how much of the EMI they can pay and when, and save both",
  "Find out if the customer is interested, and their budget",
  "Get the callers alternate phone number and their city",
  "I want to know when the person will repay",
  "Collect the customers email id",
  "Ask them which plan they want: basic, standard or premium",
  "Capture the date they promise to pay and the amount",
];
for (const p of PROMPTS) live(p.slice(0, 50), async () => {
  useModel(null);
  const { model } = await import('../src/models/llm.js'); const real = model(); useModel(async (rq) => { const o = await real(rq); console.log('RAW:', JSON.stringify(o.message.tool_calls?.[0]?.function?.arguments ?? o.message.content)); return o; });
  const b = await owner();
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  const msgs = [{ role: "user", content: p }];
  let r = (await b.post("/api/assistant/message").send({ agent_id: a.id, messages: msgs })).body;
  console.log("\nPROMPT:", p, "\nREPLY:", r.reply, "\nCREATED:", JSON.stringify(r.created));
  if (!r.created && /web address/i.test(r.reply)) {
    msgs.push({ role: "assistant", content: r.reply }, { role: "user", content: "https://api.example.com/orders" });
    r = (await b.post("/api/assistant/message").send({ agent_id: a.id, messages: msgs })).body;
    console.log("AFTER ADDRESS:", r.reply, JSON.stringify(r.created));
  }
  const ag = (await b.get(`/api/agents/${a.id}`)).body;
  console.log("FIELDS:", JSON.stringify(ag.settings.capture_fields?.map((f) => [f.key, f.kind])), "TOOLS:", ag.tools.join(","));
  console.log("PROMPT NOW:", (await b.get(`/api/prompts/${ag.active_prompt_id}`)).body.prompt.replace(/\n/g, " | "));
  expect(r.created).toBeTruthy();
}, 60000);
