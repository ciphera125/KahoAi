import { useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { Icon, Menu, Modal, Spinner, useConfirm, useToast } from "../ui.jsx";

const STATUS = { active: ["Active", "active"], incomplete: ["Needs credentials", "warn"], not_connected: ["Not connected yet", "muted"] };

export default function Numbers() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [numbers, setNumbers] = useState(null);
  const [agents, setAgents] = useState([]);
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null); // { provider, existing? }
  const admin = isAdmin(me);
  const load = () => Promise.all([get("/api/numbers"), get("/api/agents"), get("/api/providers")]).then(([n, a, p]) => { setNumbers(n); setAgents(a); setProviders(p); }).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []);
  if (!numbers) return <Spinner />;

  const route = async (n, agentId) => { try { await post(`/api/numbers/${n.id}/agent`, { agent_id: agentId || null }); toast("Saved. The next call to this number uses it."); load(); } catch (e) { toast(e.message, true); } };
  const remove = async (n) => { if (!(await confirm({ title: `Delete ${n.number}?`, text: "The number and its saved credentials are removed from the Studio.", ok: "Delete" }))) return; await del(`/api/numbers/${n.id}`); toast("Number deleted."); load(); };

  return (
    <section>
      <header className="page">
        <div><h1>Numbers</h1><div className="sub">The numbers your agents call from and answer on, and which agent answers each one.</div></div>
        {admin && <div className="head-actions"><Menu items={providers.map((p) => [`${p.label}${p.connected ? "" : " (save only)"}`, () => setEditing({ provider: p })])} />
          <button className="primary" onClick={() => setEditing({ provider: providers.find((p) => p.id === "plivo") })}><Icon name="plus" />Add Plivo number</button></div>}
      </header>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) 150px 56px" }}><span>Number</span><span>Answers with</span><span>Status</span><span /></div>
        {numbers.length === 0 && <div className="empty">No numbers yet.</div>}
        {numbers.map((n) => {
          const [label, cls] = STATUS[n.status];
          return (
            <div key={n.id} className="row" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) 150px 56px" }}>
              <div style={{ minWidth: 0 }}><div className="num">{n.number}{n.is_default && <span className="muted"> · default</span>}</div><div className="muted ellip">{[n.provider_label, n.label].filter(Boolean).join(" · ")}</div></div>
              <select value={n.agent_id || ""} disabled={!admin} onChange={(e) => route(n, e.target.value)}>
                <option value="">Default persona</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <span className={`pill ${cls}`}>{label}</span>
              <div className="row-actions">{admin && <Menu items={[["Edit", () => setEditing({ provider: providers.find((p) => p.id === n.provider), existing: n })], !n.is_default && ["Set as default", async () => { await post(`/api/numbers/${n.id}/default`); toast("Default updated."); load(); }], ["Delete", () => remove(n), true]]} />}</div>
            </div>
          );
        })}
      </div>
      {editing && <EditNumber {...editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {confirmNode}
    </section>
  );
}

function EditNumber({ provider, existing, onClose, onSaved }) {
  const toast = useToast();
  const [number, setNumber] = useState(existing?.number || "");
  const [label, setLabel] = useState(existing?.label || "");
  const [creds, setCreds] = useState({});
  const save = async () => {
    try {
      const credentials = {};
      for (const fld of provider.fields) credentials[fld.name] = creds[fld.name] || "";
      if (existing) await patch(`/api/numbers/${existing.id}`, { label, credentials });
      else await post("/api/numbers", { provider: provider.id, number, label, credentials });
      toast(existing ? "Number updated." : "Number added."); onSaved();
    } catch (e) { toast(e.message, true); }
  };
  return (
    <Modal title={existing ? `Edit ${existing.number}` : `Connect a ${provider.label} number`} onClose={onClose}>
      {!provider.connected && <p className="hint" style={{ marginBottom: "var(--s4)" }}>{provider.label} numbers can be saved now; calls through {provider.label} are not built yet.</p>}
      <div className="field"><label className="f">Phone number</label><input type="tel" value={number} disabled={!!existing} onChange={(e) => setNumber(e.target.value)} placeholder="+91 80655 20552" /></div>
      <div className="field"><label className="f">Name</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main line" /></div>
      {provider.fields.map((fld) => (
        <div className="field" key={fld.name}><label className="f">{fld.label}</label>
          <input type={fld.secret ? "password" : "text"} value={creds[fld.name] || ""} onChange={(e) => setCreds((c) => ({ ...c, [fld.name]: e.target.value }))}
            placeholder={existing && fld.secret ? (existing.credentials[fld.name] ? `Saved (${existing.credentials[fld.name]}). Leave blank to keep.` : "Not set") : existing && !fld.secret ? existing.credentials[fld.name] : ""} />
        </div>
      ))}
      <div className="actions" style={{ justifyContent: "flex-end" }}><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save number</button></div>
    </Modal>
  );
}
