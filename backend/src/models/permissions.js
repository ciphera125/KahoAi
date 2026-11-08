// Who may do what. One table, used twice: the server checks it on every route that changes
// something, and the Settings page prints it, so what the page says a role can do is exactly
// what the server lets it do.
//
// Six roles. The person who creates an organization is its owner. They make admins, and give
// everyone else one of the four roles below an admin. Someone who joins with an invite code
// starts as a viewer and is given a role by an admin, so nobody gets more than was meant.

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
];

const ALL = PERMISSIONS.map((p) => p.id);

export const ROLES = [
  { id: "owner", label: "Owner", permissions: ALL,
    summary: "Created the organization. Can do everything, including making other admins." },
  { id: "admin", label: "Admin", permissions: ALL,
    summary: "Runs the organization: numbers, people, roles, keys and call settings, and everything below. Cannot make another admin." },
  { id: "manager", label: "Manager",
    permissions: ["view", "recordings.listen", "calls.place", "calls.bulk", "contacts.edit", "contacts.delete", "agents.edit"],
    summary: "Runs the daily work: builds agents, places calls and bulk calls, listens to recordings and looks after contacts. Cannot change numbers, people or keys." },
  { id: "builder", label: "Agent builder",
    permissions: ["view", "agents.edit", "tools.custom"],
    summary: "Builds and tests agents, prompts, questions and tools. Cannot place calls or listen to recordings." },
  { id: "operator", label: "Caller",
    permissions: ["view", "recordings.listen", "calls.place", "contacts.edit"],
    summary: "Places calls, listens to recordings and looks after contacts and tasks. Cannot change agents." },
  { id: "viewer", label: "Viewer", permissions: ["view"],
    summary: "Read only: sees the dashboard, calls and transcripts. Cannot listen to recordings or change anything." },
];

/** Roles an admin or the owner may hand out. The owner is only ever the person who made the organization. */
export const ASSIGNABLE = ROLES.map((r) => r.id).filter((id) => id !== "owner");
/** Roles an admin (not the owner) may hand out: everyone below an admin. */
export const BELOW_ADMIN = ASSIGNABLE.filter((id) => id !== "admin");
export const DEFAULT_ROLE = "viewer";

const BY_ROLE = new Map(ROLES.map((r) => [r.id, new Set(r.permissions)]));

export const permissionsOf = (role) => [...(BY_ROLE.get(role) ?? [])];
export const can = (role, permission) => BY_ROLE.get(role)?.has(permission) ?? false;
