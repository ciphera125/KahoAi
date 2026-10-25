// The frame around every signed-in screen: the sidebar (real links), the
// notifications bell and the profile menu. <Outlet/> is the current page.
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { get, post } from "../api.js";
import { useAuth } from "../auth.jsx";
import { ago, Icon, initials, Modal, PasswordInput, useToast } from "../ui.jsx";

const NAV = [
  ["Operate", [["dashboard", "dash", "Dashboard"], ["calls", "call", "Calls"], ["contacts", "contacts", "Contacts"]]],
  ["Configure", [["agents", "agent", "Agents"], ["prompts", "prompt", "Prompts"], ["numbers", "numbers", "Numbers"], ["team", "team", "Team"]]],
];

export default function Layout() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(false);
  return (
    <div className="shell">
      <nav className={`rail${open ? " open" : ""}`} aria-label="Sections">
        <div className="logo">
          <div className="mark">K</div>
          <div><b>Kaho AI Studio</b><small className="ellip">{me.org_name}</small></div>
        </div>
        {NAV.map(([group, items]) => (
          <div key={group}>
            <div className="nav-group">{group}</div>
            {items.map(([path, icon, label]) => (
              <NavLink key={path} to={`/${path}`} className="nav-item" onClick={() => setOpen(false)}>
                <Icon name={icon} /><span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
        <button type="button" className="me" onClick={() => setProfile(true)}>
          <div className="avatar">{initials(me.name)}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }} className="ellip">{me.name}</div>
            <div className="muted ellip role">{me.role}</div>
          </div>
        </button>
      </nav>
      <main className="wrap">
        <div className="inner">
          <div className="topbar">
            <button type="button" className="icon-btn" style={{ marginRight: "auto" }} onClick={() => setOpen((v) => !v)} aria-label="Menu" hidden={window.innerWidth > 860}><Icon name="dots" /></button>
            <Bell />
          </div>
          <Outlet />
        </div>
      </main>
      {profile && <Profile onClose={() => setProfile(false)} onSignOut={signOut} />}
    </div>
  );
}

function Bell() {
  const [feed, setFeed] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const load = useCallback(() => get("/api/notifications").then(setFeed).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const markRead = async () => { await post("/api/notifications/seen").catch(() => {}); load(); };
  const openItem = (n) => {
    setOpen(false);
    if (n.view) navigate(`/${n.view}`);
  };
  return (
    <div className="menu-wrap">
      <button type="button" className="icon-btn" title="Notifications" onClick={() => setOpen((v) => !v)} style={{ position: "relative" }}>
        <Icon name="bell" />
        {feed.unread > 0 && <span style={{ position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, font: "600 10px/16px var(--mono)", color: "#fff", background: "var(--bad)" }}>{feed.unread > 9 ? "9+" : feed.unread}</span>}
      </button>
      {open && (
        <div className="menu" style={{ width: 340, maxHeight: "70vh", overflow: "auto", padding: 0 }} onClick={(e) => e.stopPropagation()}>
          <div className="card-head" style={{ padding: "var(--s3) var(--s4)", margin: 0, borderBottom: "1px solid var(--border)" }}>
            <b>Notifications</b>
            {feed.unread > 0 && <button type="button" className="link small-btn" onClick={markRead}>Mark all read</button>}
          </div>
          {feed.items.length === 0 && <div className="empty" style={{ padding: "var(--s6)" }}>Nothing yet.</div>}
          {feed.items.map((n) => (
            <button key={n.id} type="button" className="nav-item" style={{ width: "100%", height: "auto", padding: "var(--s3) var(--s4)", textAlign: "left", display: "block", borderRadius: 0 }} onClick={() => openItem(n)}>
              <div>{n.text}</div>
              <div className="muted" style={{ marginTop: 2 }}>{[n.actor, ago(n.at)].filter(Boolean).join(" · ")}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Profile({ onClose, onSignOut }) {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [invite, setInvite] = useState(null);
  useEffect(() => { get("/api/me").then((m) => setInvite(m.invite_code ? { code: m.invite_code, expires: m.invite_expires } : null)).catch(() => {}); }, []);
  const changePassword = async () => {
    try { await post("/api/auth/password", { current: cur, new: next }); await refresh(); toast("Password changed."); setChanging(false); setCur(""); setNext(""); }
    catch (e) { toast(e.message, true); }
  };
  const newInvite = async () => {
    try { const r = await post("/api/auth/invite"); setInvite({ code: r.invite_code, expires: r.invite_expires }); toast("New invite code. The old one no longer works."); }
    catch (e) { toast(e.message, true); }
  };
  return (
    <Modal title={me.name} onClose={onClose} wide>
      <div className="muted role" style={{ marginBottom: "var(--s4)" }}>{me.role} · {me.org_name} · {me.email}</div>
      {invite && (
        <div className="card" style={{ marginBottom: "var(--s4)" }}>
          <div className="f" style={{ marginBottom: 8 }}>Invite a teammate</div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="code" style={{ padding: "3px 8px", borderRadius: 4, background: "var(--surface-2)", border: "1px solid var(--border)" }}>{invite.code}</span>
            <button type="button" className="ghost small-btn" onClick={newInvite}>New code</button>
            <span className="hint">Works once, for a week. They join {me.org_name}.</span>
          </div>
        </div>
      )}
      {changing ? (
        <div className="card">
          <div className="field"><label className="f">Current password</label><PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} /></div>
          <div className="field"><label className="f">New password</label><PasswordInput value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 8 characters" /></div>
          <div className="actions"><button className="primary" onClick={changePassword}>Change password</button><button className="ghost" onClick={() => setChanging(false)}>Cancel</button></div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="ghost" onClick={() => setChanging(true)}>Change password</button>
          <button type="button" className="ghost" onClick={() => post("/api/auth/logout-others").then(() => toast("Signed out your other browsers.")).catch((e) => toast(e.message, true))}>Sign out other browsers</button>
          <button type="button" className="danger" onClick={onSignOut}>Sign out</button>
        </div>
      )}
    </Modal>
  );
}
