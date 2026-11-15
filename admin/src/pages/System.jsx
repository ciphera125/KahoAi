// The platform's own health: the database, its connections, the model and Storage, each tried for real.
import { useCallback, useEffect, useState } from "react";
import { get } from "../api.js";
import { Icon, Spinner, useToast } from "../../../frontend/src/ui.jsx";
import { Head } from "../parts.jsx";

export default function System() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    try { setD(await get("/health")); } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  }, [toast]);
  useEffect(() => { run(); }, [run]);
  const bad = d ? d.checks.filter((c) => !c.ok).length : 0;
  return (
    <section>
      <Head title="System" sub="The parts the whole platform depends on, tried for real just now.">
        <button type="button" className="ghost" disabled={busy} onClick={run}><Icon name="refresh" />{busy ? "Checking…" : "Check again"}</button>
      </Head>
      {!d ? <Spinner /> : (
        <div className="stack">
          <div className={`card health-banner ${bad ? "bad" : "ok"}`}><b>{bad ? `${bad} ${bad === 1 ? "thing needs" : "things need"} attention` : "Everything is working"}</b></div>
          <div className="card list">
            {d.checks.map((c) => (
              <div key={c.id} className="health-row"><span className={`health-dot ${c.ok ? "ok" : "bad"}`} aria-hidden="true" />
                <div className="health-text"><b>{c.label}</b><div className="hint">{c.detail}</div></div>
                <span className={`pill ${c.ok ? "live" : "failed"}`}>{c.ok ? "Working" : "Needs attention"}</span></div>
            ))}
          </div>
          {d.warnings.length > 0 && (
            <div className="card explain"><b>Before real customers</b><ul className="plain">{d.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
          )}
        </div>
      )}
    </section>
  );
}
