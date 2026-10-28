// Sign in, or create an account. Creating one without an invite starts a new
// organization (you are its owner); with an invite you join that organization.
import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { useAuth } from "../auth.jsx";
import { PasswordInput, useToast } from "../ui.jsx";

const ERR_FIELDS = {
  name: /name/i, email: /email/i, password: /password/i,
  organization: /organization/i, invite: /invite/i,
};

function fieldFor(msg) {
  for (const [k, re] of Object.entries(ERR_FIELDS)) if (re.test(msg)) return k;
  return null;
}

export default function SignIn() {
  const { setMe } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState("in");
  const [hasAccounts, setHasAccounts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState({});
  const [f, setF] = useState({ name: "", organization: "", email: "", password: "", invite: "" });
  const set = (k) => (e) => { setF((v) => ({ ...v, [k]: e.target.value })); setFieldErr((v) => ({ ...v, [k]: null })); };

  useEffect(() => { get("/api/auth/state").then((s) => { setHasAccounts(s.has_accounts); if (!s.has_accounts) setMode("up"); }).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setFieldErr({});
    setBusy(true);
    try {
      if (mode === "in") await post("/api/auth/login", { email: f.email, password: f.password });
      else await post("/api/auth/signup", { name: f.name, organization: f.organization || undefined, email: f.email, password: f.password, invite: f.invite || undefined });
      setMe(await get("/api/me"));
    } catch (err) {
      const field = fieldFor(err.message);
      if (field) setFieldErr({ [field]: err.message });
      else toast(err.message, true);
    } finally { setBusy(false); }
  };

  const err = (k) => fieldErr[k] ? "err" : "";
  const joining = mode === "up" && !!f.invite;
  return (
    <div className="auth">
      <div className="card auth-card">
        <div className="logo" style={{ marginBottom: "var(--s5)" }}><div className="mark">K</div><b>Kaho AI Studio</b></div>
        <h1>{mode === "in" ? "Welcome back" : joining ? "Join your team" : "Create your organization"}</h1>
        <div className="sub">{mode === "in" ? "Sign in to run your calling agents." : joining ? "You have an invite code from your team." : "You will be its owner. Invite your team after."}</div>
        <div className="tabs" role="tablist">
          <button type="button" className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setFieldErr({}); }}>Sign in</button>
          <button type="button" className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setFieldErr({}); }}>Create account</button>
        </div>
        <form onSubmit={submit} autoComplete="on">
          {mode === "up" && (
            <>
              <div className="field">
                <label className="f">Your name</label>
                <input className={err("name")} value={f.name} onChange={set("name")} autoComplete="name" placeholder="Asha Rao" required />
                {fieldErr.name && <span className="field-err">{fieldErr.name}</span>}
              </div>
              <div className="field">
                <label className="f">Invite code <span className="muted">(optional)</span></label>
                <input className={err("invite")} value={f.invite} onChange={set("invite")} placeholder="If your team gave you one" autoComplete="off" />
                {fieldErr.invite && <span className="field-err">{fieldErr.invite}</span>}
              </div>
              {!joining && <div className="field">
                <label className="f">Organization name</label>
                <input className={err("organization")} value={f.organization} onChange={set("organization")} placeholder="Acme Finance" required />
                {fieldErr.organization && <span className="field-err">{fieldErr.organization}</span>}
              </div>}
            </>
          )}
          <div className="field">
            <label className="f">Email</label>
            <input className={err("email")} type="email" value={f.email} onChange={set("email")} autoComplete="email" placeholder="you@company.com" required />
            {fieldErr.email && <span className="field-err">{fieldErr.email}</span>}
          </div>
          <div className="field">
            <label className="f">Password</label>
            <PasswordInput className={err("password")} value={f.password} onChange={set("password")} autoComplete={mode === "in" ? "current-password" : "new-password"} placeholder="At least 8 characters" required />
            {fieldErr.password && <span className="field-err">{fieldErr.password}</span>}
          </div>
          <div className="actions">
            <button type="submit" className="primary xl" style={{ width: "100%" }} disabled={busy}>
              {busy && <span className="spinner btn-spinner" />}
              {mode === "in" ? "Sign in" : joining ? "Join" : "Create organization"}
            </button>
          </div>
        </form>
        {mode === "up" && !hasAccounts && <p className="hint" style={{ marginTop: "var(--s4)" }}>This is the first account on this server.</p>}
      </div>
    </div>
  );
}
