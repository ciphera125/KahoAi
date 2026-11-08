import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { can, isAdmin, useMe } from "../auth.jsx";
import { Icon, Spinner, useConfirm, useToast } from "../ui.jsx";

const TABS = [["organization", "Organization"], ["calls", "Call rules"], ["roles", "Roles and access"], ["keys", "API keys"],
  ["webhook", "Call webhook"]];

export default function Settings() {
  const me = useMe();
  const [tab, setTab] = useState("organization");
  return (
    <section>
      <header className="page">
        <div><h1>Settings</h1>
          <div className="sub">The rules for your whole organization: who can do what, when calls may be made, and how other systems connect.</div></div>
      </header>
      <div className="seg" style={{ marginBottom: "var(--s4)" }}>
        {TABS.filter(([id]) => id !== "keys" || can(me, "keys.manage")).map(([id, label]) =>
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "organization" && <Organization />}
      {tab === "calls" && <CallRules />}
      {tab === "roles" && <Roles />}
      {tab === "webhook" && <Webhook />}
      {tab === "keys" && <ApiKeys />}
    </section>
  );
}

function Organization() {
  const me = useMe();
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [roles, setRoles] = useState(null);
  useEffect(() => {
    get("/api/settings").then(setSettings).catch((e) => toast(e.message, true));
    get("/api/roles").then(setRoles).catch(() => {});
  }, [toast]);
  if (!settings) return <Spinner />;
  const mine = roles?.roles.find((r) => r.id === me.role);
  return (
    <>
      <div className="card" style={{ maxWidth: 680 }}>
        <h2 style={{ margin: "0 0 var(--s3)" }}>Organization</h2>
        <dl className="settings-grid">
          <dt>Name</dt><dd>{me.org_name}</dd>
          <dt>Your role</dt><dd><b>{mine?.label ?? me.role}</b><div className="hint">{mine?.summary}</div></dd>
        </dl>
      </div>
      <div className="card" style={{ maxWidth: 680, marginTop: "var(--s4)" }}>
        <h2 style={{ margin: "0 0 var(--s3)" }}>Phone</h2>
        <dl className="settings-grid">
          <dt>Our number</dt><dd>{settings.our_number || <span className="muted">Not configured</span>}</dd>
        </dl>
      </div>
      <div className="card" style={{ maxWidth: 680, marginTop: "var(--s4)" }}>
        <h2 style={{ margin: "0 0 var(--s3)" }}>Limits of this server</h2>
        <dl className="settings-grid">
          <dt>Longest possible call</dt><dd>{settings.limits.max_minutes} minutes</dd>
          <dt>Ring time choices</dt><dd>{settings.limits.ring_secs.join(" to ")} seconds</dd>
          <dt>Longest prompt</dt><dd>{settings.max_chars.toLocaleString()} characters</dd>
        </dl>
      </div>
    </>
  );
}

/** The admin's rules for every call in the organization, whatever an agent is set to. */
function CallRules() {
  const me = useMe();
  const toast = useToast();
  const editable = can(me, "org.settings");
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get("/api/org/settings").then(setS).catch((e) => toast(e.message, true)); }, [toast]);
  if (!s) return <Spinner />;
  const w = s.call_window;
  const setWindow = (patchIn) => setS((x) => ({ ...x, call_window: { ...x.call_window, ...patchIn } }));
  const save = async () => {
    setBusy(true);
    try {
      const next = await patch("/api/org/settings", { max_minutes: s.max_minutes === "" || s.max_minutes === null ? null : Number(s.max_minutes),
        call_window: w });
      setS(next); toast("Saved. It applies to the next call.");
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ maxWidth: 680 }}>
      <h2 style={{ margin: "0 0 var(--s2)" }}>Call rules for everyone</h2>
      <p className="hint" style={{ marginBottom: "var(--s4)" }}>
        These hold for every agent and every call in {me.org_name}, whatever an individual agent is set to.
        {!editable && " Only an owner or admin can change them."}</p>

      <div className="toggle-line">
        <div><b>Only call during certain hours</b>
          <div className="hint">Calls outside these hours are refused, and bulk calls wait until they open. TRAI allows commercial calls 09:00 to 21:00.</div></div>
        <label className="switch"><input type="checkbox" checked={w.enabled} disabled={!editable} onChange={(e) => setWindow({ enabled: e.target.checked })} /><span /></label>
      </div>
      <div className="grid-2">
        <div className="field"><label className="f">From</label><input type="time" value={w.start} disabled={!editable || !w.enabled} onChange={(e) => setWindow({ start: e.target.value })} /></div>
        <div className="field"><label className="f">To</label><input type="time" value={w.end} disabled={!editable || !w.enabled} onChange={(e) => setWindow({ end: e.target.value })} /></div>
      </div>
      <div className="field"><label className="f">Time zone</label>
        <input value={w.timezone} disabled={!editable || !w.enabled} onChange={(e) => setWindow({ timezone: e.target.value })} placeholder="Asia/Kolkata" /></div>

      <div className="field"><label className="f">Longest any call can be (minutes)</label>
        <input type="number" min={1} max={30} value={s.max_minutes ?? ""} disabled={!editable} placeholder="No limit"
          onChange={(e) => setS((x) => ({ ...x, max_minutes: e.target.value }))} />
        <span className="hint">A call is ended at this length even if an agent allows longer. Leave empty for no extra limit.</span></div>

      {editable && <div className="actions"><button className="primary" onClick={save} disabled={busy}>Save call rules</button></div>}
    </div>
  );
}

