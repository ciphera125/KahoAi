// Small shared pieces: icons, toast, modal, confirm, a dropdown menu, and a few
// formatters. Kept together so the pages stay about their own screen.
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "motion/react";
import { pageNumbers, paginate, SIZES } from "./paginate.js";

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
  check: "M20 6 9 17l-5-5", plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4", eye: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  back: "M15 18l-6-6 6-6", panel: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18",
  updown: "M7 15l5 5 5-5M7 9l5-5 5 5", chevron: "M9 18l6-6-6-6", menu: "M4 6h16M4 12h16M4 18h16",
  upload: "M12 15V3M7 8l5-5 5 5M5 21h14", bulk: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  out: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9", clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  live: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.7 6.7a2.1 2.1 0 0 1-3-3l6.7-6.7a6 6 0 0 1 7.9-7.9z",
  tag: "M20.6 9.8l-8.4-8.4a2 2 0 0 0-1.4-.6H4a2 2 0 0 0-2 2v6.8a2 2 0 0 0 .6 1.4l8.4 8.4a2 2 0 0 0 2.8 0l6.8-6.8a2 2 0 0 0 0-2.8zM7 7h.01",
  warn: "M10.3 2.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  settings: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4l2 2",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  mic: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v4", play: "M6 4l14 8-14 8z", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
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

/** A primary-button dropdown (same panel as Menu, a labeled trigger instead
 * of the triple-dot) — for "+ Add X" buttons that need to offer a choice. */
export function DropdownButton({ label, icon, items }) {
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
      <button type="button" className="primary" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        {icon && <Icon name={icon} />}{label}
      </button>
      {open && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          {items.filter(Boolean).map(([itemLabel, fn, bad], i) => (
            <button key={i} type="button" className={bad ? "bad" : ""} onClick={() => { setOpen(false); fn(); }}>{itemLabel}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- modal + confirm ---------- */
export function Modal({ title, onClose, wide, children }) {
  // Radix Dialog gives focus trapping, Escape and screen-reader roles; motion gives the entrance.
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Content asChild aria-describedby={undefined}>
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}
            onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <motion.div className={`modal${wide ? " wide" : ""}`} initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}>
              <div className="card-head" style={{ marginBottom: "var(--s2)" }}>
                <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
                <Dialog.Close asChild><button type="button" className="icon-btn" title="Close"><Icon name="x" /></button></Dialog.Close>
              </div>
              {children}
            </motion.div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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

/* ---------- paging ---------- */
/** The footer of a list: where you are, and the way to other pages. Always shows the
 * count, so a short list still says how many there are; the buttons appear when there is
 * more than one page. */
export function Pager({ view, size, onPage, onSize }) {
  const { page, pages, total, from, to } = view;
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted">{total === 0 ? "Nothing to show" : `Showing ${from} to ${to} of ${total}`}</span>
      {pages > 1 && (
        <div className="pager-buttons">
          <button type="button" className="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
          {pageNumbers(page, pages).map((n, i) => (n === "…"
            ? <span key={`gap${i}`} className="muted">…</span>
            : <button key={n} type="button" className={`ghost${n === page ? " on" : ""}`} aria-current={n === page ? "page" : undefined}
              onClick={() => onPage(n)}>{n}</button>))}
          <button type="button" className="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
        </div>
      )}
      {onSize && total > SIZES[0] && (
        <label className="pager-size muted">Per page
          <select value={size} onChange={(e) => onSize(Number(e.target.value))}>
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </nav>
  );
}

/** Cut a list into pages. Returns [the items on this page, the footer to show under
 * them]. A page that stops existing (the last item on it was deleted) steps back by itself. */
export function usePaged(items, initialSize = 10) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  const view = paginate(items, page, size);
  useEffect(() => { if (view.page !== page) setPage(view.page); }, [view.page, page]);
  const footer = <Pager view={view} size={size} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />;
  return [view.items, footer];
}

/* ---------- a page that breaks should say so, not go blank ---------- */
/** Catches a crash in whatever is inside it. Without this, one bad value in one page
 * unmounts the whole app and the person is left looking at nothing (2026-11-08: the Tasks
 * page, on Add a task). Changing page (`resetKey`) clears it. */
export class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error("A page crashed:", error); }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card" style={{ maxWidth: 560, margin: "var(--s6) auto" }}>
        <h2>Something went wrong on this page</h2>
        <p className="sub">The rest of the Studio is fine. Try again, and if it keeps happening, tell us what you pressed.</p>
        <div className="actions"><button className="primary" onClick={() => this.setState({ failed: false })}>Try again</button>
          <button className="ghost" onClick={() => window.location.reload()}>Reload the page</button></div>
      </div>
    );
  }
}
