// Everyone with an account, across every organization. Switch an account off (its sessions end at once), switch it
// back on, or give someone a temporary password. A temporary password is shown once, here, and never written down.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post, qs } from "../api.js";
import { serverView } from "../../../frontend/src/paginate.js";
import { Modal, Pager, Spinner, useConfirm, useToast, ago } from "../../../frontend/src/ui.jsx";
import { Head, useDebounced } from "../parts.jsx";

export default function People() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [q, setQ] = useState("");
  const find = useDebounced(q);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [d, setD] = useState(null);
  const [fresh, setFresh] = useState(null);
  const load = useCallback(() => get(`/users${qs({ q: find, page, per_page: size })}`).then(setD).catch((e) => toast(e.message, true)), [find, page, size, toast]);
  useEffect(() => { setPage(1); }, [find, size]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (u) => {
    if (!u.disabled && !(await confirm({ title: `Switch off ${u.name}?`, text: "They are signed out everywhere at once and cannot sign in until you switch the account back on. Nothing is deleted.", ok: "Switch it off" }))) return;
    try { await post(`/users/${u.id}/${u.disabled ? "enable" : "disable"}`); toast(u.disabled ? "Switched on." : "Switched off."); await load(); } catch (e) { toast(e.message, true); }
  };
  const reset = async (u) => {
    if (!(await confirm({ title: `Reset ${u.name}'s password?`, text: "A temporary password is made and shown to you once. Their old password stops working and they are signed out everywhere.", ok: "Reset it" }))) return;
    try { setFresh(await post(`/users/${u.id}/reset-password`)); } catch (e) { toast(e.message, true); }
  };
  return (
    <section>
      <Head title="People" sub="Everyone with a Studio account. To change someone's role in a team, open the organization." />
      <div className="card list">
        <div className="list-bar"><input type="search" value={q} placeholder="Search by name or e-mail" aria-label="Search people" onChange={(e) => setQ(e.target.value)} />
          <span className="grow" /><span className="muted">{d ? `${d.total.toLocaleString("en-IN")} found` : ""}</span></div>
        {!d ? <Spinner /> : d.users.length === 0 ? <div className="empty">Nobody matches.</div> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>Person</th><th>Organizations</th><th>Last signed in</th><th>Account</th><th /></tr></thead>
            <tbody>{d.users.map((u) => (
              <tr key={u.id}><td><b>{u.name}</b><div className="hint">{u.email}</div></td>
                <td>{u.orgs.map((o) => <div key={o.id}><Link to={`/orgs/${o.id}`}>{o.name}</Link> <span className="hint">{o.role}</span></div>)}</td>
                <td>{u.last_login_at ? ago(u.last_login_at) : "never"}</td>
                <td><span className={`pill ${u.disabled ? "failed" : "active"}`}>{u.disabled ? "Switched off" : "On"}</span></td>
                <td><div className="row-actions"><button type="button" className="ghost small-btn" onClick={() => toggle(u)}>{u.disabled ? "Switch on" : "Switch off"}</button>
                  <button type="button" className="ghost small-btn" onClick={() => reset(u)}>Reset password</button></div></td></tr>))}</tbody></table></div>
        )}
      </div>
      {d && <Pager view={serverView({ page: d.page, total: d.total, size: d.per_page })} size={d.per_page} onPage={setPage} onSize={(x) => { setSize(x); setPage(1); }} />}
      {fresh && <TempPassword who={fresh} onClose={() => setFresh(null)} />}
      {confirmNode}
    </section>
  );
}

/** Shown once. Give it to the person over a channel you trust; it is not stored anywhere readable. */
export function TempPassword({ who, onClose }) {
  const toast = useToast();
  return (
    <Modal title="Temporary password" onClose={onClose}>
      <p className="sub">For <b>{who.name}</b> ({who.email}). Give it to them now; this window is the only place it is ever shown.</p>
      <code className="temp-pass">{who.temporary_password}</code>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ghost" onClick={() => navigator.clipboard.writeText(who.temporary_password).then(() => toast("Copied."), () => toast("Could not copy; select it instead.", true))}>Copy</button>
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
