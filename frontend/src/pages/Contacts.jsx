import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { fmtDur, Icon, initials, Menu, Modal, OutcomePill, plural, Spinner, useConfirm, useToast, whenShort } from "../ui.jsx";

const PER_PAGE = 25;

export default function Contacts() {
  const me = useMe();
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
        <div className="head-actions"><button className="primary" onClick={() => setEditing({})}><Icon name="plus" />New contact</button></div>
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
                <div style={{ minWidth: 0 }}><b className="ellip">{c.name}</b>{c.dnc ? <span className="pill dnc" style={{ height: 20, fontSize: 11, marginTop: 4 }}>Do not call</span> : <div className="muted">{c.call_count ? plural(c.call_count, "call") : "Not called yet"}</div>}</div>
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
      {editing && <EditContact contact={editing} tags={tags} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} canBulk={isAdmin(me)} />}
      {confirmNode}
    </section>
  );
}

function EditContact({ contact, tags, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !contact.id;
  const [name, setName] = useState(contact.name || "");
  const [number, setNumber] = useState(isNew ? "" : "");
  const [picked, setPicked] = useState(contact.tags || []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (isNew) await post("/api/contacts", { name, numbers: number ? [number] : [], tags: picked });
      else await patch(`/api/contacts/${contact.id}`, { name, tags: picked });
      toast("Contact saved."); onSaved();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Modal title={isNew ? "New contact" : `Edit ${contact.name}`} onClose={onClose}>
      <div className="field"><label className="f">Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Asha Rao" /></div>
      {isNew && <div className="field"><label className="f">Phone number</label><input type="tel" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="98765 43210" /></div>}
      <div className="field"><label className="f">Tags</label>
        <div className="chips">
          {tags.length === 0 && <span className="hint">No tags yet.</span>}
          {tags.map((t) => <button type="button" key={t.id} className={`chip${picked.includes(t.id) ? " on" : ""}`} onClick={() => toggle(t.id)}>{t.name}</button>)}
        </div>
      </div>
      <div className="actions" style={{ justifyContent: "flex-end" }}><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save} disabled={busy}>Save contact</button></div>
    </Modal>
  );
}
