import { useEffect, useState } from "react";
import { del, get, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { Icon, Spinner, useConfirm, useToast } from "../ui.jsx";

export default function Settings() {
  const me = useMe();
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  useEffect(() => { get("/api/settings").then(setSettings).catch((e) => toast(e.message, true)); }, []);
  if (!settings) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Settings</h1><div className="sub">Workspace configuration and limits.</div></div>
      </header>
      <div className="card" style={{ maxWidth: 640 }}>
        <h2 style={{ margin: "0 0 var(--s4)" }}>Organization</h2>
        <dl className="settings-grid">
          <dt>Name</dt><dd>{me.org_name}</dd>
          <dt>Your role</dt><dd>{me.role}</dd>
        </dl>
      </div>
      <div className="card" style={{ maxWidth: 640, marginTop: "var(--s4)" }}>
        <h2 style={{ margin: "0 0 var(--s4)" }}>Phone</h2>
        <dl className="settings-grid">
          <dt>Our number</dt><dd>{settings.our_number || <span className="muted">Not configured</span>}</dd>
        </dl>
      </div>
      <div className="card" style={{ maxWidth: 640, marginTop: "var(--s4)" }}>
        <h2 style={{ margin: "0 0 var(--s4)" }}>Call limits</h2>
        <dl className="settings-grid">
          <dt>Max call duration</dt><dd>{settings.limits.max_minutes} minutes</dd>
          <dt>Ring timeout options</dt><dd>{settings.limits.ring_secs.join(", ")} seconds</dd>
          <dt>Max prompt length</dt><dd>{settings.max_chars.toLocaleString()} characters</dd>
        </dl>
      </div>
      <div className="card" style={{ maxWidth: 640, marginTop: "var(--s4)" }}>
        <h2 style={{ margin: "0 0 var(--s4)" }}>Available tools</h2>
        <div className="card list" style={{ margin: 0, border: "none", boxShadow: "none" }}>
          {(settings.tools || []).map((t) => (
            <div key={t.name} className="row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)" }}>
              <span className="code">{t.name}</span>
              <span className="muted">{t.help || "—"}</span>
            </div>
          ))}
        </div>
      </div>
      {isAdmin(me) && <ApiKeys />}
    </section>
  );
}

/** Keys another system uses to push tasks in. Shown once, then only by their first few
 * characters: we keep a hash, so nobody here can read one back out. */
function ApiKeys() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null);

  const load = () => get("/api/api-keys").then(setKeys).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []);

  const make = async () => {
    try { const k = await post("/api/api-keys", { name }); setFresh(k); setName(""); load(); }
    catch (e) { toast(e.message, true); }
  };
  const revoke = async (k) => {
    if (!(await confirm({ title: `Revoke ${k.name || k.prefix}?`,
      text: "Anything using this key stops working at once. This cannot be undone.", ok: "Revoke key" }))) return;
    try { await del(`/api/api-keys/${k.id}`); toast("Key revoked."); load(); } catch (e) { toast(e.message, true); }
  };

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: "var(--s4)" }}>
      <h2 style={{ margin: "0 0 var(--s3)" }}>API keys</h2>
      <p className="hint" style={{ marginBottom: "var(--s4)" }}>
        For your own system to push tasks in, by sending them to <code>/api/v1/tasks</code> with the key.
        A key can only ever write into this organization.
      </p>
      {fresh && (
        <div className="answers" style={{ marginBottom: "var(--s3)" }}>
          <b>Copy this now. It is not shown again.</b>
          <div className="answer-line"><code style={{ wordBreak: "break-all" }}>{fresh.key}</code></div>
        </div>
      )}
      {!keys && <Spinner />}
      {keys?.length === 0 && <p className="hint">No keys yet.</p>}
      {keys?.map((k) => (
        <div key={k.id} className="toggle-line">
          <div><b>{k.name || "Unnamed key"}</b>
            <div className="hint"><code>{k.prefix}…</code> · made {new Date(k.created_at).toLocaleDateString()}
              {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : " · never used"}</div>
          </div>
          <button className="ghost" onClick={() => revoke(k)}>Revoke</button>
        </div>
      ))}
      <div className="field" style={{ marginTop: "var(--s3)" }}><label className="f">Name a new key</label>
        <input value={name} maxLength={60} placeholder="Our CRM" onChange={(e) => setName(e.target.value)} /></div>
      <div className="actions"><button className="primary" onClick={make}><Icon name="plus" />Make a key</button></div>
      {confirmNode}
    </div>
  );
}