/** What each role may do. Printed from the table the server enforces, so it cannot drift from it. */
function Roles() {
  const me = useMe();
  const toast = useToast();
  const [data, setData] = useState(null);
  useEffect(() => { get("/api/roles").then(setData).catch((e) => toast(e.message, true)); }, [toast]);
  if (!data) return <Spinner />;
  const groups = [...new Set(data.permissions.map((p) => p.group))];
  return (
    <>
      <p className="hint" style={{ marginBottom: "var(--s4)", maxWidth: 760 }}>
        Whoever creates an organization is its <b>owner</b>. They make admins, and give everyone else one of the other roles on the Team page.
        Someone who joins with an invite code can only look until they are given a role. You are a <b>{data.roles.find((r) => r.id === me.role)?.label}</b>.</p>
      <div className="role-cards">
        {data.roles.map((r) => (
          <div key={r.id} className={`card role-card${r.id === me.role ? " mine" : ""}`}>
            <b>{r.label}{r.id === me.role && <span className="pill active" style={{ marginLeft: 8 }}>You</span>}</b>
            <p className="hint">{r.summary}</p>
          </div>
        ))}
      </div>
      <div className="card" style={{ overflowX: "auto" }}>
        <table className="matrix">
          <thead>
            <tr><th>What it lets someone do</th>{data.roles.map((r) => <th key={r.id} className={r.id === me.role ? "mine" : ""}>{r.label}</th>)}</tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <FragmentGroup key={g} group={g} perms={data.permissions.filter((p) => p.group === g)} roles={data.roles} mine={me.role} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FragmentGroup({ group, perms, roles, mine }) {
  return (
    <>
      <tr className="group"><td colSpan={roles.length + 1}>{group}</td></tr>
      {perms.map((p) => (
        <tr key={p.id}>
          <td>{p.label}</td>
          {roles.map((r) => (
            <td key={r.id} className={r.id === mine ? "mine" : ""}>
              {r.permissions.includes(p.id) ? <span className="yes" aria-label="Yes"><Icon name="check" /></span> : <span className="no" aria-label="No">-</span>}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Keys another system uses to push tasks in. Shown once, then only by their first few
 * characters: we keep a hash, so nobody here can read one back out. */
function ApiKeys() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [keys, setKeys] = useState(null);
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

function Webhook() {
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
      <p className="hint">When a call ends, Kaho AI sends the summary and every answer the agent saved (a payment date, an amount, a yes or no) to the web address below,
        so your system updates without anyone copying anything. Each message is signed with a secret so your system can tell it really came from us.</p>
      <div className="field"><label className="f" htmlFor="wh-url">Web address</label>
        <input id="wh-url" value={url} disabled={!editable} placeholder="https://yourcompany.com/kaho/calls" onChange={(e) => setUrl(e.target.value)} /></div>
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
