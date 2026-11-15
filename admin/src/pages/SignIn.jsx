// The admin site's own sign-in and sign-up. Only the two e-mail addresses Kaho named can ever make an account,
// and only with the setup code; the page says no more than the server does about why a try failed.
import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { useAdmin } from "../auth.jsx";
import { LogoMark, Wordmark } from "../../../frontend/src/logo.jsx";
import { PasswordInput, useToast } from "../../../frontend/src/ui.jsx";

/** What it means when the backend cannot answer the admin site, so a person is not left reading "closed" for "broken". */
export function backendProblem(e) {
  if (e.status === 0) return "The admin service cannot be reached. Start the backend, then reload this page.";
  if (e.status === 403 || e.status === 404) {
    return "The backend is running, but without the admin service: it is an older version. Restart the backend with the latest code, then reload this page.";
  }
  return `The admin service did not answer properly (${e.message}). Check the backend, then reload this page.`;
}

export default function SignIn() {
  const { setAdmin } = useAdmin();
  const toast = useToast();
  const [mode, setMode] = useState("in");
  const [open, setOpen] = useState(false);
  const [unreachable, setUnreachable] = useState(null); // why the backend could not be asked, in words
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: "", email: "", password: "", code: "" });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => { setF((v) => ({ ...v, [k]: e.target.value })); setErr(null); };
  useEffect(() => {
    get("/auth/state").then((s) => { setOpen(Boolean(s.signup_open)); setUnreachable(null); })
      .catch((e) => setUnreachable(backendProblem(e)));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      setAdmin(mode === "in" ? await post("/auth/login", { email: f.email, password: f.password })
        : await post("/auth/signup", { name: f.name, email: f.email, password: f.password, code: f.code }));
    } catch (ex) { setErr(ex.message); toast(ex.message, true); } finally { setBusy(false); }
  };

  return (
    <div className="auth">
      <div className="card auth-card">
        <div className="logo" style={{ marginBottom: "var(--s5)" }}><LogoMark size={48} /><b><Wordmark /> <span className="studio-tag admin-tag">Admin</span></b></div>
        <h1>{mode === "in" ? "Admin sign-in" : "Create your admin account"}</h1>
        <div className="sub">{mode === "in" ? "For Kaho AI staff only." : "Only Kaho AI staff named by the platform owner can do this, with the setup code."}</div>
        <div className="tabs" role="tablist">
          <button type="button" className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setErr(null); }}>Sign in</button>
          <button type="button" className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setErr(null); }} disabled={!open} title={open ? "" : "Admin sign-up is closed"}>Create account</button>
        </div>
        <form onSubmit={submit} autoComplete="on">
          {mode === "up" && (
            <div className="field"><label className="f" htmlFor="ad-name">Your name</label>
              <input id="ad-name" value={f.name} onChange={set("name")} autoComplete="name" required maxLength={80} /></div>
          )}
          <div className="field"><label className="f" htmlFor="ad-email">E-mail</label>
            <input id="ad-email" type="email" value={f.email} onChange={set("email")} autoComplete="email" required /></div>
          <div className="field"><label className="f" htmlFor="ad-pass">Password</label>
            <PasswordInput id="ad-pass" value={f.password} onChange={set("password")} autoComplete={mode === "in" ? "current-password" : "new-password"}
              placeholder={mode === "up" ? "At least 12 characters" : ""} required /></div>
          {mode === "up" && (
            <div className="field"><label className="f" htmlFor="ad-code">Setup code</label>
              <PasswordInput id="ad-code" value={f.code} onChange={set("code")} autoComplete="off" required />
              <span className="hint">From the person who runs the server (ADMIN_SIGNUP_CODE).</span></div>
          )}
          {err && <p className="field-err" role="alert">{err}</p>}
          <div className="actions">
            <button type="submit" className="primary xl" style={{ width: "100%" }} disabled={busy}>
              {busy && <span className="spinner btn-spinner" />}{mode === "in" ? "Sign in" : "Create admin account"}
            </button>
          </div>
        </form>
        {unreachable && <p className="field-err" role="alert" style={{ marginTop: "var(--s4)" }}>{unreachable}</p>}
        {!unreachable && !open && <p className="hint" style={{ marginTop: "var(--s4)" }}>Admin sign-up is closed.</p>}
      </div>
    </div>
  );
}
