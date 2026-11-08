import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { del, get, patch, post } from "../api.js";
import { can, isAdmin, useMe } from "../auth.jsx";
import { useTags } from "../tags.jsx";
import { serverView } from "../paginate.js";
import { dayWord } from "../time.js";
import CallContact from "../components/CallContact.jsx";
import { Icon, initials, Menu, Modal, OutcomePill, Pager, plural, Spinner, useConfirm, useToast } from "../ui.jsx";

const TABS = [
  { key: "all", label: "All" },
  { key: "given", label: "Consented" },
  { key: "refused", label: "DNC" },
];

export default function Contacts() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [data, setData] = useState(null);
  const { tags, reload: reloadTags } = useTags();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null);
  const [calling, setCalling] = useState(null);
  const debounce = useRef();

  const consent = tab === "all" ? "" : tab === "refused" ? "refused" : "given";
  const load = useCallback(() => {
    let url = `/api/contacts?page=${page}&per_page=${perPage}&q=${encodeURIComponent(q)}`;
    if (consent) url += `&consent=${consent}`;
    get(url).then((d) => { setData(d); setSelected(new Set()); }).catch((e) => toast(e.message, true));
  }, [page, perPage, q, consent, toast]);
  useEffect(() => { load(); }, [load]);

  const onSearch = (e) => { const v = e.target.value; clearTimeout(debounce.current); debounce.current = setTimeout(() => { setPage(1); setQ(v); }, 250); };
  const switchTab = (key) => { setTab(key); setPage(1); };
  const tagById = (id) => tags.find((t) => t.id === id);

  const toggleAll = () => {
    if (!data) return;
    const ids = data.contacts.map((c) => c.id);
    setSelected((s) => (s.size === ids.length ? new Set() : new Set(ids)));
  };
  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const toggleDnc = async (c) => {
    try { await patch(`/api/contacts/${c.id}`, { dnc: !c.dnc }); toast(c.dnc ? `${c.name} can be called again.` : `${c.name} will not be called.`); load(); }
    catch (e) { toast(e.message, true); }
  };
  const setConsent = async (c, v) => {
    try { await patch(`/api/contacts/${c.id}`, { consent: v }); toast(`Consent set to ${v}.`); load(); }
    catch (e) { toast(e.message, true); }
  };
  const remove = async (c) => {
    if (!(await confirm({ title: `Delete ${c.name}?`, text: "Their numbers and tags go with them. Call history is kept.", ok: "Delete" }))) return;
    await del(`/api/contacts/${c.id}`); toast("Contact deleted."); load();
  };
  const bulkAction = async (action) => {
    if (!selected.size) return toast("Select contacts first.", true);
    const ids = [...selected];
    if (action === "delete") {
      if (!(await confirm({ title: `Delete ${ids.length} contacts?`, text: "Their numbers and tags go with them.", ok: "Delete" }))) return;
      for (const id of ids) await del(`/api/contacts/${id}`).catch(() => {});
      toast(`${ids.length} contacts deleted.`);
    } else if (action === "dnc") {
      for (const id of ids) await patch(`/api/contacts/${id}`, { dnc: true }).catch(() => {});
      toast(`${ids.length} contacts marked Do not call.`);
    } else if (action === "consent-given") {
      for (const id of ids) await patch(`/api/contacts/${id}`, { consent: "given" }).catch(() => {});
      toast(`${ids.length} contacts marked as consented.`);
    }
    load();
  };


  return (
    <section>
      <header className="page">
        <div><h1>Contacts</h1><div className="sub">The people your agents call. Mark anyone Do not call to stop dialling them.</div></div>
        <div className="head-actions">
          {can(me, "calls.bulk") && <Link className="btn ghost" to="/bulk"><Icon name="upload" />Bulk call from a file</Link>}
          {can(me, "contacts.edit") && <button className="primary" onClick={() => setEditing({})}><Icon name="plus" />New contact</button>}
        </div>
      </header>

      <div className="notice-bar" style={{ marginBottom: "var(--s4)", padding: "var(--s3) var(--s4)", background: "var(--warn-soft)", borderRadius: "var(--r-lg)", fontSize: 13 }}>
        Outbound calls require the person's consent under India's TRAI/DND rules. Mark contacts as Consented before calling them.
      </div>

      <div className="card list">
        <div className="tabs-bar" style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: "var(--s3)" }}>
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`tab-btn${tab === t.key ? " active" : ""}`} onClick={() => switchTab(t.key)}>{t.label}</button>
          ))}
        </div>

        <div className="list-bar">
          <span className="muted">{data ? plural(data.total, "contact") : ""}</span>
          {selected.size > 0 && (
            <span className="list-actions" style={{ display: "flex", gap: 8, marginLeft: 12 }}>
              <button className="ghost small-btn" onClick={() => bulkAction("consent-given")}>Mark consented</button>
              <button className="ghost small-btn" onClick={() => bulkAction("dnc")}>Mark DNC</button>
              {isAdmin(me) && <button className="ghost small-btn bad" onClick={() => bulkAction("delete")}>Delete</button>}
            </span>
          )}
          <span className="grow" />
          <input type="search" placeholder="Search name, number or tag" onChange={onSearch} />
        </div>

        <div className="row head" style={{ gridTemplateColumns: "32px minmax(0,1.3fr) minmax(0,1fr) minmax(0,0.8fr) 80px minmax(0,1fr) 104px" }}>
          <span><input type="checkbox" checked={data?.contacts.length > 0 && selected.size === data?.contacts.length} onChange={toggleAll} aria-label="Select all" /></span>
          <span>Name</span><span>Number</span><span>Tags</span><span>Consent</span><span>Last call</span><span />
        </div>
        {!data && <Spinner />}
        {data?.contacts.length === 0 && <div className="empty">{q ? "No contacts match that search." : 'No contacts yet. Add one with “New contact”.'}</div>}
        {data?.contacts.map((c) => {
          const first = c.numbers[0];
          const lc = c.last_call;
          const consentBadge = c.consent === "given" ? "ok" : c.consent === "refused" ? "bad" : "";
          return (
            <div key={c.id} className="row" style={{ gridTemplateColumns: "32px minmax(0,1.3fr) minmax(0,1fr) minmax(0,0.8fr) 80px minmax(0,1fr) 104px" }}>
              <span><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} aria-label={`Select ${c.name}`} /></span>
              <div className="who"><div className="avatar">{initials(c.name)}</div>
                <div style={{ minWidth: 0 }}><button type="button" className="link ellip" onClick={() => setEditing(c)}>{c.name}</button>{c.dnc ? <span className="pill dnc" style={{ height: 20, fontSize: 11, marginTop: 4 }}>Do not call</span> : <div className="muted">{c.call_count ? plural(c.call_count, "call") : "Not called yet"}</div>}</div>
              </div>
              <div className="num ellip">{first ? first.number : <span className="muted">No number</span>}{c.numbers.length > 1 && <span className="muted">  +{c.numbers.length - 1}</span>}</div>
              <div className="tags">{(c.tags || []).map((id) => { const t = tagById(id); return t ? <span key={id} className="tag" style={{ "--tc": `var(--t-${t.color})` }}>{t.name}</span> : null; })}</div>
              <span><span className={`badge ${consentBadge}`}>{c.consent || "pending"}</span></span>
              <div style={{ minWidth: 0 }}>{lc ? <div className="last-call"><OutcomePill status={lc.status} /><span className="muted">{dayWord(lc.started_at)}</span></div> : <span className="muted">Not called yet</span>}</div>
              <div className="row-actions">
                {can(me, "calls.place") && (
                  <button type="button" className="call-btn" disabled={!first || c.dnc || c.consent === "refused"}
                    title={!first ? "No number to call" : c.dnc ? "Marked Do not call" : c.consent === "refused" ? "Refused to be called" : `Call ${c.name}`}
                    aria-label={`Call ${c.name}`} onClick={() => setCalling(c)}><Icon name="call" /></button>
                )}
                <Menu items={[
                  ["Edit", () => setEditing(c)],
                  [c.dnc ? "Allow calls again" : "Mark Do not call", () => toggleDnc(c)],
                  c.consent !== "given" && ["Mark consented", () => setConsent(c, "given")],
                  c.consent !== "refused" && ["Mark refused", () => setConsent(c, "refused")],
                  isAdmin(me) && ["Delete", () => remove(c), true],
                ].filter(Boolean)} />
              </div>
            </div>
          );
        })}
        {data && <Pager view={serverView({ page, total: data.total, size: perPage })} size={perPage}
          onPage={setPage} onSize={(n) => { setPerPage(n); setPage(1); }} />}
      </div>
      {editing && <EditContact contact={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); reloadTags(); }} />}
      {calling && <CallContact contact={calling} onClose={() => setCalling(null)} onPlaced={() => load()} />}
      {confirmNode}
    </section>
  );
}

