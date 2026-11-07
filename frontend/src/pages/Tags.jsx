import { useState } from "react";
import { del, patch, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { useTags } from "../tags.jsx";
import { Icon, Menu, Modal, Spinner, useConfirm, usePaged, useToast } from "../ui.jsx";

export default function Tags() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { tags, reload } = useTags();
  const [editing, setEditing] = useState(null);
  const [shown, pager] = usePaged(tags ?? []);
  if (!tags) return <Spinner />;

  const remove = async (t) => {
    if (!(await confirm({ title: `Delete "${t.name}"?`, text: "It will be removed from all contacts.", ok: "Delete" }))) return;
    await del(`/api/tags/${t.id}`).catch((e) => toast(e.message, true));
    toast("Tag deleted."); reload();
  };

  return (
    <section>
      <header className="page">
        <div><h1>Tags</h1><div className="sub">Labels you can attach to contacts for filtering and organization.</div></div>
        <div className="head-actions"><button className="primary" onClick={() => setEditing({})}><Icon name="plus" />New tag</button></div>
      </header>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,2fr) 100px 56px" }}><span>Tag</span><span>Color</span><span /></div>
        {tags.length === 0 && <div className="empty">No tags yet. Create one and assign it to contacts.</div>}
        {shown.map((t) => (
          <div key={t.id} className="row" style={{ gridTemplateColumns: "minmax(0,2fr) 100px 56px" }}>
            <span className="ellip"><span className="tag" style={{ "--tc": `var(--t-${t.color})` }}>{t.name}</span></span>
            <span className="muted">{t.color}</span>
            <div className="row-actions"><Menu items={[["Rename", () => setEditing(t)], isAdmin(me) && ["Delete", () => remove(t), true]]} /></div>
          </div>
        ))}
      </div>
      {pager}
      {editing && <EditTag tag={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirmNode}
    </section>
  );
}

function EditTag({ tag, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !tag.id;
  const [name, setName] = useState(tag.name || "");
  const save = async () => {
    try {
      if (isNew) await post("/api/tags", { name });
      else await patch(`/api/tags/${tag.id}`, { name });
      toast("Tag saved."); onSaved();
    } catch (e) { toast(e.message, true); }
  };
  return (
    <Modal title={isNew ? "New tag" : "Rename tag"} onClose={onClose}>
      <div className="field"><label className="f">Tag name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP" maxLength={30} autoFocus onKeyDown={(e) => e.key === "Enter" && save()} /></div>
      <div className="actions" style={{ justifyContent: "flex-end" }}><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></div>
    </Modal>
  );
}
