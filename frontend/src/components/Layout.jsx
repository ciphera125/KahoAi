// The frame around every signed-in screen: the sidebar (real links), the
// notifications bell and the profile menu. <Outlet/> is the current page.
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { get, post } from "../api.js";
import { useAuth } from "../auth.jsx";
import { ago, Icon, initials, Modal, PasswordInput, useToast } from "../ui.jsx";

const NAV = [
  ["Operate", [["dashboard", "dash", "Dashboard"], ["calls", "call", "Calls"], ["live", "live", "Live"], ["bulk", "bulk", "Bulk calls"], ["contacts", "contacts", "Contacts"]]],
  ["Configure", [["agents", "agent", "Agents"], ["prompts", "prompt", "Prompts"], ["numbers", "numbers", "Numbers"], ["team", "team", "Team"]]],
  ["Inspect", [["tool-calls", "tool", "Tool Calls"], ["tags", "tag", "Tags"], ["errors", "warn", "Error Logs"], ["settings", "settings", "Settings"]]],
];
const RAIL_KEY = "kaho.rail.open";
const readRail = () => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } };

// The sidebar stays folded to icons; moving the cursor onto it opens it over the
// page, and the panel button pins it open (remembered on this browser). On a
// phone it is a drawer behind the menu button instead.
export default function Layout() {
  const { me } = useAuth();
  const [pinned, setPinned] = useState(readRail);
  const [peek, setPeek] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [profile, setProfile] = useState(false);
  const peekTimer = useRef();
  const location = useLocation();
  useEffect(() => { setDrawer(false); setPeek(false); }, [location.pathname]);
  useEffect(() => {
    if (!drawer) return undefined;
    const esc = (e) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [drawer]);
  const togglePin = () => setPinned((v) => { try { localStorage.setItem(RAIL_KEY, v ? "0" : "1"); } catch { /* private window */ } setPeek(false); return !v; });
  const enter = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(true), 120); };
  const leave = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(false), 200); };
  const open = pinned || peek || drawer;
  return (
    <div className={`shell${pinned ? " rail-pinned" : ""}${open ? " rail-wide" : ""}${peek && !pinned ? " rail-peek" : ""}`}>
      {drawer && <div className="rail-scrim" onClick={() => setDrawer(false)} />}
      <nav className={`rail${drawer ? " open" : ""}`} aria-label="Sections" onMouseEnter={enter} onMouseLeave={leave}>
        <div className="logo">
          <div className="mark" aria-hidden="true">K</div>
          <div className="rail-text brand">
            <b>KahoAI</b>
            <OrgSwitcher />
          </div>
          <button type="button" className="icon-btn rail-pin" onClick={togglePin} aria-label={pinned ? "Unpin the sidebar" : "Keep the sidebar open"} aria-pressed={pinned} title={pinned ? "Unpin sidebar" : "Keep sidebar open"}>
            <Icon name="panel" />
          </button>
          <button type="button" className="icon-btn drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu"><Icon name="x" /></button>
        </div>
        <NavLink to="/calls" className="quick" data-label="New call"><Icon name="call" /><span className="rail-text">New call</span></NavLink>
        <div className="rail-scroll">
          {NAV.map(([group, items]) => (
            <div key={group} className="nav-section">
              <div className="nav-group"><span className="rail-text">{group}</span></div>
              {items.map(([path, icon, label]) => (
                <NavLink key={path} to={`/${path}`} className="nav-item" data-label={label}>
                  <span className="nav-icon"><Icon name={icon} /></span><span className="rail-text">{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        <button type="button" className="me" onClick={() => setProfile(true)} data-label={me.name}>
          <div className="avatar">{initials(me.name)}</div>
          <div className="rail-text" style={{ minWidth: 0 }}>
            <div className="ellip me-name">{me.name}</div>
            <div className="muted ellip role">{me.role} · {me.org_name}</div>
          </div>
        </button>
      </nav>
      <main className="wrap">
        <div className="inner">
          <div className="topbar">
            <button type="button" className="icon-btn menu-btn" onClick={() => setDrawer(true)} aria-label="Open menu"><Icon name="menu" /></button>
            <span className="topbar-brand"><span className="mark" aria-hidden="true">K</span>KahoAI</span>
            <span className="grow" />
            <Bell />
          </div>
          <Outlet />
        </div>
      </main>
      {profile && <Profile onClose={() => setProfile(false)} />}
    </div>
  );
}

/** The organization name under KahoAI: switch to another of yours, make a new
 * one (a separate environment), or join one with an invite code. */
function OrgSwitcher() {
  const { me } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [form, setForm] = useState(null); // "create" | "join"
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return undefined;
    get("/api/orgs").then(setOrgs).catch(() => {});
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // A full reload: every screen's data belongs to the organization it was loaded for.
  const land = () => window.location.assign("/dashboard");
  const switchTo = async (o) => {
    if (o.current) return setOpen(false);
    try { await post(`/api/orgs/${o.id}/switch`); land(); } catch (e) { toast(e.message, true); }
  };
  const submit = async () => {
    if (!text.trim()) return toast(form === "create" ? "Give it a name." : "Enter the invite code.", true);
    setBusy(true);
    try {
      if (form === "create") await post("/api/orgs", { name: text.trim() });
      else await post("/api/orgs/join", { invite: text.trim() });
      land();
    } catch (e) { toast(e.message, true); setBusy(false); }
  };
  return (
    <div className="org-switch" ref={ref}>
      <button type="button" className="org-name" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="ellip">{me.org_name}</span><Icon name="updown" />
      </button>
      {open && (
        <div className="menu org-menu" role="menu">
          <div className="menu-label">Your organizations</div>
          {orgs.map((o) => (
            <button type="button" key={o.id} role="menuitemradio" aria-checked={o.current} onClick={() => switchTo(o)}>
              <span className="org-row"><span className="org-dot">{initials(o.name)}</span><span className="ellip">{o.name}</span></span>
              <span className="muted role">{o.current ? <Icon name="check" /> : o.role}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button type="button" onClick={() => { setForm("create"); setText(""); setOpen(false); }}><span className="org-row"><Icon name="plus" />New organization</span></button>
          <button type="button" onClick={() => { setForm("join"); setText(""); setOpen(false); }}><span className="org-row"><Icon name="team" />Join with an invite code</span></button>
        </div>
      )}
      {form && (
        <Modal title={form === "create" ? "New organization" : "Join an organization"} onClose={() => setForm(null)}>
          <p className="sub" style={{ marginBottom: "var(--s4)" }}>{form === "create"
            ? "A separate environment with its own agents, contacts, numbers, calls and team. You are its owner; invite people to it from Team."
            : "Enter the invite code someone in that organization gave you. You join it as a member and keep your other organizations."}</p>
          <div className="field">
            <label className="f" htmlFor="org-text">{form === "create" ? "Name" : "Invite code"}</label>
            <input id="org-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus
              maxLength={form === "create" ? 80 : 100} placeholder={form === "create" ? "Acme staging" : "From your teammate"} autoComplete="off" />
          </div>
          <div className="actions" style={{ justifyContent: "flex-end" }}>
            <button className="ghost" onClick={() => setForm(null)}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy}>{form === "create" ? "Create and switch" : "Join"}</button>
          </div>
        </Modal>
      )}
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

function Profile({ onClose }) {
  const { me, refresh, signOut: onSignOut } = useAuth();
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
            <button type="button" className="ghost small-btn" onClick={() => navigator.clipboard.writeText(invite.code).then(() => toast("Invite code copied. They enter it when they create their account."), () => toast("Could not copy; select the code instead.", true))}>Copy</button>
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
