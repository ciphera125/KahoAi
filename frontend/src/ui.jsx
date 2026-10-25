// Small shared pieces: icons, toast, modal, confirm, a dropdown menu, and a few
// formatters. Kept together so the pages stay about their own screen.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ---------- icons (same set as the original Studio) ---------- */
const PATHS = {
  dash: "M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z",
  call: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  contacts: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  agent: "M4 8h16v12H4zM12 4v4M9 13h.01M15 13h.01M9 17h6",
  prompt: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  numbers: "M5 9h14M5 15h14M10 3 8 21M16 3l-2 18",
  team: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  plus: "M12 5v14M5 12h14", dots: "M5 12h.01M12 12h.01M19 12h.01", x: "M18 6 6 18M6 6l12 12",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6", download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  check: "M20 6 9 17l-5-5", eye: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  back: "M15 18l-6-6 6-6", panel: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18",
  updown: "M7 15l5 5 5-5M7 9l5-5 5 5", chevron: "M9 18l6-6-6-6", menu: "M4 6h16M4 12h16M4 18h16",
  upload: "M12 15V3M7 8l5-5 5 5M5 21h14", bulk: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  out: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9", clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
};
export const Icon = ({ name, ...rest }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true" {...rest}>
    {PATHS[name].split("M").filter(Boolean).map((d, i) => <path key={i} d={"M" + d} />)}
  </svg>
);

/* ---------- formatters ---------- */
export const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
export const plural = (n, w) => `${(n ?? 0).toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
export const fmtDur = (s) => (s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`);
export const fmtTalk = (s) => (!s ? "0s" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
export function whenShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
export function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return whenShort(iso);
}
export const OUTCOME = { answered: "Picked up", no_answer: "No answer", declined: "Declined", failed: "Failed", ringing: "Ringing", unknown: "Unknown" };
export const OutcomePill = ({ status }) => <span className={`pill ${status || "unknown"}`}>{OUTCOME[status] || "Unknown"}</span>;

/* ---------- toast ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef();
  const show = useCallback((text, isError) => {
    setToast({ text, isError });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast${toast.isError ? " err" : ""}`} role="status">{toast.text}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------- dropdown menu (the triple-dot) ---------- */
export function Menu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="icon-btn" title="More" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <Icon name="dots" />
      </button>
      {open && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          {items.filter(Boolean).map(([label, fn, bad], i) => (
            <button key={i} type="button" className={bad ? "bad" : ""} onClick={() => { setOpen(false); fn(); }}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- modal + confirm ---------- */
export function Modal({ title, onClose, wide, children }) {
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  // Drawn on <body>, so a dialog opened from inside the sidebar is not clipped or styled by it.
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="card-head" style={{ marginBottom: "var(--s2)" }}>
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function useConfirm() {
  const [state, setState] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const node = state && (
    <Modal title={state.title} onClose={() => { state.resolve(false); setState(null); }}>
      <p className="sub">{state.text}</p>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ghost" onClick={() => { state.resolve(false); setState(null); }}>Cancel</button>
        <button type="button" className="danger" onClick={() => { state.resolve(true); setState(null); }}>{state.ok || "Confirm"}</button>
      </div>
    </Modal>
  );
  return [ask, node];
}

/* ---------- misc ---------- */
export const Spinner = () => <div className="center"><div className="spinner" /></div>;
export function PasswordInput(props) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input {...props} type={show ? "text" : "password"} style={{ paddingRight: 40 }} />
      <button type="button" className="icon-btn" style={{ position: "absolute", right: 3, top: 3 }} onClick={() => setShow((v) => !v)} title="Show"><Icon name="eye" /></button>
    </div>
  );
}
