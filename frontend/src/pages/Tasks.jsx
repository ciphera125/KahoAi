import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { dayWord } from "../time.js";
import { Icon, Modal, Spinner, usePaged, useConfirm, useToast } from "../ui.jsx";

const RANGES = [["all", "All"], ["today", "Today"], ["yesterday", "Yesterday"],
  ["this_week", "This week"], ["overdue", "Overdue"]];
const STATUSES = [["pending", "Still to do"], ["done", "Finished"], ["all", "Both"]];
const SOURCES = { studio: "Added here", api: "From your system", call: "Added on a call", csv: "From a file" };

/** The value an <input type="datetime-local"> wants, in India's day. */
function forInput(iso) {
  if (!iso) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso))
    .reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}
/** What the person typed, read as India's clock. */
const fromInput = (value) => (value ? new Date(`${value}:00+05:30`).toISOString() : null);

export default function Tasks() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [data, setData] = useState(null);
  const [range, setRange] = useState("all");
  const [status, setStatus] = useState("pending");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try { setData(await get(`/api/tasks?range=${range}&status=${status}`)); }
    catch (e) { toast(e.message, true); }
  }, [range, status, toast]);
  useEffect(() => { load(); }, [load]);
  const [shown, pager] = usePaged(data?.items ?? []);

  const setDone = async (task, done) => {
    try { await patch(`/api/tasks/${task.id}`, { status: done ? "done" : "pending" }); load(); }
    catch (e) { toast(e.message, true); }
  };
  const remove = async (task) => {
    if (!(await confirm({ title: `Delete “${task.title}”?`, text: "This cannot be undone.", ok: "Delete" }))) return;
    try { await del(`/api/tasks/${task.id}`); toast("Deleted."); load(); } catch (e) { toast(e.message, true); }
  };

  return (
    <section>
      <header className="page">
        <div><h1>Tasks</h1>
          <div className="sub">Things your agent can remind people about, like “Pay the November EMI”.</div></div>
        <div className="head-actions"><button className="primary" onClick={() => setAdding(true)}><Icon name="plus" />Add a task</button></div>
      </header>

      <div className="card explain">
        <b>What are tasks for?</b>
        <p className="hint">A task is one thing a person has to do, with a date. During a call your agent can read a person's
          tasks out to them, add a new one, move the date or tick one off, if you turn those tools on for the agent
          (Agents, then Tools). Tasks belong to a person, so an agent only ever sees the tasks of the person it is talking to.
          You can type them here, or your own system can send them in.</p>
      </div>

      <div className="seg" style={{ marginBottom: "var(--s3)" }}>
        {RANGES.map(([v, l]) => <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>{l}</button>)}
      </div>
      <div className="seg" style={{ marginBottom: "var(--s4)" }}>
        {STATUSES.map(([v, l]) => <button key={v} className={status === v ? "on" : ""} onClick={() => setStatus(v)}>{l}</button>)}
      </div>

      {!data && <Spinner />}
      {data && data.items.length === 0 && <div className="card"><p className="hint">
        No tasks here. Press “Add a task” to make the first one.</p></div>}
      {data && data.items.length > 0 && (
        <div className="card">
          <table className="rows">
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td style={{ width: 28 }}>
                    <input type="checkbox" aria-label={`Mark ${t.title} done`} checked={t.status === "done"}
                      onChange={(e) => setDone(t, e.target.checked)} />
                  </td>
                  <td>
                    <div style={{ textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</div>
                    <div className="hint">{[t.due_at ? `Due ${dayWord(t.due_at)}` : "No date", t.contact_name, SOURCES[t.source]].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="ghost" onClick={() => setEditing(t)}>Edit</button>
                    <button className="ghost" onClick={() => remove(t)} aria-label={`Delete ${t.title}`}><Icon name="trash" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pager}
      {(adding || editing) && <TaskForm task={editing} onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }} />}
      {confirmNode}
    </section>
  );
}

/** Adding or editing one task. The person is found by typing a name or number: a list of
 * every contact would be long, and one that stops at 100 would quietly leave people out. */
function TaskForm({ task, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [due, setDue] = useState(forInput(task?.due_at));
  const [person, setPerson] = useState(task?.contact_id ? { id: task.contact_id, name: task.contact_name } : null);
  const [find, setFind] = useState("");
  const [matches, setMatches] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (find.trim().length < 2) { setMatches([]); return undefined; }
    const t = setTimeout(() => {
      get(`/api/contacts?per_page=8&q=${encodeURIComponent(find.trim())}`)
        .then((d) => setMatches(Array.isArray(d?.contacts) ? d.contacts : []))
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(t);
  }, [find]);

  const save = async () => {
    setBusy(true);
    try {
      const body = { title, due_at: fromInput(due), contact_id: person?.id ?? null };
      if (isNew) await post("/api/tasks", body); else await patch(`/api/tasks/${task.id}`, body);
      toast(isNew ? "Task added." : "Saved."); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? "Add a task" : "Edit task"} onClose={onClose}>
      <div className="field"><label className="f">What has to be done?</label>
        <input value={title} maxLength={200} placeholder="Pay the November EMI" autoFocus onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label className="f">When is it due? (India time)</label>
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></div>
      <div className="field"><label className="f">Whose task is it? (optional)</label>
        {person ? (
          <div className="chips"><span className="chip on">{person.name}
            <button type="button" className="link" onClick={() => setPerson(null)} aria-label="Pick someone else"> change</button></span></div>
        ) : (
          <>
            <input value={find} placeholder="Type a name or number" onChange={(e) => setFind(e.target.value)} />
            {matches.length > 0 && (
              <div className="picker-list" style={{ border: "1px solid var(--border)", borderRadius: "var(--r-md)", marginTop: 4 }}>
                {matches.map((c) => (
                  <button key={c.id} type="button" className="picker-item"
                    onClick={() => { setPerson({ id: c.id, name: c.name }); setFind(""); setMatches([]); }}>
                    <b>{c.name}</b><span className="hint">{c.numbers?.[0]?.number ?? ""}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <span className="hint">The agent only reads out a task to the person it belongs to. Leave this empty for a general one.</span></div>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy || !title.trim()}>{isNew ? "Add task" : "Save"}</button>
      </div>
    </Modal>
  );
}
