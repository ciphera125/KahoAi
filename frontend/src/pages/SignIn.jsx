// Sign in, or create an account. Creating one without an invite starts a new
// organization (you are its owner); with an invite you join that organization.
import { useEffect, useState } from "react";
import { get, post } from "../api.js";
import { useAuth } from "../auth.jsx";
import { PasswordInput, useToast } from "../ui.jsx";

export default function SignIn() {
  const { setMe } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState("in");
  const [hasAccounts, setHasAccounts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: "", organization: "", email: "", password: "", invite: "" });
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  useEffect(() => { get("/api/auth/state").then((s) => { setHasAccounts(s.has_accounts); if (!s.has_accounts) setMode("up"); }).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") await post("/api/auth/login", { email: f.email, password: f.password });
      else await post("/api/auth/signup", { name: f.name, organization: f.organization || undefined, email: f.email, password: f.password, invite: f.invite || undefined });
      setMe(await get("/api/me"));
    } catch (err) { toast(err.message, true); } finally { setBusy(false); }
  };

  const joining = mode === "up" && !!f.invite;
  return (
    <div className="auth">
      <div className="card auth-card">
        <div className="logo" style={{ marginBottom: "var(--s5)" }}><div className="mark">K</div><b>Kaho AI Studio</b></div>
        <h1>{mode === "in" ? "Welcome back" : joining ? "Join your team" : "Create your organization"}</h1>
        <div className="sub">{mode === "in" ? "Sign in to run your calling agents." : joining ? "You have an invite code from your team." : "You will be its owner. Invite your team after."}</div>
        <div className="tabs" role="tablist">
          <button type="button" className={mode === "in" ? "on" : ""} onClick={() => setMode("in")}>Sign in</button>
          <button type="button" className={mode === "up" ? "on" : ""} onClick={() => setMode("up")}>Create account</button>
        </div>
        <form onSubmit={submit} autoComplete="on">
          {mode === "up" && (
            <>
              <div className="field"><label className="f">Your name</label><input value={f.name} onChange={set("name")} autoComplete="name" placeholder="Asha Rao" required /></div>
              <div className="field"><label className="f">Invite code <span className="muted">(optional)</span></label><input value={f.invite} onChange={set("invite")} placeholder="If your team gave you one" autoComplete="off" /></div>
              {!joining && <div className="field"><label className="f">Organization name</label><input value={f.organization} onChange={set("organization")} placeholder="Acme Finance" required /></div>}
            </>
          )}
          <div className="field"><label className="f">Email</label><input type="email" value={f.email} onChange={set("email")} autoComplete="email" placeholder="you@company.com" required /></div>
          <div className="field"><label className="f">Password</label><PasswordInput value={f.password} onChange={set("password")} autoComplete={mode === "in" ? "current-password" : "new-password"} placeholder="At least 8 characters" required /></div>
          <div className="actions"><button type="submit" className="primary xl" style={{ width: "100%" }} disabled={busy}>{mode === "in" ? "Sign in" : joining ? "Join" : "Create organization"}</button></div>
        </form>
        {mode === "up" && !hasAccounts && <p className="hint" style={{ marginTop: "var(--s4)" }}>This is the first account on this server.</p>}
      </div>
    </div>
  );
}
