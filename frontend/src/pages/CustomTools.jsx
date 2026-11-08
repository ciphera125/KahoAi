import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { can, useMe } from "../auth.jsx";
import { dayWord } from "../time.js";
import Assistant, { AssistantButton } from "../components/Assistant.jsx";
import { Icon, Modal, Spinner, usePaged, useConfirm, useToast } from "../ui.jsx";

const TYPES = [["text", "Words"], ["number", "A number"], ["yes_no", "Yes or no"]];
const METHODS = [["POST", "Send information (POST)"], ["GET", "Just ask (GET)"], ["PUT", "Replace (PUT)"], ["PATCH", "Update (PATCH)"]];

const BLANK = {
  label: "", description: "", method: "POST", url: "", headers: {}, body_template: "{}",
  inputs: [], say_while_waiting: "", timeout_ms: 6000, extract: {},
};

/** Your own tools: a way for an agent to ask YOUR system something during a call. */
export default function CustomTools() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [tools, setTools] = useState(null);
  const [editing, setEditing] = useState(null);
  const [chatting, setChatting] = useState(false);

  const load = useCallback(() => get("/api/custom-tools").then(setTools).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); }, [load]);
  const [shown, pager] = usePaged(tools ?? []);

  const remove = async (tool) => {
    if (!(await confirm({ title: `Delete ${tool.label}?`,
      text: "Any agent using it stops being able to. This cannot be undone.", ok: "Delete tool" }))) return;
    try { await del(`/api/custom-tools/${tool.id}`); toast("Deleted."); load(); } catch (e) { toast(e.message, true); }
  };

  return (
    <section>
      <header className="page">
        <div><h1>Your own tools</h1>
          <div className="sub">Let an agent ask your own system something during a call, like “where is my order?”.</div></div>
        {can(me, "tools.custom") && <div className="head-actions">
          <AssistantButton onClick={() => setChatting(true)} />
          <button className="primary" onClick={() => setEditing(BLANK)}><Icon name="plus" />New tool</button></div>}
      </header>

      <div className="card explain">
        <b>Tools and your own tools: what is the difference?</b>
        <ul className="plain">
          <li><b>Tools</b> are what Kaho AI gives every agent: ending the call, saving details, reading tasks, and so on.
            You switch them on for an agent under <i>Agents, then Tools</i>.</li>
          <li><b>Your own tools</b> are ones you make here. Each one sends a question to your own system and tells the agent the answer.
            Once it is made, switch it on for an agent in the same place.</li>
          <li>To have the agent write down something the caller says (a payment date, an order number),
            you do not need a tool: use <i>Questions to save</i> on the agent.</li>
        </ul>
      </div>

      {!tools && <Spinner />}
      {tools?.length === 0 && <div className="card"><p className="hint">
        No tools yet. Press “New tool” and describe what the agent should be able to ask.</p></div>}

      {tools?.length > 0 && (
        <div className="card list">
          <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.6fr) 150px 150px" }}>
            <span>Tool</span><span>When the agent uses it</span><span>Last test</span><span />
          </div>
          {shown.map((t) => (
            <div key={t.id} className="row" style={{ gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.6fr) 150px 150px" }}>
              <div style={{ minWidth: 0 }}><b className="ellip">{t.label}</b>{t.made_by === "builder" && <span className="made-by" title="Set up for you by Kaho Builder"><Icon name="spark" />Kaho Builder</span>}
                <div className="muted ellip">{t.inputs.length ? `Collects: ${t.inputs.map((i) => i.label).join(", ")}` : "Collects nothing"}</div></div>
              <span className="ellip muted" title={t.description}>{t.description || "No note yet"}</span>
              <span>{t.last_test_at
                ? <span className={`pill ${t.last_test_ok ? "live" : "muted"}`} title={t.last_test_note}>{t.last_test_ok ? "Worked" : "Failed"} · {dayWord(t.last_test_at)}</span>
                : <span className="muted">Not tested</span>}</span>
              <span className="row-buttons">{can(me, "tools.custom") && <>
                <button className="ghost" onClick={() => setEditing(t)}>Edit</button>
                <button className="ghost" onClick={() => remove(t)} aria-label={`Delete ${t.label}`}><Icon name="trash" /></button></>}</span>
            </div>
          ))}
        </div>
      )}
      {tools?.length > 0 && pager}

      {chatting && <Assistant onClose={() => setChatting(false)} onApplied={() => load()} onShow={() => setChatting(false)} />}
      {editing && <ToolForm tool={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} />}
      {confirmNode}
    </section>
  );
}

