import { can, useMe } from "../auth.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, patch, post } from "../api.js";
import CallDetail from "../components/CallDetail.jsx";
import { serverView } from "../paginate.js";
import { dayWord } from "../time.js";
import { dueState } from "../toolCalls.js";
import { Icon, Info, Modal, Pager, Spinner, useConfirm, useToast } from "../ui.jsx";

// What needs doing first: overdue, then today. The counts come from the server and cover every task.
const RANGES = [["all", "All"], ["overdue", "Overdue"], ["today", "Today"], ["this_week", "This week"], ["yesterday", "Yesterday"]];
const STATUSES = [["pending", "Still to do"], ["done", "Finished"], ["all", "Both"]];
const SOURCES = { studio: "Added here", api: "From your system", call: "Added on a call", csv: "From a file" };
const DUE = { overdue: ["failed", "Overdue"], today: ["warn", "Due today"] };

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
/** "15 Nov, 9:00 am", on India's clock. */
const dueText = (iso) => `${dayWord(iso)}, ${new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}`;

export default function Tasks() {
  const toast = useToast();
  const me = useMe();
  const [confirm, confirmNode] = useConfirm();
  const [data, setData] = useState(null);
  const [range, setRange] = useState("all");
  const [status, setStatus] = useState("pending");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [opened, setOpened] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [text]);

  // Only the newest answer is shown, so a slow older one cannot land on top of it.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    const query = new URLSearchParams({ range, status, page: String(page), per_page: String(size) });
    if (q) query.set("q", q);
    try { const d = await get(`/api/tasks?${query}`); if (mine === latest.current) setData(d); }
    catch (e) { if (mine === latest.current) toast(e.message, true); }
  }, [range, status, q, page, size, toast]);
  useEffect(() => { load(); }, [load]);

  const setDone = async (task, done) => {
    try { await patch(`/api/tasks/${task.id}`, { status: done ? "done" : "pending" }); load(); }
    catch (e) { toast(e.message, true); }
  };
  const remove = async (task) => {
    if (!(await confirm({ title: `Delete “${task.title}”?`, text: "This cannot be undone.", ok: "Delete" }))) return;
    try { await del(`/api/tasks/${task.id}`); toast("Deleted."); load(); } catch (e) { toast(e.message, true); }
  };
  const openCall = async (callId) => {
    try { setOpened(await get(`/api/calls/${encodeURIComponent(callId)}`)); } catch (e) { toast(e.message, true); }
  };
  const counts = data?.counts;
  const countFor = (key) => (counts && ["overdue", "today", "this_week"].includes(key) ? counts[key] : null);
  const statusCount = (key) => (counts && key !== "all" ? counts[key] : null);

  return (
    <section>
      <header className="page">
        <div><h1>Tasks<Info text="A to-do with a date, kept for one person. Your agent can read these out on a call, add one when the caller asks, move a date or tick one off." /></h1>
          <div className="sub">Things your agent reminds people about, like “Pay the November EMI”.</div></div>
        {can(me, "contacts.edit") && <div className="head-actions"><button className="primary" onClick={() => setAdding(true)}><Icon name="plus" />Add a task</button></div>}
      </header>

      <div className="card explain">
        <b>What are tasks for?</b>
        <p className="hint">A task is one thing a person has to do, with a date. On a call your agent can read a person's
          tasks out to them, add one when they ask, move the date or tick one off, if you switch those tools on for the agent
          (Agents, then Tools). An agent only ever sees the tasks of the person it is talking to. Type tasks here, let your
          own system send them in, or let the agent add them: those link back to the call they were added on.</p>
      </div>

      <div className="task-filters">
        <span className="filter-label">When it is due<Info text="Filter by due date, by India's calendar. The numbers count every task still to do, whatever else is on screen." /></span>
        <div className="seg" role="tablist" aria-label="When it is due">
          {RANGES.map(([v, l]) => (
            <button key={v} role="tab" aria-selected={range === v} className={range === v ? "on" : ""} onClick={() => { setRange(v); setPage(1); }}>
              {l}{countFor(v) !== null && <span className="count">{countFor(v)}</span>}</button>))}
        </div>
      </div>
      <div className="task-filters">
        <span className="filter-label">Show<Info text="Still to do, finished, or both." /></span>
        <div className="seg" role="tablist" aria-label="Show">
          {STATUSES.map(([v, l]) => (
            <button key={v} role="tab" aria-selected={status === v} className={status === v ? "on" : ""} onClick={() => { setStatus(v); setPage(1); }}>
              {l}{statusCount(v) !== null && <span className="count">{statusCount(v)}</span>}</button>))}
        </div>
        <div className="call-search" style={{ marginLeft: "auto", minWidth: 220 }}>
          <Icon name="search" />
          <input type="search" value={text} maxLength={100} placeholder="Find a task or a person" aria-label="Find a task or a person" title="Searches what the task says and the person it belongs to"
            onChange={(e) => setText(e.target.value)} />
        </div>
      </div>

      {!data && <Spinner />}
      {data && data.items.length === 0 && <div className="card"><p className="hint">
        {q ? "No task matches that." : range === "overdue" && status === "pending" ? "Nothing is overdue."
          : range === "today" && status === "pending" ? "Nothing is due today."
            : "No tasks here. Press “Add a task” to make one."}</p></div>}
      {data && data.items.length > 0 && (
        <div className="card">
          <table className="rows">
            <tbody>
              {data.items.map((t) => {
                const [pill, word] = DUE[dueState(t)] ?? [];
                return (
                  <tr key={t.id}>
                    <td style={{ width: 28 }}>
                      <input type="checkbox" aria-label={`Mark ${t.title} done`} checked={t.status === "done"}
                        disabled={!can(me, "contacts.edit")} onChange={(e) => setDone(t, e.target.checked)} />
                    </td>
                    <td>
                      <div style={{ textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</div>
                      <div className="hint task-row-meta">
                        {pill && <span className={`pill ${pill}`}>{word}</span>}
                        <span>{t.due_at ? `Due ${dueText(t.due_at)}` : "No date"}</span>
                        <span>· {t.contact_name || "For your team"}</span>
                        <span>· {SOURCES[t.source] ?? t.source}</span>
                        {t.call_id && <button type="button" className="link" onClick={() => openCall(t.call_id)}>Open the call</button>}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {can(me, "contacts.edit") && <><button className="ghost" onClick={() => setEditing(t)}>Edit</button>
                      <button className="ghost" onClick={() => remove(t)} aria-label={`Delete ${t.title}`}><Icon name="trash" /></button></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && <Pager view={serverView({ page: data.page, total: data.total, size: data.per_page })} size={data.per_page}
        onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />}
      {(adding || editing) && <TaskForm task={editing} onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }} />}
      {opened && <CallDetail call={opened} onClose={() => setOpened(null)} />}
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
      <div className="field"><label className="f">What has to be done?<Info text="One short line the agent can read out, like Pay the November EMI." /></label>
        <input value={title} maxLength={200} placeholder="Pay the November EMI" autoFocus onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label className="f">When is it due? (India time)<Info text="The day and time. Leave it empty for a task with no date. Times are India time." /></label>
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></div>
      <div className="field"><label className="f">Whose task is it? (optional)<Info text="The agent reads a task out only to the person it belongs to. A task with no person is for your team and is never read out." /></label>
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
        <span className="hint">The agent reads a task out only to the person it belongs to. Leave this empty for a to-do for your team: no agent will read it out.</span></div>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy || !title.trim()}>{isNew ? "Add task" : "Save"}</button>
      </div>
    </Modal>
  );
}
