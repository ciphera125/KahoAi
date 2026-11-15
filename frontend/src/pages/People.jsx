// Settings, People: everyone in the organization, the role each one has, and the invite codes. An admin picks the
// role a code gives; whoever joins with it gets exactly that role. All of it is enforced on the server too.
import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { can, isAdmin, useAuth } from "../auth.jsx";
import { ago, Avatar, Icon, Menu, Spinner, useConfirm, usePaged, useToast } from "../ui.jsx";

const INVITABLE = ["manager", "builder", "operator", "viewer"];
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
  const canChange = (u) => can(me, "team.roles") && u.id !== me.id;

  return (
    <div className="stack">
      {admin && (
        <div className="card">
          <div className="card-head"><span className="card-title">Invite someone</span></div>
          <p className="hint">Choose the role first. The code gives that role and nothing more; it works once, for a week.</p>
          <div className="chips" role="radiogroup" aria-label="Role the code gives">
            {INVITABLE.map((id) => <button key={id} type="button" role="radio" aria-checked={role === id} className={`chip${role === id ? " on" : ""}`} onClick={() => setRole(id)}>{labelOf(id)}</button>)}
          </div>
          <p className="hint">{summaryOf(role)}</p>
          <div className="actions"><button type="button" className="primary" onClick={makeCode}><Icon name="plus" />Make a {labelOf(role)} code</button></div>
          {codes.length > 0 && (
            <table className="rows"><thead><tr><th>Code</th><th>Gives</th><th>Left</th><th /></tr></thead>
              <tbody>{codes.map((c) => (
                <tr key={c.code}><td className="code">{c.code}</td><td><span className="pill role">{labelOf(c.role)}</span></td><td>{daysLeft(c.expires)} days</td>
                  <td><button type="button" className="ghost small-btn" onClick={() => copy(c.code)}>Copy</button> <button type="button" className="ghost small-btn" onClick={() => cancel(c)}>Cancel</button></td></tr>))}</tbody></table>
          )}
        </div>
      )}
      <div className="card list">
        <div className="card-head"><span className="card-title">People in {me.org_name}</span></div>
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.5fr) 170px minmax(0,1fr) 56px" }}><span>Name</span><span>Role</span><span>Last active</span><span /></div>
        {shown.map((u) => (
          <div key={u.id} className="row" style={{ gridTemplateColumns: "minmax(0,1.5fr) 170px minmax(0,1fr) 56px" }}>
            <div className="who"><Avatar name={u.name} avatar={u.avatar} /><div style={{ minWidth: 0 }}><b className="ellip">{u.name}{u.id === me.id && <span className="muted"> · you</span>}</b><div className="muted ellip">{u.email}</div></div></div>
            {canChange(u)
              ? <select className="role-select" value={u.role} aria-label={`Role for ${u.name}`} onChange={(e) => changeRole(u, e.target.value)}>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
              : <span className={`pill role ${u.role === "admin" ? "active" : ""}`}>{labelOf(u.role)}</span>}
            <span className="muted">{ago(u.last_active)}</span>
            <div className="row-actions">{admin && u.id !== me.id && <Menu items={[["Remove from organization", () => remove(u), true]]} />}</div>
          </div>
        ))}
      </div>
      {pager}
      {confirmNode}
    </div>
  );
}
