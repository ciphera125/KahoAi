import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { del, get, patch, post } from "../api.js";
import { fmtDur, Icon, initials, Menu, Modal, OutcomePill, plural, Spinner, useConfirm, useToast, whenShort } from "../ui.jsx";

const PER_PAGE = 25;

export default function Contacts() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [data, setData] = useState(null);
  const [tags, setTags] = useState([]);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null); // contact or {} for new
  const debounce = useRef();

  const load = useCallback(() => get(`/api/contacts?page=${page}&per_page=${PER_PAGE}&q=${encodeURIComponent(q)}`).then(setData).catch((e) => toast(e.message, true)), [page, q, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { get("/api/tags").then(setTags).catch(() => {}); }, [editing]);

  const onSearch = (e) => { const v = e.target.value; clearTimeout(debounce.current); debounce.current = setTimeout(() => { setPage(1); setQ(v); }, 250); };
  const tagById = (id) => tags.find((t) => t.id === id);

  const toggleDnc = async (c) => {
    try { await patch(`/api/contacts/${c.id}`, { dnc: !c.dnc }); toast(c.dnc ? `${c.name} can be called again.` : `${c.name} will not be called.`); load(); }
    catch (e) { toast(e.message, true); }
  };
  const remove = async (c) => {
    if (!(await confirm({ title: `Delete ${c.name}?`, text: "Their numbers and tags go with them. Call history is kept.", ok: "Delete" }))) return;
    await del(`/api/contacts/${c.id}`); toast("Contact deleted."); load();
  };

  return (
    <section>
      <header className="page">
        <div><h1>Contacts</h1><div className="sub">The people your agents call. Mark anyone Do not call to stop dialling them.</div></div>
        <div className="head-actions">
          <Link className="btn ghost" to="/bulk"><Icon name="upload" />Bulk call from a file</Link>
          <button className="primary" onClick={() => setEditing({})}><Icon name="plus" />New contact</button>
        </div>
      </header>
      <div className="card list">
        <div className="list-bar">
          <span className="muted">{data ? plural(data.total, "contact") : ""}</span>
          <span className="grow" />
          <input type="search" placeholder="Search name, number or tag" onChange={onSearch} />
        </div>
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) 56px" }}>
          <span>Name</span><span>Number</span><span>Tags</span><span>Last call</span><span />
        </div>
        {!data && <Spinner />}
        {data?.contacts.length === 0 && <div className="empty">{q ? "No contacts match that search." : "No contacts yet. Add one with “New contact”."}</div>}
        {data?.contacts.map((c) => {
          const first = c.numbers[0];
          const lc = c.last_call;
          return (
            <div key={c.id} className="row" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) 56px" }}>
              <div className="who"><div className="avatar">{initials(c.name)}</div>
                <div style={{ minWidth: 0 }}><button type="button" className="link ellip" onClick={() => setEditing(c)}>{c.name}</button>{c.dnc ? <span className="pill dnc" style={{ height: 20, fontSize: 11, marginTop: 4 }}>Do not call</span> : <div className="muted">{c.call_count ? plural(c.call_count, "call") : "Not called yet"}</div>}</div>
              </div>
              <div className="num ellip">{first ? first.number : <span className="muted">No number</span>}{c.numbers.length > 1 && <span className="muted">  +{c.numbers.length - 1}</span>}</div>
              <div className="tags">{(c.tags || []).map((id) => { const t = tagById(id); return t ? <span key={id} className="tag" style={{ "--tc": `var(--t-${t.color})` }}>{t.name}</span> : null; })}</div>
              <div style={{ minWidth: 0 }}>{lc ? <div><div className="muted">{whenShort(lc.started_at)}</div><div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}><OutcomePill status={lc.status} />{lc.status === "answered" && lc.duration_secs != null && <span className="muted">{fmtDur(lc.duration_secs)}</span>}</div></div> : <span className="muted">—</span>}</div>
              <div className="row-actions">
                <Menu items={[
                  ["Edit", () => setEditing(c)],
                  [c.dnc ? "Allow calls again" : "Mark Do not call", () => toggleDnc(c)],
                  ["Delete", () => remove(c), true],
                ]} />
              </div>
            </div>
          );
        })}
        {data && data.total > PER_PAGE && (
          <div className="pager">
            <span>Page {data.page} of {Math.ceil(data.total / PER_PAGE)}</span>
            <button className="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <button className="ghost" disabled={page * PER_PAGE >= data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>
      {editing && <EditContact contact={editing} tags={tags} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); get("/api/tags").then(setTags).catch(() => {}); }} />}
      {confirmNode}
    </section>
  );
}

const TAG_COLOURS = ["marigold", "plum", "orchid", "teal", "silver", "rose"];

