// Parked, not deleted (owner, 2026-11-22): two Settings sections the customers do not need yet. Nothing imports this
// file, so the Studio shows neither and makes none of their requests. The server side (/api/api-keys and the call
// webhook in /api/org/settings) is untouched and ready. To bring one back: import it in Settings.jsx, add its entry
// to TABS (["keys", "API keys"] or ["webhook", "Send calls to your system"]) and render it under the tab's name.
import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { can, isAdmin, useMe } from "../auth.jsx";
import { Icon, Spinner, useConfirm, usePaged, useToast } from "../ui.jsx";

/** Keys another system uses to push tasks in. Shown once, then only by their first few
 * characters: we keep a hash, so nobody here can read one back out. */
export function ApiKeys() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [keys, setKeys] = useState(null);
  const [shownKeys, keysPager] = usePaged(keys ?? []);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null);

  const load = useCallback(() => get("/api/api-keys").then(setKeys).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); }, [load]);

  const make = async () => {
    try { const k = await post("/api/api-keys", { name }); setFresh(k); setName(""); load(); }
    catch (e) { toast(e.message, true); }
  };
  const revoke = async (k) => {
    if (!(await confirm({ title: `Revoke ${k.name || k.prefix}?`,
      text: "Anything using this key stops working at once. This cannot be undone.", ok: "Revoke key" }))) return;
    try { await del(`/api/api-keys/${k.id}`); toast("Key revoked."); load(); } catch (e) { toast(e.message, true); }
  };
  if (!isAdmin(me) && !can(me, "keys.manage")) return null;

  return (
    <div className="card" style={{ maxWidth: 680 }}>
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
      {shownKeys.map((k) => (
        <div key={k.id} className="toggle-line">
          <div><b>{k.name || "Unnamed key"}</b>
            <div className="hint"><code>{k.prefix}…</code> · made {new Date(k.created_at).toLocaleDateString()}
              {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : " · never used"}</div>
          </div>
          <button className="ghost" onClick={() => revoke(k)}>Revoke</button>
        </div>
      ))}
      {keys?.length > 0 && keysPager}
      <div className="field" style={{ marginTop: "var(--s3)" }}><label className="f">Name a new key</label>
        <input value={name} maxLength={60} placeholder="Our CRM" onChange={(e) => setName(e.target.value)} /></div>
      <div className="actions"><button className="primary" onClick={make}><Icon name="plus" />Make a key</button></div>
      {confirmNode}
    </div>
  );
}

export function Webhook() {
  const me = useMe();
  const toast = useToast();
  const editable = can(me, "org.settings");
  const [s, setS] = useState(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState(null);
  useEffect(() => { get("/api/org/settings").then((d) => { setS(d); setUrl(d.webhook_url ?? ""); }).catch((e) => toast(e.message, true)); }, [toast]);
  const save = async (changes) => {
    try {
      const next = await patch("/api/org/settings", changes);
      setS(next); setUrl(next.webhook_url ?? "");
      if (next.webhook_secret) setSecret(next.webhook_secret);
      toast("Saved.");
    } catch (e) { toast(e.message, true); }
  };
  if (!s) return <Spinner />;
  return (
    <div className="card">
      <h2>Send finished calls to your own system</h2>
      <p className="hint"><b>In plain words:</b> when a call ends, Kaho AI can send its result straight to your own software, such as your CRM or a spreadsheet tool,
        so nobody has to copy it across by hand. This is called a <i>webhook</i>.</p>
      <ol className="steps">
        <li>Ask whoever looks after your software for a <b>web address</b> that can receive calls (it starts with https://).</li>
        <li>Paste it below and press Save. We will then send it the summary and every answer the agent saved, such as a payment date or a yes or no.</li>
        <li>Each message is signed with a <b>secret</b>, a private password, so your system can tell it really came from us. Give the secret to the same person.</li>
      </ol>
      <p className="hint">Not using one? Leave it empty. Nothing else depends on it.</p>
      <div className="field"><label className="f" htmlFor="wh-url">Web address</label>
        <input id="wh-url" value={url} disabled={!editable} placeholder="https://yourcompany.com/kaho/calls" onChange={(e) => setUrl(e.target.value)} /></div>
      {!editable && s.webhook_configured && <p className="hint">A webhook is set up. Only people who manage the organization can see its address.</p>}
      {secret && (
        <div className="notice"><b>Your signing secret</b> (shown once, copy it now)
          <code className="secret">{secret}</code></div>
      )}
      {s.webhook_secret_set && !secret && <p className="hint">A signing secret is set. You can make a new one if it was lost; the old one stops working.</p>}
      {editable && (
        <div className="actions">
          <button className="primary" onClick={() => save({ webhook_url: url.trim() || null })}>Save</button>
          {s.webhook_secret_set && <button className="ghost" onClick={() => save({ rotate_webhook_secret: true })}>Make a new secret</button>}
          {s.webhook_url && <button className="ghost" onClick={() => { save({ webhook_url: null }); setSecret(null); }}>Turn off</button>}
        </div>
      )}
    </div>
  );
}
