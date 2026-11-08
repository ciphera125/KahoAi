import { LANGUAGES } from "../models/language.js";
import { config } from "../config/env.js";
import * as User from "../models/User.js";
import * as Activity from "../models/Activity.js";
import * as Workspace from "../models/Workspace.js";
import * as CustomTool from "../models/CustomTool.js";
import * as PhoneNumber from "../models/PhoneNumber.js";
import { MAX_MINUTES, MAX_PROMPT_CHARS, RING_SECS, TOOL_CATALOG } from "../models/Agent.js";
import { resolveMaxDuration } from "../services/dialer.js";
import { normalizeNumber } from "../utils/phone.js";

export async function me(req, res) {
  const org = req.user.org_id;
  await PhoneNumber.ensureSeeded(org);
  const [counts, members] = await Promise.all([Workspace.counts(org), User.members(org)]);
  const out = { ...req.user, counts,
    members: members.map((m) => ({ name: m.name, email: m.email, role: m.role })) };
  if (["owner", "admin"].includes(req.user.role)) {
    const invite = await User.currentInvite(org);
    out.invite_code = invite.code;
    out.invite_expires = invite.expires;
  }
  res.json(out);
}

/** The longest call worth offering: the phone server cuts every call at its own
 * MAX_CALL_DURATION_SECS, whatever an agent asks for. */
export function ceilingMinutes() {
  try {
    return Math.max(1, Math.min(MAX_MINUTES, Math.floor(resolveMaxDuration(null) / 60)));
  } catch {
    return MAX_MINUTES;
  }
}

function ourNumber() {
  try { return normalizeNumber(config.PLIVO_FROM_NUMBER || ""); } catch { return null; }
}

export function settings(_req, res) {
  res.json({ our_number: ourNumber(), max_chars: MAX_PROMPT_CHARS, tools: TOOL_CATALOG,
    languages: LANGUAGES, limits: { max_minutes: ceilingMinutes(), ring_secs: [...RING_SECS] } });
}

/** Everything an agent can be given: the built-in tools, then this organization's own. */
export async function tools(req, res) {
  const own = await CustomTool.list(req.user.org_id);
  res.json([
    ...TOOL_CATALOG.map((t) => ({ ...t, ready: !t.needs || Boolean(config[t.needs]) })),
    ...own.map((t) => ({ name: t.name, label: t.label, description: t.description || "Calls your own system.",
      needs: null, ready: true, custom: true })),
  ]);
}

export function providers(_req, res) {
  res.json(Object.entries(PhoneNumber.PROVIDERS).map(([id, p]) => ({ id, label: p.label, connected: p.connected,
    fields: p.fields.map(([name, label, secret]) => ({ name, label, secret })) })));
}

export async function notifications(req, res) {
  const [items, unread] = await Promise.all([
    Activity.recent(req.user.org_id, req.query.limit ?? 30, req.user.seen_at), Activity.unread(req.user.org_id, req.user.seen_at)]);
  res.json({ items, unread });
}

export async function notificationsSeen(req, res) {
  const [latest] = await Activity.recent(req.user.org_id, 1);
  // One millisecond past it: the feed's time is cut to milliseconds but the stored one is not,
  // so without this the newest item stayed unread after "Mark all read".
  if (latest) await User.markSeen(req.user.org_id, req.user.id, new Date(Date.parse(latest.at) + 1));
  res.json({ unread: 0 });
}