// One place to change everything about a person: name, numbers, tags (pick or
// create), and Do not call. Nothing is saved until "Save contact".
function EditContact({ contact, tags: initialTags, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !contact.id;
  const [name, setName] = useState(contact.name || "");
  const [numbers, setNumbers] = useState(() => (contact.numbers?.length ? contact.numbers.map((n) => ({ id: n.id, number: n.number })) : [{ id: null, number: "" }]));
  const [tags, setTags] = useState(initialTags);
  const [picked, setPicked] = useState(contact.tags || []);
  const [dnc, setDnc] = useState(!!contact.dnc);
  const [busy, setBusy] = useState(false);

  const setNumber = (i, number) => setNumbers((list) => list.map((n, j) => (j === i ? { ...n, number } : n)));
  const removeNumber = (i) => setNumbers((list) => (list.length === 1 ? [{ id: null, number: "" }] : list.filter((_, j) => j !== i)));

  const createTag = async (tagName) => {
    const t = await post("/api/tags", { name: tagName, color: TAG_COLOURS[tags.length % TAG_COLOURS.length] });
    setTags((list) => [...list, t]);
    setPicked((p) => [...p, t.id]);
  };

  const save = async () => {
    if (!name.trim()) return toast("Give this contact a name.", true);
    const wanted = numbers.map((n) => ({ ...n, number: n.number.trim() })).filter((n) => n.number);
    setBusy(true);
    try {
      if (isNew) {
        const c = await post("/api/contacts", { name, numbers: wanted.map((n) => n.number), tags: picked });
        if (dnc) await patch(`/api/contacts/${c.id}`, { dnc: true });
      } else {
        await patch(`/api/contacts/${contact.id}`, { name, tags: picked, dnc });
        const before = new Map(contact.numbers.map((n) => [n.id, n.number]));
        const kept = new Set(wanted.filter((n) => n.id).map((n) => n.id));
        for (const [id] of before) if (!kept.has(id)) await del(`/api/contacts/${contact.id}/numbers/${id}`);
        for (const n of wanted) {
          if (n.id && before.get(n.id) !== n.number) await patch(`/api/contacts/${contact.id}/numbers/${n.id}`, { number: n.number });
          if (!n.id) await post(`/api/contacts/${contact.id}/numbers`, { number: n.number });
        }
      }
      toast("Contact saved."); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? "New contact" : "Edit contact"} onClose={onClose} wide>
      <div className="edit-contact">
        <div className="field"><label className="f" htmlFor="c-name">Name</label>
          <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Asha Rao" autoFocus />
        </div>
        <div className="field"><label className="f">Phone numbers</label>
          <div className="num-list">
            {numbers.map((n, i) => (
              <div key={n.id || `new-${i}`} className="num-line">
                <input type="tel" value={n.number} onChange={(e) => setNumber(i, e.target.value)} placeholder="98765 43210" aria-label={`Phone number ${i + 1}`} />
                <button type="button" className="icon-btn" title="Remove this number" onClick={() => removeNumber(i)}><Icon name="trash" /></button>
              </div>
            ))}
          </div>
          <button type="button" className="link add-line" onClick={() => setNumbers((l) => [...l, { id: null, number: "" }])}><Icon name="plus" />Add another number</button>
          <span className="hint">Indian numbers can be written as 98765 43210; others need the + and country code.</span>
        </div>
        <div className="field"><label className="f">Tags</label>
          <TagPicker tags={tags} picked={picked} setPicked={setPicked} onCreate={createTag} />
        </div>
        <div className="toggle-line" style={{ marginBottom: 0 }}>
          <div><b>Do not call</b><div className="hint">No agent will dial this person until this is turned off.</div></div>
          <label className="switch"><input type="checkbox" checked={dnc} onChange={(e) => setDnc(e.target.checked)} /><span /></label>
        </div>
      </div>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save contact"}</button>
      </div>
    </Modal>
  );
}

/** Chosen tags as chips, and one box to find an existing tag or create a new one. */
function TagPicker({ tags, picked, setPicked, onCreate }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const q = text.trim().toLowerCase();
  const byId = (id) => tags.find((t) => t.id === id);
  const options = tags.filter((t) => !picked.includes(t.id) && t.name.toLowerCase().includes(q));
  const exact = tags.find((t) => t.name.toLowerCase() === q);
  const add = (id) => { setPicked((p) => (p.includes(id) ? p : [...p, id])); setText(""); };
  const create = async () => {
    if (!q) return;
    try { await onCreate(text.trim()); setText(""); } catch (e) { toast(e.message, true); }
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (exact) add(exact.id); else if (options.length === 1) add(options[0].id); else create(); }
    if (e.key === "Backspace" && !text && picked.length) setPicked((p) => p.slice(0, -1));
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
  };
  return (
    <div className="tag-picker" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <div className="tag-box" onClick={(e) => e.currentTarget.querySelector("input").focus()}>
        {picked.map((id) => { const t = byId(id); return t ? (
          <span key={id} className="tag" style={{ "--tc": `var(--t-${t.color})` }}>{t.name}
            <button type="button" className="tag-x" aria-label={`Remove ${t.name}`} onClick={() => setPicked((p) => p.filter((x) => x !== id))}><Icon name="x" /></button>
          </span>) : null; })}
        <input value={text} onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
          placeholder={picked.length ? "Add another tag" : "Find or create a tag"} aria-label="Add a tag" />
      </div>
      {open && (options.length > 0 || (q && !exact)) && (
        <div className="menu tag-menu">
          {options.slice(0, 8).map((t) => (
            <button type="button" key={t.id} onMouseDown={(e) => e.preventDefault()} onClick={() => add(t.id)}>
              <span className="tag" style={{ "--tc": `var(--t-${t.color})` }}>{t.name}</span>
            </button>
          ))}
          {q && !exact && <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={create}><span><Icon name="plus" /> Create tag “{text.trim()}”</span></button>}
        </div>
      )}
    </div>
  );
}
