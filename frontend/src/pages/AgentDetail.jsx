import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { del, get, patch, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { Icon, Menu, Spinner, useConfirm, useToast } from "../ui.jsx";

const TOOL_LABELS = {
  end_call: "End the call", capture_lead: "Save details", transfer_to_human: "Transfer to a person", call_webhook: "Your system (webhook)",
};

export default function AgentDetail() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [agent, setAgent] = useState(null);
  const [prompts, setPrompts] = useState([]);
  const [tools, setTools] = useState([]);
  const [limits, setLimits] = useState({ max_minutes: 30, ring_secs: [15, 60] });
  const [tab, setTab] = useState("prompt");

  const load = useCallback(async () => {
    try {
      const [a, p, t, cfg] = await Promise.all([get(`/api/agents/${agentId}`), get("/api/prompts"), get("/api/tools"), get("/api/config")]);
      setAgent(a); setPrompts(p.filter((x) => x.agent_id === a.id)); setTools(t); setLimits(cfg.limits);
    } catch (e) { toast(e.message, true); navigate("/agents"); }
  }, [agentId, navigate, toast]);
  useEffect(() => { load(); }, [load]);
  if (!agent) return <Spinner />;

  const removeAgent = async () => {
    if (!(await confirm({ title: `Delete ${agent.name}?`, text: "Its prompts are kept on the Prompts page. Numbers it answered go back to the default persona.", ok: "Delete agent" }))) return;
    await del(`/api/agents/${agent.id}`); toast("Agent deleted."); navigate("/agents");
  };

  return (
    <section>
      <button type="button" className="link" style={{ display: "inline-flex", gap: 4, marginBottom: 8 }} onClick={() => navigate("/agents")}><Icon name="back" />All agents</button>
      <header className="page" style={{ marginTop: 8 }}>
        <div style={{ minWidth: 0 }}><h1>{agent.name}</h1><div className="sub">{agent.description || "No description yet."}</div></div>
        <div className="head-actions">
          {isAdmin(me) && <Menu items={[["Delete agent", removeAgent, true]]} />}
        </div>
      </header>
      <div className="seg">
        {["prompt", "tools", "settings"].map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "prompt" ? "Prompt" : t === "tools" ? "Tools" : "Call settings"}</button>)}
      </div>
      {tab === "prompt" && <PromptTab agent={agent} prompts={prompts} onChanged={load} />}
      {tab === "tools" && <ToolsTab agent={agent} tools={tools} onChanged={load} />}
      {tab === "settings" && <SettingsTab agent={agent} limits={limits} onChanged={load} />}
      {confirmNode}
    </section>
  );
}

function PromptTab({ agent, prompts, onChanged }) {
  const toast = useToast();
  const active = prompts.find((p) => p.id === agent.active_prompt_id) || prompts[0];
  const [sel, setSel] = useState(active?.id);
  const current = prompts.find((p) => p.id === sel) || active;
  const [name, setName] = useState(current?.name || "");
  const [text, setText] = useState(current?.prompt || "");
  useEffect(() => { setName(current?.name || ""); setText(current?.prompt || ""); }, [sel]);
  if (!current) return <div className="card">This agent has no prompt.</div>;

  const save = async () => {
    try { await patch(`/api/prompts/${current.id}`, { name, text }); toast("Saved. The next call uses it."); onChanged(); } catch (e) { toast(e.message, true); }
  };
  const use = async () => { try { await patch(`/api/agents/${agent.id}`, { active_prompt_id: current.id }); toast("Calls now use this prompt."); onChanged(); } catch (e) { toast(e.message, true); } };
  const addPrompt = async () => {
    const r = prompt("Name the new prompt:"); if (!r) return;
    try { const p = await post("/api/prompts", { name: r, prompt: "You are…", agent_id: agent.id }); toast("Prompt created."); setSel(p.id); onChanged(); } catch (e) { toast(e.message, true); }
  };
  return (
    <div className="grid-side">
      <div className="card">
        <div className="chips">
          {prompts.map((p) => <button key={p.id} className={`chip${p.id === sel ? " on" : ""}`} onClick={() => setSel(p.id)}>{p.name}{p.id === agent.active_prompt_id ? " · in use" : ""}</button>)}
          <button className="chip" onClick={addPrompt}><Icon name="plus" />New prompt</button>
        </div>
        <div className="field"><label className="f">Prompt name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label className="f">Prompt</label><textarea value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="actions"><button className="primary" onClick={save}>Save prompt</button>{current.id !== agent.active_prompt_id && <button className="ghost" onClick={use}>Use on calls</button>}</div>
      </div>
      <div className="card"><div className="card-head"><span className="card-title">How it works</span></div>
        <p className="hint">Calls use the prompt marked <b>in use</b>, read when each call starts, so a save applies from the next call. Every save is kept as a version.</p>
      </div>
    </div>
  );
}

