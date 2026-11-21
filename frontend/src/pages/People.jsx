// Settings, People: everyone in the organization, the role each one has, and the invite codes. An admin picks the
// role a code gives; whoever joins with it gets exactly that role. All of it is enforced on the server too.
import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { can, isAdmin, useAuth } from "../auth.jsx";
import { ago, Avatar, Icon, Info, Menu, Spinner, useConfirm, usePaged, useToast } from "../ui.jsx";

const INVITABLE = ["manager", "builder", "operator", "viewer"];
// What each role means, in plain words, for the person choosing it. Enforced on the server (permissions.js).
const ROLE_DETAIL = {
  admin: { can: ["Everything, including plans, numbers, people, roles and keys"], cannot: ["Remove themselves while they are the last admin"], for: "The owner or the person in charge" },
  manager: { can: ["Build and change agents", "Place calls and bulk calls", "Listen to recordings", "Look after contacts and tasks"],
    cannot: ["Change phone numbers", "Invite or remove people", "Make API keys"], for: "A team lead who runs the daily work" },
  builder: { can: ["Build and test agents, prompts, questions and tools"], cannot: ["Place calls", "Listen to recordings", "Change people or numbers"],
    for: "Someone who sets up how the agent talks" },
  operator: { can: ["Place calls", "Listen to recordings", "Look after contacts and tasks"], cannot: ["Change agents, prompts or tools", "Change people or numbers"],
    for: "A caller or support person who works with customers" },
  viewer: { can: ["See the dashboard, calls and written conversations"], cannot: ["Listen to recordings", "Change anything"], for: "Someone who only needs to watch the results" },
};
function RoleDetail({ id, label }) {
  const d = ROLE_DETAIL[id];
  if (!d) return null;
  return (
    <div className="role-detail" aria-live="polite">
      <b>{label}</b> <span className="hint">· good for: {d.for}</span>
      <div className="role-cols">
        <div><div className="role-yes">Can</div><ul>{d.can.map((x) => <li key={x}>{x}</li>)}</ul></div>
        <div><div className="role-no">Cannot</div><ul>{d.cannot.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
    </div>
  );
}

const daysLeft = (secs) => Math.max(1, Math.ceil((secs * 1000 - Date.now()) / 86400000));

export default function People() {
  const { me } = useAuth();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [team, setTeam] = useState(null);
  const [roles, setRoles] = useState([]);
  const [codes, setCodes] = useState([]);
  const [role, setRole] = useState("viewer");
  const admin = isAdmin(me);
  const load = useCallback(() => get("/api/team").then(setTeam).catch((e) => toast(e.message, true)), [toast]);
  const loadCodes = useCallback(() => { if (admin) get("/api/invites").then(setCodes).catch(() => {}); }, [admin]);
  const [shown, pager] = usePaged(team ?? []);
  const [shownCodes, codePager] = usePaged(codes);
  useEffect(() => { get("/api/roles").then((r) => setRoles(r.roles)).catch(() => {}); load(); loadCodes(); }, [load, loadCodes]);
  if (!team) return <Spinner />;

  const labelOf = (id) => roles.find((r) => r.id === id)?.label ?? id;
  const summaryOf = (id) => roles.find((r) => r.id === id)?.summary ?? "";
  const changeRole = async (u, next) => { try { await patch(`/api/team/${u.id}`, { role: next }); toast(`${u.name} is now ${labelOf(next)}.`); load(); } catch (e) { toast(e.message, true); } };
  const remove = async (u) => {
    if (!(await confirm({ title: `Remove ${u.name}?`, text: "They lose access immediately and every browser they are signed in on is signed out.", ok: "Remove" }))) return;
    try { await del(`/api/team/${u.id}`); toast(`${u.name} removed.`); load(); } catch (e) { toast(e.message, true); }
  };
  const makeCode = async () => { try { await post("/api/invites", { role }); toast(`Invite code made for ${labelOf(role)}.`); loadCodes(); } catch (e) { toast(e.message, true); } };
  const cancel = async (c) => { try { await del(`/api/invites/${encodeURIComponent(c.code)}`); toast("Code cancelled."); loadCodes(); } catch (e) { toast(e.message, true); } };
  const copy = (code) => navigator.clipboard.writeText(code).then(() => toast("Code copied. They enter it when they create their account."), () => toast("Could not copy; select the code instead.", true));
  // Only an admin changes roles or removes people, and never their own (the server holds the same rule).
  const canChange = (u) => admin && can(me, "team.roles") && u.id !== me.id;

  return (
    <div className="stack">
      {admin && (
        <div className="card">
          <div className="card-head"><span className="card-title">Invite someone<Info text="Make a code for the role you want, and send it to the person. They type it when they create their account and join with exactly that role." /></span></div>
          <p className="hint">Choose the role first. The code gives that role and nothing more; it works once, for a week.</p>
          <div className="chips" role="radiogroup" aria-label="Role the code gives">
            {INVITABLE.map((id) => <button key={id} type="button" role="radio" aria-checked={role === id} className={`chip${role === id ? " on" : ""}`} onClick={() => setRole(id)}>{labelOf(id)}</button>)}
          </div>
          <RoleDetail id={role} label={labelOf(role)} />
          <div className="actions"><button type="button" className="primary" onClick={makeCode}><Icon name="plus" />Make a {labelOf(role)} code</button></div>
          {codes.length > 0 && (
            <div className="table-wrap"><table className="rows"><thead><tr><th>Code</th><th>Gives</th><th>Left</th><th /></tr></thead>
              <tbody>{shownCodes.map((c) => (
                <tr key={c.code}><td className="code">{c.code}</td><td><span className="pill role">{labelOf(c.role)}</span></td><td>{daysLeft(c.expires)} days</td>
                  <td className="row-buttons"><button type="button" className="ghost small-btn" onClick={() => copy(c.code)}>Copy</button> <button type="button" className="ghost small-btn" onClick={() => cancel(c)}>Cancel</button></td></tr>))}</tbody></table></div>
          )}
          {codes.length > 0 && (codePager
          )}
        </div>
      )}
      <div className="card">
        <div className="card-head"><span className="card-title">People in {me.org_name}<Info text="Everyone who can sign in to this Studio, their role and when they were last active. An admin can change someone's role or remove them from the ⋯ menu." /></span>
          <span className="muted">{team.length} {team.length === 1 ? "person" : "people"}</span></div>
        <table className="rows people-table stack-sm">
          <thead><tr><th>Name</th><th>Role</th><th>Last active</th><th aria-label="Actions" /></tr></thead>
          <tbody>{shown.map((u) => (
            <tr key={u.id}>
              <td><div className="who"><Avatar name={u.name} avatar={u.avatar} /><div style={{ minWidth: 0 }}><b className="ellip">{u.name}{u.id === me.id && <span className="muted"> · you</span>}</b><div className="muted ellip">{u.email}</div></div></div></td>
              <td><span className={`pill role ${u.role === "admin" ? "active" : ""}`} title={summaryOf(u.role)}>{labelOf(u.role)}</span></td>
              <td className="muted">{ago(u.last_active)}</td>
              <td className="row-actions">{canChange(u) && (
                <Menu items={[
                  ...roles.filter((r) => r.id !== u.role).map((r) => [`Make ${r.label}`, () => changeRole(u, r.id)]),
                  ["Remove from organization", () => remove(u), true],
                ]} />)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {pager}
      {confirmNode}
    </div>
  );
}
