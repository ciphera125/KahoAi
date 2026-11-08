import * as Knowledge from "../models/Knowledge.js";
import * as Agent from "../models/Agent.js";
import * as AgentTest from "../models/AgentTest.js";
import * as Call from "../models/Call.js";
import { ceilingMinutes } from "./workspaceController.js";
import { note } from "./notify.js";
import { forbidden, ValidationError } from "../utils/errors.js";

export async function list(_req, res) {
  const org = _req.user.org_id;
  const [agents, counts] = await Promise.all([Agent.list(org), Call.countsByAgent(org)]);
  res.json(agents.map((a) => ({ ...a, call_count: counts[a.id] ?? 0 })));
}

export async function create(req, res) {
  const { name, description, prompt, template } = req.body ?? {};
  const agent = template === undefined
    ? await Agent.create(req.user.org_id, { name, description, prompt })
    : await Agent.createFromTemplate(req.user.org_id, template, { name, description });
  await note(req, "agent", `Created the agent ${agent.name}`, "agents", agent.id);
  res.json(agent);
}

/** Make the draft live. Only an admin may publish over the checks. */
export async function publish(req, res) {
  const { note: why, override } = req.body ?? {};
  if (override && !["owner", "admin"].includes(req.user.role)) {
    throw forbidden("Only an owner or admin can publish a draft that has problems.");
  }
  const agent = await Agent.publish(req.user.org_id, req.params.agentId,
    { user: req.user, note: why, override: Boolean(override) });
  await note(req, "agent", `Published ${agent.name} version ${agent.live_version.number}`
    + (override ? " (over the checks)" : ""), "agents", agent.id);
  res.json(agent);
}

export async function check(req, res) {
  res.json(await Agent.check(req.user.org_id, req.params.agentId));
}

/** Try the draft in a short simulated conversation. Costs tokens, so it is not open to
 * every member: an owner or admin runs it. */
export async function test(req, res) {
  const result = await AgentTest.run(req.user.org_id, req.params.agentId,
    { messages: req.body?.messages ?? null, user: req.user });
  res.json(result);
}

export async function variables(req, res) {
  res.json(await Agent.variables(req.user.org_id, req.params.agentId));
}

export async function versions(req, res) {
  res.json(await Agent.versions(req.user.org_id, req.params.agentId));
}

export async function restore(req, res) {
  const agent = await Agent.restore(req.user.org_id, req.params.agentId, req.params.versionId, { user: req.user });
  await note(req, "agent", `Rolled ${agent.name} back; it is now version ${agent.live_version.number}`, "agents", agent.id);
  res.json(agent);
}

export async function get(req, res) {
  res.json(await Agent.get(req.user.org_id, req.params.agentId));
}

export async function update(req, res) {
  const body = req.body ?? {};
  const settings = body.settings;
  if (settings && typeof settings === "object" && "max_minutes" in settings) {
    const ceiling = ceilingMinutes();
    if (Number(settings.max_minutes) > ceiling) {
      throw new ValidationError(`Longest call can be at most ${ceiling} minutes on this server (MAX_CALL_DURATION_SECS)`);
    }
  }
  const agent = await Agent.update(req.user.org_id, req.params.agentId, body);
  const what = "tools" in body ? "tools" : "settings" in body ? "call settings"
    : "active_prompt_id" in body ? "prompt in use" : "details";
  await note(req, "agent", `Changed the ${what} of ${agent.name}`, "agents", agent.id);
  res.json(agent);
}

export async function remove(req, res) {
  const { name } = await Agent.remove(req.user.org_id, req.params.agentId);
  await note(req, "agent", `Deleted the agent ${name}; its prompts are kept`, "prompts");
  res.json({ deleted: req.params.agentId });
}

export async function knowledge(req, res) { res.json(await Knowledge.list(req.user.org_id, req.params.agentId)); }
export async function addKnowledge(req, res) {
  const doc = await Knowledge.add(req.user.org_id, req.params.agentId, req.body ?? {});
  await note(req, "agent", `Added the document ${doc.title} to an agent`, "agents", req.params.agentId);
  res.json(doc);
}
export async function removeKnowledge(req, res) { res.json(await Knowledge.remove(req.user.org_id, req.params.agentId, req.params.docId)); }
