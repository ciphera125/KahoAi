// The frame around every signed-in admin screen: the sidebar, who is signed in, the theme switch.
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { get } from "./api.js";
import { startPolling } from "../../frontend/src/poll.js";
import { whenShort } from "../../frontend/src/ui.jsx";
import { LogoMark, Wordmark } from "../../frontend/src/logo.jsx";
import { Avatar, ErrorBoundary, Icon } from "../../frontend/src/ui.jsx";
import { useAdmin } from "./auth.jsx";
import { NAV } from "./nav.js";

const THEME_KEY = "kaho.theme";
const isDarkNow = () => {
  const set = document.documentElement.dataset.theme;
  if (set) return set === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
};

function ThemeToggle() {
  const [dark, setDark] = useState(isDarkNow);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private window */ }
    setDark(!dark);
  };
  return <button type="button" className="icon-btn" title={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}><Icon name={dark ? "sun" : "moon"} /></button>;
}

/** Everything waiting for a decision: requests and top-ups. The number shows on the bell; click for the list. */
function Notifications() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const load = () => get("/notifications?per_page=10").then(setD).catch(() => {});
  useEffect(() => { load(); const stop = startPolling(load, 30000); window.addEventListener("kaho:admin-changed", load); return () => { stop(); window.removeEventListener("kaho:admin-changed", load); }; }, []);
  useEffect(() => { setOpen(false); load(); }, [pathname]);
  const total = d?.total ?? 0;
  return (
    <div className="notif-wrap">
      <button type="button" className={`icon-btn bell${total ? " has" : ""}`} aria-label={total ? `${total} waiting for you` : "Nothing waiting"} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />{total > 0 && <span className="bell-count">{total > 99 ? "99+" : total}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Waiting for you">
          <div className="notif-head"><b>Waiting for you</b><span className="muted">{total} open</span></div>
          {!d || d.items.length === 0 ? <p className="hint" style={{ padding: "var(--s4)" }}>Nothing is waiting. New requests and top-ups appear here.</p> : (
            <ul>{d.items.map((i) => (
              <li key={`${i.kind}${i.id}`}><Link to={i.link}><span className={`pill ${i.kind === "topup" ? "live" : i.kind === "plan_change" ? "warn" : "active"}`}>{i.kind === "topup" ? "Top-up" : i.kind === "plan_change" ? "Plan change" : "Message"}</span>
                <b>{i.org_name}</b><span className="muted">{i.text}</span><span className="muted">{whenShort(i.at)}</span></Link></li>))}</ul>
          )}
          <Link to="/requests" className="notif-foot">Open all requests</Link>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { admin, signOut } = useAdmin();
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { setDrawer(false); }, [pathname]);
  return (
    <div className="shell admin rail-pinned rail-wide">
      {drawer && <div className="rail-scrim" onClick={() => setDrawer(false)} />}
      <nav className={`rail${drawer ? " open" : ""}`} aria-label="Admin sections">
        <div className="logo">
          <LogoMark size={36} />
          <div className="rail-text brand"><b><Wordmark /></b><span className="muted">Admin</span></div>
          <button type="button" className="icon-btn drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu"><Icon name="x" /></button>
        </div>
        <div className="rail-scroll">
          {NAV.map(([group, items]) => (
            <div key={group} className="nav-section">
              <div className="nav-group"><span className="rail-text">{group}</span></div>
              {items.map(([path, icon, label]) => (
                <NavLink key={path} to={`/${path}`} className="nav-item">
                  <span className="nav-icon"><Icon name={icon} /></span><span className="rail-text">{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        <div className="me" style={{ cursor: "default" }}>
          <Avatar name={admin.name} />
          <div className="rail-text who"><b className="ellip me-name">{admin.name}</b><span className="muted">{admin.email}</span></div>
        </div>
        <button type="button" className="ghost" onClick={signOut}><Icon name="out" />Sign out</button>
      </nav>
      <main className="wrap">
        <div className="inner">
          <div className="topbar">
            <button type="button" className="icon-btn menu-btn" onClick={() => setDrawer(true)} aria-label="Open menu"><Icon name="menu" /></button>
            <span className="topbar-brand"><LogoMark size={30} waves={false} /><Wordmark /></span>
            <span className="grow" />
            <Notifications />
            <ThemeToggle />
          </div>
          <ErrorBoundary resetKey={pathname}><Outlet /></ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
