import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api.js";
import { Icon, Modal, plural, Spinner, useToast } from "../ui.jsx";

export default function Agents() {
  const toast = useToast();
  const navigate = useNavigate();
  const [agents, setAgents] = useState(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { get("/api/agents").then(setAgents).catch((e) => toast(e.message, true)); }, []);
  if (!agents) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Agents</h1><div className="sub">Each agent has its own prompts, tools and call settings. Make one per job, like EMI reminders.</div></div>
        <div className="head-actions"><button className="primary" onClick={() => setCreating(true)}><Icon name="plus" />New agent</button></div>
      </header>
      {agents.length === 0 ? (
        <div className="card empty">No agents yet. Create one for each kind of call you make.</div>
      ) : (
        <div className="agent-grid">
          {agents.map((a) => (
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
      {creating && <NewAgent onClose={() => setCreating(false)} onCreated={(a) => navigate(`/agents/${a.id}`)} />}
    </section>
  );
}

function NewAgent({ onClose, onCreated }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", description: "", prompt: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const create = async () => {
    setBusy(true);
    try { const a = await post("/api/agents", f); toast("Agent created."); onCreated(a); } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title="New agent" onClose={onClose} wide>
      <div className="field"><label className="f">Name</label><input value={f.name} onChange={set("name")} placeholder="EMI reminder" /></div>
      <div className="field"><label className="f">Description</label><input value={f.description} onChange={set("description")} placeholder="Reminds borrowers a day before their EMI is due" /></div>
      <div className="field"><label className="f">Prompt</label><textarea value={f.prompt} onChange={set("prompt")} placeholder="You are Riya from Acme Finance, calling to remind the person their EMI is due on…" /></div>
      <div className="actions" style={{ justifyContent: "flex-end" }}><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={create} disabled={busy}>Create agent</button></div>
    </Modal>
  );
}
