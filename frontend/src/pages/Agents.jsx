import { can, useMe } from "../auth.jsx";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api.js";
import { Icon, Modal, plural, Spinner, usePaged, useToast } from "../ui.jsx";

export default function Agents() {
  const toast = useToast();
  const me = useMe();
  const navigate = useNavigate();
  const [agents, setAgents] = useState(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { get("/api/agents").then(setAgents).catch((e) => toast(e.message, true)); }, []);
  const [shown, pager] = usePaged(agents ?? [], 10);
  if (!agents) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Agents</h1><div className="sub">Each agent has its own prompts, tools and call settings. Make one per job, like EMI reminders.</div></div>
        {can(me, "agents.edit") && <div className="head-actions"><button className="primary" onClick={() => setCreating(true)}><Icon name="plus" />New agent</button></div>}
      </header>
      {agents.length === 0 ? (
        <div className="card empty">No agents yet. Create one for each kind of call you make.</div>
      ) : (
        <div className="agent-grid">
          {shown.map((a) => (
            <div key={a.id} className="card agent-card" role="button" tabIndex={0} onClick={() => navigate(`/agents/${a.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/agents/${a.id}`)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="avatar"><Icon name="agent" /></div>
                {a.numbers.length > 0 && <span className="pill active">Answers {a.numbers.length > 1 ? plural(a.numbers.length, "number") : a.numbers[0]}</span>}
                {a.settings?.call_window?.enabled && <span className="pill"><Icon name="clock" />{a.settings.call_window.start}–{a.settings.call_window.end}</span>}
              </div>
              <h3 style={{ margin: "4px 0 0", fontSize: 15 }}>{a.name}</h3>
              <div className="muted" style={{ minHeight: 36 }}>{a.description || "No description yet."}</div>
              <div className="muted" style={{ display: "flex", gap: 16, marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--border)", fontFamily: "var(--mono)" }}>
                <span>{plural(a.prompt_ids.length, "prompt")}</span><span>{plural(a.tools.length, "tool")}</span><span>{plural(a.call_count || 0, "call")}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {pager}
      {creating && <NewAgent onClose={() => setCreating(false)} onCreated={(a) => navigate(`/agents/${a.id}`)} />}
    </section>
  );
}

function NewAgent({ onClose, onCreated }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", description: "", prompt: "" });
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState(null);
  useEffect(() => { get("/api/templates").then(setTemplates).catch(() => {}); }, []);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const create = async () => {
    setBusy(true);
    try { const a = await post("/api/agents", template ? { template: template.id, name: f.name || undefined } : f); toast("Agent created."); onCreated(a); } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title="New agent" onClose={onClose} wide>
      {templates.length > 0 && (
        <div className="field"><label className="f">Start from a ready-made agent</label>
          <div className="templates">
            <button type="button" className={`template${template ? "" : " on"}`} onClick={() => setTemplate(null)}><b>Blank</b><span>Write your own prompt.</span></button>
            {templates.map((t) => (
              <button type="button" key={t.id} className={`template${template?.id === t.id ? " on" : ""}`}
                onClick={() => { setTemplate(t); setF((v) => ({ ...v, name: v.name || t.name })); }}><b>{t.name}</b><span>{t.summary}</span></button>
            ))}
          </div></div>
      )}
      <div className="field"><label className="f">Name</label><input value={f.name} onChange={set("name")} placeholder="EMI reminder" /></div>
      {!template && <div className="field"><label className="f">Description</label><input value={f.description} onChange={set("description")} placeholder="Reminds borrowers a day before their EMI is due" /></div>}
      {!template && <div className="field"><label className="f">Prompt</label><textarea value={f.prompt} onChange={set("prompt")} placeholder="You are Riya from Acme Finance, calling to remind the person their EMI is due on…" /></div>}
      <div className="actions" style={{ justifyContent: "flex-end" }}><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={create} disabled={busy}>Create agent</button></div>
    </Modal>
  );
}
