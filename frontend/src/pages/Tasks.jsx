import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { Icon, Spinner, useConfirm, useToast } from "../ui.jsx";

const RANGES = [["all", "All"], ["today", "Today"], ["yesterday", "Yesterday"],
  ["this_week", "This week"], ["overdue", "Overdue"]];
const STATUSES = [["pending", "Still to do"], ["done", "Finished"], ["all", "Both"]];
const SOURCES = { studio: "Added here", api: "From your system", call: "Added on a call", csv: "From a file" };

/** A date and time as a person reads it, in India's day. */
const whenDue = (iso) => (iso
  ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })
  : "No date");

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

  const load = useCallback(async () => {
    try { setData(await get(`/api/tasks?range=${range}&status=${status}`)); }
    catch (e) { toast(e.message, true); }
  }, [range, status, toast]);
  useEffect(() => { load(); }, [load]);

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
        <div><h1>Tasks</h1><div className="sub">What your agents remind people about. Add them here, or let your own system push them in.</div></div>
        <div className="head-actions"><button className="primary" onClick={() => setAdding(true)}><Icon name="plus" />Add a task</button></div>
      </header>

      <div className="seg" style={{ marginBottom: "var(--s3)" }}>
        {RANGES.map(([v, l]) => <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>{l}</button>)}
      </div>
      <div className="seg" style={{ marginBottom: "var(--s4)" }}>
        {STATUSES.map(([v, l]) => <button key={v} className={status === v ? "on" : ""} onClick={() => setStatus(v)}>{l}</button>)}
      </div>

      {!data && <Spinner />}
      {data && data.items.length === 0 && <div className="card"><p className="hint">Nothing here yet.</p></div>}
      {data && data.items.length > 0 && (
        <div className="card">
          <table className="rows">
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td style={{ width: 28 }}>
                    <input type="checkbox" aria-label={`Mark ${t.title} done`} checked={t.status === "done"}
                      onChange={(e) => setDone(t, e.target.checked)} />
                  </td>
                  <td>
                    <div style={{ textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</div>
                    <div className="hint">{[whenDue(t.due_at), t.contact_name, SOURCES[t.source]].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <EditTask task={t} onSaved={load} />
                    <button className="ghost" onClick={() => remove(t)} aria-label={`Delete ${t.title}`}><Icon name="trash" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddTask onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {confirmNode}
    </section>
  );
}

function AddTask({ onClose, onSaved }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [contacts, setContacts] = useState([]);
  const [contactId, setContactId] = useState("");
  useEffect(() => { get("/api/contacts?per_page=100").then((d) => setContacts(d.items ?? d ?? [])).catch(() => {}); }, []);

  const save = async () => {
    try {
      await post("/api/tasks", { title, due_at: fromInput(due), contact_id: contactId || null });
      toast("Task added."); onSaved();
    } catch (e) { toast(e.message, true); }
  };
  return (
    <div className="card" style={{ marginTop: "var(--s4)", maxWidth: 620 }}>
      <div className="card-head"><span className="card-title">New task</span></div>
      <div className="field"><label className="f">What is it?</label>
        <input value={title} maxLength={200} placeholder="Pay the November EMI" onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label className="f">Due (India time)</label>
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></div>
      <div className="field"><label className="f">Whose task is it? (optional)</label>
        <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
          <option value="">Nobody in particular</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="hint">An agent can only read out tasks that belong to the person it is calling.</span></div>
      <div className="actions">
        <button className="primary" onClick={save}>Add task</button>
        <button className="ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function EditTask({ task, onSaved }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(forInput(task.due_at));
  if (!open) return <button className="ghost" onClick={() => setOpen(true)}>Edit</button>;

  const save = async () => {
    try { await patch(`/api/tasks/${task.id}`, { title, due_at: fromInput(due) }); setOpen(false); toast("Saved."); onSaved(); }
    catch (e) { toast(e.message, true); }
  };
  return (
    <span className="inline-edit">
      <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="Task" />
      <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
      <button className="primary" onClick={save}>Save</button>
      <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}