function ToolForm({ tool, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !tool.id;
  const [form, setForm] = useState({ ...BLANK, ...tool });
  const [headerRows, setHeaderRows] = useState(
    (tool.header_names ?? []).map((name) => ({ name, value: "", kept: true })));
  const [extractRows, setExtractRows] = useState(Object.entries(tool.extract ?? {}).map(([name, path]) => ({ name, path })));
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patchIn) => setForm((f) => ({ ...f, ...patchIn }));

  const body = () => {
    const headers = {};
    for (const row of headerRows) {
      if (!row.name) continue;
      if (row.kept && !row.value) continue;  // left as it was: do not send it back empty
      headers[row.name] = row.value;
    }
    const sentHeaders = headerRows.some((r) => r.name && (!r.kept || r.value)) || headerRows.length === 0;
    return {
      label: form.label, description: form.description, method: form.method, url: form.url,
      body_template: form.body_template, say_while_waiting: form.say_while_waiting,
      timeout_ms: Number(form.timeout_ms) || 6000,
      inputs: form.inputs,
      extract: Object.fromEntries(extractRows.filter((r) => r.name && r.path).map((r) => [r.name, r.path])),
      ...(isNew || sentHeaders ? { headers } : {}),
    };
  };

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) await post("/api/custom-tools", body());
      else await patch(`/api/custom-tools/${tool.id}`, body());
      toast("Saved."); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const runTest = async () => {
    setBusy(true);
    try { setResult(await post(`/api/custom-tools/${tool.id}/test`, {})); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const setInput = (i, patchIn) => set({ inputs: form.inputs.map((x, j) => (j === i ? { ...x, ...patchIn } : x)) });

  return (
    <Modal title={isNew ? "New tool" : form.label} onClose={onClose} wide>
      <div className="field"><label className="f">What is it called?</label>
        <input value={form.label} maxLength={60} placeholder="Check order status" onChange={(e) => set({ label: e.target.value })} />
        <span className="hint">A short name for you to recognise it by.</span></div>

      <div className="field"><label className="f">When should the agent use it?</label>
        <textarea rows={2} value={form.description} maxLength={400}
          placeholder="Use when the caller asks where their order is."
          onChange={(e) => set({ description: e.target.value })} />
        <span className="hint">The agent reads this to decide when to use the tool, so be plain and specific.</span></div>

      <div className="field"><label className="f">Where should the question go?</label>
        <input value={form.url} placeholder="https://api.yourcompany.com/orders" onChange={(e) => set({ url: e.target.value })} />
        <span className="hint">The web address of your system. It has to start with https.</span></div>

      <div className="field"><label className="f">What should the agent ask the caller for?</label>
        {form.inputs.length === 0 && <span className="hint">Nothing yet. For an order lookup you would add “Order number”.</span>}
        {form.inputs.map((input, i) => (
          <div key={i} className="mini-row">
            <input placeholder="Order number" value={input.label || ""} onChange={(e) => setInput(i, { label: e.target.value })} aria-label="What to ask for" />
            <select value={input.type || "text"} onChange={(e) => setInput(i, { type: e.target.value })} aria-label="Kind of answer">
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="switch-inline"><input type="checkbox" checked={!!input.required}
              onChange={(e) => setInput(i, { required: e.target.checked })} /> Must have</label>
            <button className="ghost" onClick={() => set({ inputs: form.inputs.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="trash" /></button>
          </div>
        ))}
        <button className="ghost" onClick={() => set({ inputs: [...form.inputs, { label: "", type: "text", required: true, example: "" }] })}>
          <Icon name="plus" />Add something to ask for</button>
        <span className="hint">Examples: order number, date of birth, the amount. The agent asks the caller for these and passes them on.</span></div>

      <details className="more">
        <summary>More options (how to send it, passwords, what to keep)</summary>

        <div className="grid-2">
          <div className="field"><label className="f">How to send it</label>
            <select value={form.method} onChange={(e) => set({ method: e.target.value })}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div className="field"><label className="f">Give up after (seconds)</label>
            <input type="number" min={1} max={15} value={Math.round(form.timeout_ms / 1000)}
              onChange={(e) => set({ timeout_ms: Number(e.target.value) * 1000 })} /></div>
        </div>

        <div className="field"><label className="f">Passwords or keys your system needs</label>
          {headerRows.map((row, i) => (
            <div key={i} className="mini-row" style={{ gridTemplateColumns: "1fr 1.4fr auto" }}>
              <input placeholder="Authorization" value={row.name} aria-label="Name"
                onChange={(e) => setHeaderRows((rs) => rs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
              <input type="password" placeholder={row.kept ? "Saved. Type to replace." : "Bearer your-key"} value={row.value} aria-label="Value"
                onChange={(e) => setHeaderRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value, kept: false } : r)))} />
              <button className="ghost" onClick={() => setHeaderRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="trash" /></button>
            </div>
          ))}
          <button className="ghost" onClick={() => setHeaderRows((rs) => [...rs, { name: "", value: "", kept: false }])}>
            <Icon name="plus" />Add one</button>
          <span className="hint">Only needed if your system asks for a key. It is stored encrypted, never shown again, and never given to the agent.</span></div>

        {form.method !== "GET" && (
          <div className="field"><label className="f">What to send</label>
            <textarea rows={3} value={form.body_template} spellCheck={false}
              onChange={(e) => set({ body_template: e.target.value })} />
            <span className="hint">Write <code>{"{{input.order_number}}"}</code> where the caller's answer should go, inside your own quotes.</span></div>
        )}

        <div className="field"><label className="f">Which part of the answer should the agent know?</label>
          {extractRows.map((row, i) => (
            <div key={i} className="mini-row" style={{ gridTemplateColumns: "1fr 1.4fr auto" }}>
              <input placeholder="order_status" value={row.name} aria-label="Name for it"
                onChange={(e) => setExtractRows((rs) => rs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
              <input placeholder="$.status" value={row.path} aria-label="Where it is in the answer"
                onChange={(e) => setExtractRows((rs) => rs.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))} />
              <button className="ghost" onClick={() => setExtractRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="trash" /></button>
            </div>
          ))}
          <button className="ghost" onClick={() => setExtractRows((rs) => [...rs, { name: "", path: "" }])}>
            <Icon name="plus" />Add one</button>
          <span className="hint">Your system answers with a lot of detail. Pick the bits the agent should say, like <code>$.status</code> for the order status. The agent sees only these.</span></div>

        <div className="field"><label className="f">What should the agent say while it waits?</label>
          <input value={form.say_while_waiting} maxLength={120} placeholder="One moment, let me check."
            onChange={(e) => set({ say_while_waiting: e.target.value })} />
          <span className="hint">So the caller does not sit in silence while your system answers.</span></div>
      </details>

      {result && (
        <div className="answers">
          <div className="card-title" style={{ marginBottom: 6 }}>{result.ok ? "It worked" : "It did not work"}</div>
          <div className="answer-line"><span className="muted">Result</span><b>{result.note}</b></div>
          <div className="answer-line"><span className="muted">Sent</span><code>{JSON.stringify(result.sent)}</code></div>
          <div className="answer-line"><span className="muted">Kept</span><code>{JSON.stringify(result.kept)}</code></div>
          <details><summary className="hint">Their full answer</summary>
            <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result.answer, null, 2)}</pre></details>
        </div>
      )}

      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>Close</button>
        <button className="ghost" onClick={runTest} disabled={busy || isNew} title={isNew ? "Save it first, then test it" : ""}>Test this tool</button>
        <button className="primary" onClick={save} disabled={busy || !form.label.trim() || !form.url.trim()}>{busy ? "Working…" : "Save tool"}</button>
      </div>
    </Modal>
  );
}
