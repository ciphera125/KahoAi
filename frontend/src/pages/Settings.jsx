import { useEffect, useState } from "react";
import { get } from "../api.js";
import { useMe } from "../auth.jsx";
import { Spinner, useToast } from "../ui.jsx";

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
    </section>
  );
}