const TAG_COLOURS = ["marigold", "plum", "orchid", "teal", "silver", "rose"];

// One place to change everything about a person: name, numbers, tags (pick or
// create), and Do not call. Nothing is saved until "Save contact".
/** What the customer's own system has sent us about this contact, and what agents have
 * saved on calls. Read-only here: it comes from somewhere else. */
function KnownAbout({ contact }) {
  const [answers, setAnswers] = useState(null);
  useEffect(() => { get(`/api/contacts/${contact.id}/answers`).then(setAnswers).catch(() => setAnswers([])); }, [contact.id]);
  const details = Object.entries(contact.details ?? {});
  if (details.length === 0 && !answers?.length) return null;
  return (
    <div className="answers" style={{ marginTop: "var(--s3)" }}>
      <div className="card-title" style={{ marginBottom: 6 }}>What we know</div>
      {details.map(([k, v]) => (
        <div key={k} className="answer-line"><span className="muted">{k.replace(/_/g, " ")}</span><b>{String(v)}</b></div>
      ))}
      {answers?.map((a) => (
        <div key={a.id} className="answer-line">
          <span className="muted">{a.label}</span><b>{a.value}</b>
          <span className="hint">said on a call, {new Date(a.at).toLocaleDateString()}</span>
        </div>
      ))}
    </div>
  );
}

function EditContact({ contact, onClose, onSaved }) {
  const toast = useToast();
  const { tags, reload: reloadTags } = useTags();
  const isNew = !contact.id;
  const [name, setName] = useState(contact.name || "");
  const [numbers, setNumbers] = useState(() => (contact.numbers?.length ? contact.numbers.map((n) => ({ id: n.id, number: n.number })) : [{ id: null, number: "" }]));
  const [picked, setPicked] = useState(contact.tags || []);
  const [dnc, setDnc] = useState(!!contact.dnc);
  const [busy, setBusy] = useState(false);

  const setNumber = (i, number) => setNumbers((list) => list.map((n, j) => (j === i ? { ...n, number } : n)));
  const removeNumber = (i) => setNumbers((list) => (list.length === 1 ? [{ id: null, number: "" }] : list.filter((_, j) => j !== i)));

  const createTag = async (tagName) => {
    const t = await post("/api/tags", { name: tagName, color: TAG_COLOURS[tags.length % TAG_COLOURS.length] });
    reloadTags();
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
        {!isNew && <KnownAbout contact={contact} />}
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
          {q && !exact && <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={create}><span><Icon name="plus" /> Create tag "{text.trim()}"</span></button>}
        </div>
      )}
    </div>
  );
}
