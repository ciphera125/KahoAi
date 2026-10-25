import * as Agent from "../models/Agent.js";
import * as Call from "../models/Call.js";
import { ceilingMinutes } from "./workspaceController.js";
import { note } from "./notify.js";
import { ValidationError } from "../utils/errors.js";

export async function list(_req, res) {
  const org = _req.user.org_id;
  const [agents, counts] = await Promise.all([Agent.list(org), Call.countsByAgent(org)]);
  res.json(agents.map((a) => ({ ...a, call_count: counts[a.id] ?? 0 })));
}

export async function create(req, res) {
  const { name, description, prompt } = req.body ?? {};
  const agent = await Agent.create(req.user.org_id, { name, description, prompt });
  await note(req, "agent", `Created the agent ${agent.name}`, "agents", agent.id);
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
