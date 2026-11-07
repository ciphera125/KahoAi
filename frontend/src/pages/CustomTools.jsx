import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { Icon, Spinner, useConfirm, useToast } from "../ui.jsx";

const TYPES = [["text", "Words"], ["number", "A number"], ["yes_no", "Yes or no"]];
const METHODS = ["POST", "GET", "PUT", "PATCH"];

const BLANK = {
  label: "", description: "", method: "POST", url: "", headers: {}, body_template: "{}",
  inputs: [], say_while_waiting: "", timeout_ms: 6000, extract: {},
};

/** Tools a customer defines themselves, each one a call to their own API. */
export default function CustomTools() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [tools, setTools] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => get("/api/custom-tools").then(setTools).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); }, [load]);

  const remove = async (tool) => {
    if (!(await confirm({ title: `Delete ${tool.label}?`,
      text: "Any agent using it stops being able to. This cannot be undone.", ok: "Delete tool" }))) return;
    try { await del(`/api/custom-tools/${tool.id}`); toast("Deleted."); load(); } catch (e) { toast(e.message, true); }
  };

  return (
    <section>
      <header className="page">
        <div><h1>Your own tools</h1>
          <div className="sub">Let an agent call your system during a call: check an order, look up a balance.</div></div>
        {isAdmin(me) && <div className="head-actions">
          <button className="primary" onClick={() => setEditing(BLANK)}><Icon name="plus" />New tool</button></div>}
      </header>

      {!tools && <Spinner />}
      {tools?.length === 0 && !editing && <div className="card"><p className="hint">
        No tools yet. A tool is one request to an address you choose, with whatever the agent collects from the caller.
      </p></div>}

      {tools?.map((t) => (
        <div key={t.id} className="card" style={{ marginBottom: "var(--s3)" }}>
          <div className="publish-state">
            <div>
              <b>{t.label}</b> <code className="hint">{t.name}</code>
              <div className="hint">{t.description || "No note about when to use it."}</div>
              <div className="hint">{t.method} · {t.inputs.length} thing{t.inputs.length === 1 ? "" : "s"} to collect
                {t.last_test_at && <> · last test {t.last_test_ok ? "worked" : "failed"}: {t.last_test_note}</>}
                {!t.last_test_at && <> · never tested</>}
              </div>
            </div>
            {isAdmin(me) && <div style={{ display: "flex", gap: 8 }}>
              <button className="ghost" onClick={() => setEditing(t)}>Edit</button>
              <button className="ghost" onClick={() => remove(t)}>Delete</button>
            </div>}
          </div>
        </div>
      ))}

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
    if (isNew) { toast("Save it first, then test it.", true); return; }
    setBusy(true);
    try { setResult(await post(`/api/custom-tools/${tool.id}/test`, {})); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const setInput = (i, patchIn) => set({ inputs: form.inputs.map((x, j) => (j === i ? { ...x, ...patchIn } : x)) });

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <div className="card-head"><span className="card-title">{isNew ? "New tool" : form.label}</span></div>

      <div className="field"><label className="f">What is it called?</label>
        <input value={form.label} maxLength={60} placeholder="Check order status" onChange={(e) => set({ label: e.target.value })} />
        <span className="hint">The agent sees this. {!isNew && <>Its short name stays <code>{tool.name}</code>.</>}</span></div>

      <div className="field"><label className="f">When should the agent use it?</label>
        <textarea rows={2} value={form.description} maxLength={400}
          placeholder="Use when the caller asks where their order is."
          onChange={(e) => set({ description: e.target.value })} />
        <span className="hint">This is what the agent reads to decide. Be plain and specific.</span></div>

      <div className="grid-2">
        <div className="field"><label className="f">Method</label>
          <select value={form.method} onChange={(e) => set({ method: e.target.value })}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select></div>
        <div className="field"><label className="f">Give up after (seconds)</label>
          <input type="number" min={1} max={15} value={Math.round(form.timeout_ms / 1000)}
            onChange={(e) => set({ timeout_ms: Number(e.target.value) * 1000 })} /></div>
      </div>

      <div className="field"><label className="f">Address</label>
        <input value={form.url} placeholder="https://api.yourcompany.com/orders" onChange={(e) => set({ url: e.target.value })} />
        <span className="hint">Must start with https. We will not call an address on a private network.</span></div>

      <div className="field"><label className="f">Headers</label>
        {headerRows.map((row, i) => (
          <div key={i} className="q-row" style={{ gridTemplateColumns: "1fr 1.4fr auto" }}>
            <input placeholder="Authorization" value={row.name}
              onChange={(e) => setHeaderRows((rs) => rs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
            <input type="password" placeholder={row.kept ? "Saved — type to replace" : "Bearer …"} value={row.value}
              onChange={(e) => setHeaderRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value, kept: false } : r)))} />
            <button className="ghost" onClick={() => setHeaderRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="trash" /></button>
          </div>
        ))}
        <button className="ghost" onClick={() => setHeaderRows((rs) => [...rs, { name: "", value: "", kept: false }])}>
          <Icon name="plus" />Add a header</button>
        <span className="hint">Keys are encrypted and never shown again, never logged, and never given to the agent.</span></div>

      <div className="field"><label className="f">What should the agent collect from the caller?</label>
        {form.inputs.map((input, i) => (
          <div key={i} className="q-row">
            <input placeholder="Order number" value={input.label || ""} onChange={(e) => setInput(i, { label: e.target.value })} />
            <select value={input.type || "text"} onChange={(e) => setInput(i, { type: e.target.value })}>
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="switch-inline"><input type="checkbox" checked={!!input.required}
              onChange={(e) => setInput(i, { required: e.target.checked })} /> Must have</label>
            <button className="ghost" onClick={() => set({ inputs: form.inputs.filter((_, j) => j !== i) })}><Icon name="trash" /></button>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <input placeholder="An example, like A1" value={input.example || ""} onChange={(e) => setInput(i, { example: e.target.value })} />
            </div>
          </div>
        ))}
        <button className="ghost" onClick={() => set({ inputs: [...form.inputs, { label: "", type: "text", required: false, example: "" }] })}>
          <Icon name="plus" />Add something to collect</button></div>

      {form.method !== "GET" && (
        <div className="field"><label className="f">What to send</label>
          <textarea rows={3} value={form.body_template} spellCheck={false}
            onChange={(e) => set({ body_template: e.target.value })} />
          <span className="hint">Write <code>{"{{input.order_number}}"}</code> where the collected value should go, inside your own quotes.</span></div>
      )}

      <div className="field"><label className="f">Keep from the answer</label>
        {extractRows.map((row, i) => (
          <div key={i} className="q-row" style={{ gridTemplateColumns: "1fr 1.4fr auto" }}>
            <input placeholder="order_status" value={row.name}
              onChange={(e) => setExtractRows((rs) => rs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
            <input placeholder="$.status" value={row.path}
              onChange={(e) => setExtractRows((rs) => rs.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))} />
            <button className="ghost" onClick={() => setExtractRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="trash" /></button>
          </div>
        ))}
        <button className="ghost" onClick={() => setExtractRows((rs) => [...rs, { name: "", path: "" }])}>
          <Icon name="plus" />Keep a value</button>
        <span className="hint">The agent is told these, and nothing else from the answer.</span></div>

      <div className="field"><label className="f">Say this while waiting</label>
        <input value={form.say_while_waiting} maxLength={120} placeholder="One moment, let me check."
          onChange={(e) => set({ say_while_waiting: e.target.value })} />
        <span className="hint">So the caller does not sit in silence while your system answers.</span></div>

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

      <div className="actions">
        <button className="primary" onClick={save} disabled={busy}>{busy ? "Working…" : "Save tool"}</button>
        <button className="ghost" onClick={runTest} disabled={busy || isNew}>Test this tool</button>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
