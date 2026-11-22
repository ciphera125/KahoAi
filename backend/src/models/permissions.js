// Who may do what. One table, used twice: the server checks it on every route that changes
// something, and the Settings page prints it, so what the page says a role can do is exactly
// what the server lets it do.
//
// Five roles, one of them in charge. The person who creates an organization is an admin, with exactly
// the powers every admin has. An admin gives everyone else a role, including admin. An invite code is
// made for one role (never admin) and gives that role and no more; someone who needs more is promoted
// from the People list afterwards, so nobody gets more than was meant.

export const PERMISSIONS = [
  { id: "view", group: "Looking", label: "See the dashboard, calls, transcripts, contacts, agents and tasks" },
  { id: "recordings.listen", group: "Calls", label: "Listen to and download call recordings" },
  { id: "calls.place", group: "Calls", label: "Place calls one at a time" },
  { id: "calls.bulk", group: "Calls", label: "Place bulk calls from a list" },
  { id: "contacts.edit", group: "People", label: "Add and change contacts, tags and tasks" },
  { id: "contacts.delete", group: "People", label: "Delete contacts in bulk" },
  { id: "agents.edit", group: "Agents", label: "Create and change agents, prompts and questions; test and publish them" },
  { id: "tools.custom", group: "Agents", label: "Make tools that call your own system" },
  { id: "agents.delete", group: "Agents", label: "Delete agents and prompts" },
  { id: "numbers.manage", group: "Organization", label: "Add and change phone numbers and their credentials" },
  { id: "keys.manage", group: "Organization", label: "Make and revoke API keys" },
  { id: "team.manage", group: "Organization", label: "Invite people and remove them" },
  { id: "team.roles", group: "Organization", label: "Change people's roles" },
  { id: "org.settings", group: "Organization", label: "Change the organization-wide call settings" },
  { id: "billing.manage", group: "Organization", label: "Choose the plan and top up minutes" },
];

const ALL = PERMISSIONS.map((p) => p.id);

export const ROLES = [
  { id: "admin", label: "Admin", permissions: ALL,
    summary: "In charge of the organization: can do everything, including the plan, numbers, people and roles, and can make others admins." },
  { id: "manager", label: "Manager",
    permissions: ["view", "recordings.listen", "calls.place", "calls.bulk", "contacts.edit", "contacts.delete", "agents.edit"],
    summary: "Runs the daily work: builds agents, places calls and bulk calls, listens to recordings and looks after contacts. Cannot change numbers or people." },
  { id: "builder", label: "Agent builder",
    permissions: ["view", "agents.edit", "tools.custom"],
    summary: "Builds and tests agents, prompts, questions and tools. Cannot place calls or listen to recordings." },
  { id: "operator", label: "Caller",
    permissions: ["view", "recordings.listen", "calls.place", "contacts.edit"],
    summary: "Places calls, listens to recordings and looks after contacts and tasks. Cannot change agents." },
  { id: "viewer", label: "Viewer", permissions: ["view"],
    summary: "Read only: sees the dashboard, calls and transcripts. Cannot listen to recordings or change anything." },
];

/** Roles an admin may give to someone in the organization. */
export const ASSIGNABLE = ROLES.map((r) => r.id);
/** Roles an invite code may carry. Never admin: the person joins, and an admin promotes them from the People list. */
export const INVITABLE = ASSIGNABLE.filter((id) => id !== "admin");

const BY_ROLE = new Map(ROLES.map((r) => [r.id, new Set(r.permissions)]));

export const permissionsOf = (role) => [...(BY_ROLE.get(role) ?? [])];
export const can = (role, permission) => BY_ROLE.get(role)?.has(permission) ?? false;
