import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { del, get, patch, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { Icon, Menu, Modal, Spinner, useConfirm, useToast, whenShort } from "../ui.jsx";

export default function Prompts() {
  const me = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, confirmNode] = useConfirm();
  const [prompts, setPrompts] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => get("/api/prompts").then(setPrompts).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []);
  if (!prompts) return <Spinner />;

  const remove = async (p) => {
    if (!(await confirm({ title: `Delete ${p.name}?`, text: "It and its versions are removed.", ok: "Delete" }))) return;
    await del(`/api/prompts/${p.id}`); toast("Prompt deleted."); load();
  };
  return (
    <section>
      <header className="page">
        <div><h1>Prompts</h1><div className="sub">Every prompt in your organization and the agent it belongs to.</div></div>
        <div className="head-actions"><button className="primary" onClick={() => setEditing({})}><Icon name="plus" />New prompt</button></div>
      </header>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr) 80px 110px 56px" }}><span>Prompt</span><span>Agent</span><span>Versions</span><span>Last edited</span><span /></div>
        {prompts.length === 0 && <div className="empty">No prompts yet.</div>}
        {prompts.map((p) => (
          <div key={p.id} className="row" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr) 80px 110px 56px" }}>
            <div style={{ minWidth: 0 }}>
              <button type="button" className="link ellip" onClick={() => (p.agent_id ? navigate(`/agents/${p.agent_id}`) : setEditing(p))}>{p.name}</button>
              <div className="muted ellip">{p.prompt.split("\n")[0]}</div>
            </div>
            <div className="ellip">{p.agent_name || <span className="muted">Not assigned</span>}</div>
            <span className="num">{p.version_count}</span>
            <span className="muted">{whenShort(p.updated_at)}</span>
            <div className="row-actions"><Menu items={[["Edit", () => setEditing(p)], isAdmin(me) && ["Delete", () => remove(p), true]]} /></div>
          </div>
        ))}
      </div>
      {editing && <EditPrompt prompt={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {confirmNode}
    </section>
  );
}

function EditPrompt({ prompt, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !prompt.id;
  const [name, setName] = useState(prompt.name || "");
  const [text, setText] = useState(prompt.prompt || "");
  const save = async () => {
    try {
      if (isNew) await post("/api/prompts", { name, prompt: text });
      else await patch(`/api/prompts/${prompt.id}`, { name, text });
      toast("Prompt saved."); onSaved();
    } catch (e) { toast(e.message, true); }
  };
  return (
    <Modal title={isNew ? "New prompt" : "Edit prompt"} onClose={onClose} wide>
      <div className="field"><label className="f">Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="EMI reminder, Hindi" /></div>
      <div className="field"><label className="f">Prompt</label><textarea value={text} onChange={(e) => setText(e.target.value)} /></div>
      <div className="actions" style={{ justifyContent: "flex-end" }}><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save prompt</button></div>
    </Modal>
  );
}