function ToolsTab({ agent, tools, onChanged }) {
  const toast = useToast();
  const [picked, setPicked] = useState(agent.tools);
  const toggle = (name) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  const save = async () => { try { await patch(`/api/agents/${agent.id}`, { tools: picked }); toast("Tools saved. The next call uses them."); onChanged(); } catch (e) { toast(e.message, true); } };
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="card-head"><span className="card-title">What this agent can do on a call</span></div>
      {tools.map((t) => (
        <div key={t.name} className="toggle-line">
          <div><b>{t.label || TOOL_LABELS[t.name]}</b><div className="hint">{t.description}</div>{!t.ready && <div className="hint" style={{ color: "var(--warn)" }}>Needs {t.needs} set up on the server first.</div>}</div>
          <label className="switch"><input type="checkbox" checked={picked.includes(t.name)} onChange={() => toggle(t.name)} /><span /></label>
        </div>
      ))}
      <div className="actions"><button className="primary" onClick={save}>Save tools</button></div>
    </div>
  );
}

function SettingsTab({ agent, limits, onChanged }) {
  const toast = useToast();
  const s = agent.settings;
  const [opening, setOpening] = useState(s.opening_line || "");
  const [maxMin, setMaxMin] = useState(s.max_minutes);
  const [ring, setRing] = useState(s.ring_secs);
  const w = s.call_window || { enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" };
  const [cw, setCw] = useState(w);
  const save = async () => {
    try {
      await patch(`/api/agents/${agent.id}`, { settings: { opening_line: opening, max_minutes: maxMin, ring_secs: ring, call_window: cw } });
      toast("Settings saved. The next call uses them."); onChanged();
    } catch (e) { toast(e.message, true); }
  };
  return (
    <div className="grid-side">
      <div className="card">
        <div className="field"><label className="f">Opening line</label><input value={opening} onChange={(e) => setOpening(e.target.value)} maxLength={200} placeholder="Leave empty to let the agent introduce itself" /></div>
        <div className="field"><label className="f">Longest call (minutes)</label><input type="number" value={maxMin} min={1} max={limits.max_minutes} onChange={(e) => setMaxMin(e.target.value)} /><span className="hint">Up to {limits.max_minutes} minutes on this server.</span></div>
        <div className="field"><label className="f">Ring for (seconds)</label><input type="number" value={ring} min={limits.ring_secs[0]} max={limits.ring_secs[1]} onChange={(e) => setRing(e.target.value)} /></div>
        <div className="actions"><button className="primary" onClick={save}>Save settings</button></div>
      </div>
      <div className="card">
        <div className="card-head"><span className="card-title">Calling window</span><label className="switch"><input type="checkbox" checked={cw.enabled} onChange={(e) => setCw({ ...cw, enabled: e.target.checked })} /><span /></label></div>
        <p className="hint" style={{ marginBottom: "var(--s4)" }}>When on, this agent places calls only between these hours. A call outside the window is refused with a message, so no one is dialled at the wrong time. TRAI allows commercial calls 09:00–21:00.</p>
        <div className="grid-2">
          <div className="field"><label className="f">From</label><input type="time" value={cw.start} disabled={!cw.enabled} onChange={(e) => setCw({ ...cw, start: e.target.value })} /></div>
          <div className="field"><label className="f">To</label><input type="time" value={cw.end} disabled={!cw.enabled} onChange={(e) => setCw({ ...cw, end: e.target.value })} /></div>
        </div>
        <div className="field"><label className="f">Time zone</label><input value={cw.timezone} disabled={!cw.enabled} onChange={(e) => setCw({ ...cw, timezone: e.target.value })} placeholder="Asia/Kolkata" /></div>
        <div className="actions"><button className="primary" onClick={save}>Save calling window</button></div>
      </div>
    </div>
  );
}
