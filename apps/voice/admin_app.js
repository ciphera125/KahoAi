// Kaho AI Studio, served as /app.js so the page can forbid inline scripts (CSP).
"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const { dataset, ...rest } = props; const n = Object.assign(document.createElement(tag), rest); if (dataset) Object.assign(n.dataset, dataset); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== "" && k !== false)); return n; };
const icon = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "i"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const STATUS = { active: ["Active", "active"], incomplete: ["Needs credentials", "warn"], not_connected: ["Not connected yet", "muted"] };
const OUTCOME = { answered: "Picked up", no_answer: "No answer", declined: "Declined", failed: "Failed", ringing: "Ringing", unknown: "Unknown" };
const COLOURS = ["marigold", "plum", "orchid", "teal", "silver", "rose"];
const COLOUR_NAMES = { marigold: "Marigold", plum: "Sky", orchid: "Pink", teal: "Teal", silver: "Silver", rose: "Coral" };
const S = { me: null, cfg: { max_chars: 8000, limits: { max_minutes: 30, ring_secs: [15, 60] } }, providers: [], numbers: [], contacts: [], tags: [], agents: [], prompts: [], tools: [] };
let openContactId = null;
const isOwner = () => !!S.me && S.me.role === "owner";  // the server enforces it; this only hides what would be refused

function toast(text, isError) { const t = $("toast"); t.textContent = text; t.className = "toast show" + (isError ? " err" : ""); clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = "toast"), 3000); }
async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith("/api/auth/")) { showAuth(); throw new Error("Please sign in again."); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
function closeMenus(except) { document.querySelectorAll(".menu.open").forEach((m) => { if (m !== except) m.classList.remove("open"); }); }
document.addEventListener("click", () => closeMenus());
function toggleMenu(menu, e) { e.stopPropagation(); const open = menu.classList.contains("open"); closeMenus(); if (!open) menu.classList.add("open"); }
function menuButton(items) {
  const menu = el("div", { className: "menu" });
  for (const [text, fn, bad] of items) { const b = el("button", { type: "button", className: bad ? "bad" : "" }, text); b.onclick = (e) => { e.stopPropagation(); closeMenus(); fn(); }; menu.append(b); }
  const btn = el("button", { type: "button", className: "icon-btn", title: "More" }, icon("i-dots"));
  btn.onclick = (e) => toggleMenu(menu, e);
  return el("div", { className: "menu-wrap", onclick: (e) => e.stopPropagation() }, btn, menu);
}
function tagChip(id) { const t = S.tags.find((x) => x.id === id); if (!t) return null; const s = el("span", { className: "tag", textContent: t.name }); s.style.setProperty("--tc", `var(--t-${t.color})`); return s; }
const fmtDur = (s) => s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const fmtTalk = (s) => !s ? "0s" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
function dayLabel(d) {
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function whenShort(iso) { if (!iso) return "—"; const d = new Date(iso); const l = dayLabel(d); return `${l === "Today" || l === "Yesterday" ? l : d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`; }
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return whenShort(iso); };
const outcomePill = (status) => el("span", { className: "pill " + (status || "unknown"), textContent: OUTCOME[status] || "Unknown" });

/* ---------- modals ---------- */
function confirmBox(title, text, ok = "Confirm") {
  return new Promise((resolve) => {
    $("cf-title").textContent = title; $("cf-text").textContent = text; $("cf-ok").textContent = ok; $("c-scrim").classList.add("open");
    const done = (v) => { $("c-scrim").classList.remove("open"); resolve(v); };
    $("cf-ok").onclick = () => done(true); $("c-scrim").querySelector("[data-close]").onclick = () => done(false);
  });
}
/* fields: [{name,label,type:'text'|'tel'|'password'|'email'|'number'|'textarea'|'select'|'checks'|'swatch'|'check', value, placeholder, options, disabled, hint}] */
function form({ title, sub, fields, submit = "Save", onSubmit, wide }) {
  $("f-form").classList.toggle("wide", !!wide);
  $("f-title").textContent = title; $("f-sub").textContent = sub || ""; $("f-sub").style.display = sub ? "" : "none"; $("f-title").style.marginBottom = sub ? "" : "var(--s5)"; $("f-submit").textContent = submit;
  const box = $("f-fields"); box.replaceChildren();
  for (const f of fields) {
    let input;
    if (f.type === "select") { input = el("select", { name: f.name }); for (const o of f.options) input.append(el("option", { value: o.value, textContent: o.label, disabled: !!o.disabled })); if (f.value != null) input.value = f.value; }
    else if (f.type === "textarea") { input = el("textarea", { name: f.name, value: f.value || "", placeholder: f.placeholder || "" }); }
    else if (f.type === "checks") { input = el("div", { className: "checks" }); if (!f.options.length) input.append(el("span", { className: "hint", textContent: f.empty || "Nothing to choose yet." })); for (const o of f.options) { const c = el("input", { type: "checkbox", name: f.name, value: o.value, checked: (f.value || []).includes(o.value) }); input.append(el("label", {}, c, o.label)); } }
    else if (f.type === "swatch") { input = el("div", { className: "swatches" }); const hidden = el("input", { type: "hidden", name: f.name, value: f.value || COLOURS[0] }); input.append(hidden);
      for (const c of COLOURS) { const b = el("button", { type: "button", className: "swatch" + (c === hidden.value ? " on" : ""), title: COLOUR_NAMES[c] }); b.style.setProperty("--tc", `var(--t-${c})`); b.onclick = () => { hidden.value = c; input.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === b)); }; input.append(b); } }
    else if (f.type === "check") { box.append(el("label", { className: "check", style: "margin-top:var(--s2)" }, el("input", { type: "checkbox", name: f.name }), el("span", { textContent: f.label }))); continue; }
    else { input = el("input", { name: f.name, type: f.type || "text", value: f.value ?? "", placeholder: f.placeholder || "", disabled: !!f.disabled });
      if (f.type === "password") { const eye = el("button", { type: "button", className: "icon-btn", title: "Show" }, icon("i-eye")); eye.onclick = () => (input.type = input.type === "password" ? "text" : "password"); input = el("div", { className: "secret" }, input, eye); } }
    box.append(el("div", { className: "field" }, el("label", { className: "f", textContent: f.label }), input, f.hint ? el("span", { className: "hint", textContent: f.hint }) : null));
  }
  $("f-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData($("f-form")), data = {};
    for (const [k, v] of fd.entries()) { if (fields.find((f) => f.name === k && f.type === "checks")) (data[k] ||= []).push(v); else data[k] = v; }
    for (const f of fields) if (f.type === "checks" && !data[f.name]) data[f.name] = [];
    const btn = $("f-submit"); btn.disabled = true;
    try { await onSubmit(data); $("f-scrim").classList.remove("open"); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  };
  $("f-scrim").querySelector("[data-close]").onclick = () => $("f-scrim").classList.remove("open");
  $("f-scrim").classList.add("open");
  const first = box.querySelector("input:not([type=hidden]):not([disabled]), select, textarea"); if (first) first.focus();
}

/* ---------- sign in ---------- */
let authMode = "in", hasAccounts = true;
function setAuthMode(mode) {
  authMode = mode;
  $("tab-in").classList.toggle("on", mode === "in"); $("tab-up").classList.toggle("on", mode === "up");
  $("up-fields").hidden = mode !== "up"; $("invite-field").hidden = !(mode === "up" && hasAccounts);
  $("auth-title").textContent = mode === "in" ? "Welcome back" : "Create your account";
  $("auth-sub").textContent = mode === "in" ? "Sign in to run your calling agents." : hasAccounts ? "Your workspace owner gives you an invite code." : "The first account owns this workspace.";
  $("auth-go").textContent = mode === "in" ? "Sign in" : "Create account";
  $("a-pass").autocomplete = mode === "in" ? "current-password" : "new-password";
}
$("tab-in").onclick = () => setAuthMode("in"); $("tab-up").onclick = () => setAuthMode("up");
async function showAuth() {
  $("app").hidden = true; $("auth").hidden = false;
  try { hasAccounts = (await api("GET", "/api/auth/state")).has_accounts; } catch { hasAccounts = true; }
  setAuthMode(hasAccounts ? "in" : "up");
}
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("auth-go"); btn.disabled = true;
  try {
    if (authMode === "in") await api("POST", "/api/auth/login", { email: $("a-email").value, password: $("a-pass").value });
    else await api("POST", "/api/auth/signup", { name: $("a-name").value, company: $("a-company").value, email: $("a-email").value, password: $("a-pass").value, invite: $("a-invite").value || undefined });
    $("a-pass").value = ""; const first = authMode === "up"; await boot(); if (first || !store.get("kaho-toured")) setTimeout(startTour, 500);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
};

/* ---------- routing ---------- */
const VIEWS = ["dashboard", "calls", "contacts", "agents", "prompts", "numbers"];
function route() {
  const [view, a, b] = (location.hash || "#dashboard").slice(1).split("/");
  const v = VIEWS.includes(view) ? view : "dashboard";
  document.querySelectorAll("section.view").forEach((s) => s.classList.toggle("on", s.id === "view-" + v));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === v));
  if (v === "dashboard") loadDashboard();
  if (v === "calls") loadCallLog();
  if (v === "agents") { if (a) openAgent(a, b); else showAgentList(); }
  if (v === "prompts") refreshPrompts();
  if (v === "contacts") refreshContacts();
}
window.addEventListener("hashchange", route);
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

/* ---------- profile ---------- */
function renderMe() {
  $("me-avatar").textContent = initials(S.me.name); $("me-name").textContent = S.me.name; $("me-email").textContent = S.me.company || S.me.email;
  const h = new Date().getHours(); $("greet").textContent = `Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}, ${S.me.name.split(" ")[0]}`;
}
$("me-btn").onclick = async () => {
  try { S.me = await api("GET", "/api/me"); } catch (e) { return toast(e.message, true); }
  const m = S.me; $("pr-avatar").textContent = initials(m.name); $("pr-name").textContent = m.name; $("pr-role").textContent = `${m.role === "owner" ? "Owner" : "Member"}${m.company ? " · " + m.company : ""}`;
  const c = m.counts;
  $("pr-stats").replaceChildren(...[["Numbers linked", c.numbers], ["Agents", c.agents], ["Prompts", c.prompts], ["Contacts", c.contacts], ["Calls", c.calls], ["People in workspace", c.members]].map(([k, v]) => el("div", {}, el("b", { textContent: v.toLocaleString() }), el("span", { textContent: k }))));
  $("pr-details").replaceChildren(...[["Email", m.email], ["Company", m.company || "—"], ["Role", m.role === "owner" ? "Owner" : "Member"], ["Member since", new Date(m.created_at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })], ["Team", m.members.map((x) => x.name).join(", ")]].flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  renderInvite(m.invite_code, m.invite_expires);
  $("pr-scrim").classList.add("open");
};
function renderInvite(code, expires) {
  if (!code) return $("pr-invite").replaceChildren();
  const renew = el("button", { type: "button", className: "ghost small-btn" }, "New code");
  renew.onclick = async () => { try { const r = await api("POST", "/api/auth/invite"); renderInvite(r.invite_code, r.invite_expires); toast("New invite code made. The old one no longer works."); } catch (e) { toast(e.message, true); } };
  const until = new Date(expires * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
  $("pr-invite").replaceChildren(el("div", { className: "f", textContent: "Invite code", style: "margin-bottom:8px" }),
    el("div", { style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap" }, el("span", { className: "code", textContent: code }), renew,
      el("span", { className: "hint", textContent: `Share it with one teammate so they can create an account. Works once, until ${until}.` })));
}
$("pr-pass").onclick = () => { $("pr-scrim").classList.remove("open"); form({ title: "Change password", sub: "Every other browser signed in to your account is signed out.",
  fields: [{ name: "current", label: "Current password", type: "password" }, { name: "new", label: "New password", type: "password", placeholder: "At least 8 characters" }],
  submit: "Change password", onSubmit: async (d) => { await api("POST", "/api/auth/password", d); toast("Password changed."); refreshBell(); } }); };
$("pr-scrim").querySelector("[data-close]").onclick = () => $("pr-scrim").classList.remove("open");
$("pr-out").onclick = async () => { await api("POST", "/api/auth/logout").catch(() => {}); $("pr-scrim").classList.remove("open"); S.me = null; showAuth(); };
$("pr-tour").onclick = () => { $("pr-scrim").classList.remove("open"); startTour(); };

/* ---------- notifications ---------- */
async function refreshBell() {
  if (!S.me) return;
  let feed; try { feed = await api("GET", "/api/notifications"); } catch { return; }
  const dot = $("bell-dot"); dot.hidden = !feed.unread; dot.textContent = feed.unread > 9 ? "9+" : feed.unread;
  const menu = $("notif-menu"), seenAt = S.me.seen_at;
  const read = el("button", { type: "button", className: "link small-btn", textContent: "Mark all read" });
  read.onclick = async (e) => { e.stopPropagation(); await api("POST", "/api/notifications/seen"); S.me.seen_at = new Date().toISOString(); refreshBell(); };
  menu.replaceChildren(el("div", { className: "notif-head" }, el("b", { textContent: "Notifications" }), feed.unread ? read : null));
  if (!feed.items.length) menu.append(el("div", { className: "empty", style: "padding:var(--s6)", textContent: "Nothing yet. Changes in your workspace show up here." }));
  for (const n of feed.items) {
    const b = el("button", { type: "button", className: "n-item" + (!seenAt || n.at > seenAt ? " unread" : "") }, el("i"), el("div", {}, el("span", { textContent: n.text }), el("small", { className: "muted", textContent: [n.actor, ago(n.at)].filter(Boolean).join(" · ") })));
    b.onclick = (e) => { e.stopPropagation(); closeMenus(); openNotification(n); };
    menu.append(b);
  }
}
$("bell-btn").onclick = (e) => toggleMenu($("notif-menu"), e);
$("notif-menu").onclick = (e) => e.stopPropagation();
function flashRow(sel) { requestAnimationFrame(() => setTimeout(() => { const r = document.querySelector(sel); if (r) { r.scrollIntoView({ block: "center", behavior: "smooth" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 2000); } }, 250)); }
async function openNotification(n) {
  if (!n.view) return;
  if (n.view === "agents" && n.ref) return go(`#agents/${n.ref}`);
  go("#" + n.view);
  if (n.view === "contacts" && n.ref) { await refreshContacts(); if (S.contacts.some((c) => c.id === n.ref)) flashRow(`[data-contact="${CSS.escape(n.ref)}"]`); }
  if (n.view === "numbers" && n.ref) flashRow(`[data-number="${CSS.escape(n.ref)}"]`);
  if (n.view === "prompts" && n.ref) flashRow(`[data-prompt="${CSS.escape(n.ref)}"]`);
}

/* ---------- dashboard ---------- */
async function loadDashboard() {
  let d; try { d = await api("GET", `/api/dashboard?days=${$("d-days").value}`); } catch (e) { return toast(e.message, true); }
  const t = d.totals, finished = t.calls - t.ringing;
  const tile = (k, v, s, pct, hero) => el("div", { className: "kpi glass card" + (hero ? " hero" : "") }, el("span", { className: "k", textContent: k }), el("span", { className: "v", textContent: v }), el("span", { className: "s", textContent: s }), pct != null ? el("div", { className: "meter" }, Object.assign(el("i"), { style: `width:${Math.min(100, pct)}%` })) : null);
  $("kpis").replaceChildren(
    tile("Calls made", t.calls.toLocaleString(), `${plural(t.people, "person")} reached out to`),
    tile("Picked up", `${d.rates.answer}%`, `${t.answered} of ${finished} calls`, d.rates.answer),
    tile("Successful", `${d.rates.success}%`, `${t.successful} real conversations`, d.rates.success, true),
    tile("Avg. talk time", fmtTalk(d.talk.avg_secs), "on calls that were picked up"),
    tile("Minutes talked", d.talk.total_minutes.toLocaleString(), `${t.leads} lead${t.leads === 1 ? "" : "s"} saved`));
  // How calls ended
  const parts = [["answered", "Picked up", "var(--teal)"], ["no_answer", "No answer", "var(--marigold)"], ["declined", "Declined or busy", "var(--err)"], ["failed", "Failed", "var(--ink-500)"], ["ringing", "Still ringing / unknown", "var(--muted-bar)"]];
  $("outcome-total").textContent = plural(t.calls, "call");
  const bar = el("div", { className: "outcome-bar", role: "img", ariaLabel: parts.map(([k, l]) => `${l} ${t[k]}`).join(", ") });
  for (const [k, l, c] of parts) if (t[k]) bar.append(Object.assign(el("i", { title: `${l}: ${t[k]}` }), { style: `width:${(100 * t[k]) / Math.max(1, t.calls)}%;background:${c}` }));
  const legend = el("div", { className: "legend" }, ...parts.filter(([k]) => k !== "ringing" || t[k]).map(([k, l, c]) => el("div", {}, el("b", { textContent: t[k] }), el("span", {}, Object.assign(el("em"), { style: `background:${c}` }), `${l} · ${t.calls ? Math.round((100 * t[k]) / t.calls) : 0}%`))));
  $("outcomes").replaceChildren(t.calls ? bar : el("div", { className: "hint", textContent: "No calls in this period yet." }), legend,
    el("div", { className: "insight" }, icon("i-bulb"), el("span", { textContent: `A call counts as successful when the person picked up and really talked: at least two replies of their own, or their details saved. ${d.rates.conversion}% of picked-up calls got there.` })));
  // Best time to call
  const max = Math.max(1, ...d.by_hour.map((h) => h.calls));
  const cells = d.by_hour.map((h) => { const c = el("div", { title: `${h.hour}:00 — ${plural(h.calls, "call")}, ${h.answer_rate}% picked up`, textContent: h.calls ? `${Math.round(h.answer_rate)}` : "" }); if (h.calls) c.style.background = `color-mix(in srgb, var(--teal) ${20 + (60 * h.answer_rate) / 100}%, transparent)`; c.style.opacity = h.calls ? 0.55 + (0.45 * h.calls) / max : 1; return c; });
  const labels = d.by_hour.map((h) => el("span", { textContent: h.hour % 6 === 0 ? (h.hour === 0 ? "12a" : h.hour === 12 ? "12p" : h.hour < 12 ? `${h.hour}a` : `${h.hour - 12}p`) : "" }));
  const best = d.best_hour;
  $("hours").replaceChildren(el("div", { className: "hours" }, ...cells), el("div", { className: "hour-labels" }, ...labels),
    el("div", { className: "hint", style: "margin-top:var(--s3)", textContent: "Each square is an hour of the day; the number is the % of calls picked up." }),
    el("div", { className: "insight" }, icon("i-bulb"), el("span", { textContent: best ? `People pick up most around ${best.hour % 12 || 12}${best.hour < 12 ? " am" : " pm"} (${best.answer_rate}% of ${best.calls} calls). Schedule reminders then.` : "Make a few more calls and the best hour to reach people shows up here." })));
  // Calls per day
  const W = 720, H = 200, pad = 22, n = d.by_day.length, bw = (W - 8) / n, top = Math.max(1, ...d.by_day.map((x) => x.calls));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "chart"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Calls per day");
  const mk = (tag, attrs) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  d.by_day.forEach((x, i) => {
    const h = ((H - pad - 8) * x.calls) / top, ha = ((H - pad - 8) * x.answered) / top, X = 4 + i * bw + bw * 0.18, w = Math.max(2, bw * 0.64);
    const g = mk("g", {}); const tt = mk("title", {}); tt.textContent = `${new Date(x.date).toLocaleDateString([], { day: "numeric", month: "short" })}: ${plural(x.calls, "call")}, ${x.answered} picked up`; g.append(tt);
    if (x.calls) { g.append(mk("rect", { x: X, y: H - pad - h, width: w, height: h, rx: Math.min(4, w / 2), fill: "rgba(180,198,198,.22)" })); if (x.answered) g.append(mk("rect", { x: X, y: H - pad - ha, width: w, height: ha, rx: Math.min(4, w / 2), fill: "#3CCFB8" })); }
    else g.append(mk("rect", { x: X, y: H - pad - 2, width: w, height: 2, rx: 1, fill: "rgba(255,255,255,.08)" }));
    svg.append(g);
    const every = n > 31 ? 14 : n > 10 ? 5 : 1;
    if (i % every === 0 || i === n - 1) { const lab = mk("text", { x: X + w / 2, y: H - 6, "text-anchor": "middle" }); lab.textContent = new Date(x.date).toLocaleDateString([], { day: "numeric", month: "short" }); svg.append(lab); }
  });
  $("by-day").replaceChildren(svg);
  // Agents
  $("leaderboard").replaceChildren(...(d.by_agent.length ? [el("div", { className: "lb-row muted" }, el("span", { textContent: "Agent" }), el("span", { textContent: "Calls" }), el("span", { textContent: "Successful" })),
    ...d.by_agent.map((a) => el("div", { className: "lb-row" }, el("b", { className: "ellip", textContent: a.name || "Deleted agent" }), el("span", { className: "num", textContent: a.calls }), el("div", {}, el("span", { className: "num", textContent: `${a.success_rate}%` }), el("div", { className: "meter" }, Object.assign(el("i"), { style: `width:${a.success_rate}%` })))))]
    : [el("div", { className: "hint", textContent: "Calls placed with an agent show here, so you can see which one works best." })]));
  // Recent
  const recent = $("d-recent"); recent.replaceChildren();
  if (!d.recent.length) recent.append(el("li", { className: "hint", style: "cursor:default", textContent: "No calls yet. Start one from Calls." }));
  for (const c of d.recent) recent.append(callItem(c));
}
$("d-days").onchange = loadDashboard;
$("d-sync").onclick = async () => { const b = $("d-sync"); b.disabled = true; try { const r = await api("POST", "/api/dashboard/sync"); toast(`Read ${plural(r.synced, "call")} from Plivo.`); loadDashboard(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; } };
function callItem(c) {
  const who = c.contact_name || c.peer || "Unknown number";
  const li = el("li", {}, el("div", { style: "min-width:0" }, el("b", { className: "ellip", textContent: who }), el("div", { className: "muted ellip", textContent: [whenShort(c.started_at), c.agent_name, c.duration_secs != null && c.status === "answered" ? fmtDur(c.duration_secs) : null, c.direction === "inbound" ? "Incoming" : null].filter(Boolean).join(" · ") })), outcomePill(c.status));
  li.onclick = () => { if (c.has_transcript) showTranscript(c, { name: who }); else toast(c.status === "ringing" ? "This call is still ringing." : "No one talked on this call, so there is no transcript."); };
  return li;
}

/* ---------- our numbers ---------- */
const defaultNumberRow = () => S.numbers.find((n) => n.is_default && n.status === "active") || S.numbers.find((n) => n.status === "active");
async function refreshNumbers() { S.numbers = await api("GET", "/api/numbers"); renderNumbers(); renderCallForm(); }
function renderNumbers() {
  const box = $("n-rows"); box.replaceChildren();
  if (!S.numbers.length) { box.append(el("div", { className: "empty", textContent: "No numbers yet. Add one with “Add new number”." })); return; }
  for (const n of S.numbers) {
    const [label, cls] = STATUS[n.status];
    const items = isOwner() ? [["Edit", () => numberForm(n.provider, n)]] : [];
    if (isOwner() && !n.is_default) items.push(["Set as default", async () => { await api("POST", `/api/numbers/${n.id}/default`); toast("Default number updated."); refreshNumbers(); refreshBell(); }]);
    if (isOwner()) items.push(["Delete", async () => { if (!(await confirmBox(`Delete ${n.number}?`, "The number and its saved credentials are removed from the Studio. Nothing changes at the provider.", "Delete"))) return; await api("DELETE", `/api/numbers/${n.id}`); toast("Number deleted."); refreshNumbers(); refreshBell(); }, true]);
    const sub = [n.provider_label, n.label].filter(Boolean).join(" · ") + (n.credentials_from_env ? " · credentials from .env" : "");
    const pick = el("select", { title: "Which agent answers calls to this number" }, el("option", { value: "", textContent: "Default persona" }), ...S.agents.map((a) => el("option", { value: a.id, textContent: a.name })));
    pick.value = n.agent_id || ""; pick.disabled = !isOwner(); pick.onchange = async () => { try { await api("POST", `/api/numbers/${n.id}/agent`, { agent_id: pick.value || null }); toast("Saved. The next call to this number uses it."); refreshNumbers(); refreshBell(); } catch (e) { toast(e.message, true); } };
    box.append(el("div", { className: "row n-row", dataset: { number: n.id } },
      el("div", { className: "badge " + n.provider, textContent: n.provider_label.slice(0, 2).toUpperCase() }),
      el("div", { style: "min-width:0" }, el("div", { className: "num" }, n.number, n.is_default ? el("span", { className: "star", textContent: "Default" }) : null), el("div", { className: "muted ellip", textContent: sub })),
      el("div", {}, pick),
      el("div", {}, el("span", { className: "pill " + cls, textContent: label })),
      el("div", { className: "row-actions" }, items.length ? menuButton(items) : null)));
  }
}
function renderAddMenu() {
  const menu = $("add-menu"); menu.replaceChildren();
  for (const p of S.providers) { const b = el("button", { type: "button" }, p.label, el("small", { textContent: p.connected ? "Ready" : "Save only, not connected" })); b.onclick = () => { closeMenus(); numberForm(p.id); }; menu.append(b); }
}
$("add-btn").onclick = (e) => toggleMenu($("add-menu"), e);
function numberForm(providerId, existing) {
  const p = S.providers.find((x) => x.id === providerId);
  const fields = [{ name: "number", label: "Phone number", type: "tel", value: existing ? existing.number : "", disabled: !!existing, placeholder: "+91 80655 20552" },
                  { name: "label", label: "Name", value: existing ? existing.label : "", placeholder: "Main line" }];
  for (const f of p.fields) { const cur = existing ? existing.credentials[f.name] : ""; fields.push({ name: f.name, label: f.label, type: f.secret ? "password" : "text", value: existing && !f.secret ? cur : "", placeholder: existing && f.secret ? (cur ? `Saved (${cur}). Leave blank to keep.` : "Not set") : "" }); }
  form({ title: existing ? `Edit ${existing.number}` : `Connect ${/^[AEIOU]/i.test(p.label) ? "an" : "a"} ${p.label} number`,
         sub: p.connected ? (existing && existing.credentials_from_env ? "Credentials are read from .env. Anything saved here replaces them." : "") : `${p.label} numbers can be saved now; calls through ${p.label} are not built yet.`,
         fields, submit: "Save number",
         onSubmit: async (d) => { const credentials = {}; for (const f of p.fields) credentials[f.name] = d[f.name] || "";
           if (existing) await api("PATCH", `/api/numbers/${existing.id}`, { label: d.label || "", credentials });
           else await api("POST", "/api/numbers", { provider: p.id, number: d.number, label: d.label, credentials });
           toast(existing ? "Number updated." : "Number added."); refreshNumbers(); refreshBell(); } });
}

/* ---------- contacts ---------- */
async function refreshContacts() { [S.contacts, S.tags] = await Promise.all([api("GET", "/api/contacts"), api("GET", "/api/tags")]); renderContacts(); renderContactNumbers(); if (openContactId) renderDrawer(); }
const selected = new Set();
function contactTags(c) { return [...new Set([...(c.tags || []), ...c.numbers.flatMap((n) => n.tags || [])])]; }
const history = { id: null, page: 1, perPage: 10 };
function renderContacts() {
  const q = $("c-search").value.trim().toLowerCase(), box = $("c-rows"); box.replaceChildren();
  for (const id of [...selected]) if (!S.contacts.some((c) => c.id === id)) selected.delete(id);
  const tagName = (t) => ((S.tags.find((x) => x.id === t) || {}).name || "").toLowerCase();
  const shown = S.contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.numbers.some((n) => n.number.includes(q.replace(/\s/g, ""))) || contactTags(c).some((t) => tagName(t).includes(q)));
  if (!S.contacts.length) box.append(el("div", { className: "empty", textContent: "No contacts yet. Add one with “New contact”." }));
  else if (!shown.length) box.append(el("div", { className: "empty", textContent: "No contacts match that search." }));
  for (const c of shown) {
    const tick = el("input", { type: "checkbox", checked: selected.has(c.id), title: `Select ${c.name}` });
    tick.onclick = (e) => { e.stopPropagation(); tick.checked ? selected.add(c.id) : selected.delete(c.id); syncSelection(); };
    const first = c.numbers[0];
    const callBtn = el("button", { type: "button", className: "icon-btn call-btn", title: c.dnc ? "Do not call" : first ? `Call ${first.number}` : "No number", disabled: !first || c.dnc }, icon("i-call"));
    callBtn.onclick = (e) => { e.stopPropagation(); if (first) callFrom(c, first); };
    const isOpen = history.id === c.id, lc = c.last_call;
    const row = el("div", { className: "row c-row" + (isOpen ? " open" : ""), dataset: { contact: c.id } }, tick,
      el("div", { className: "who" }, el("div", { className: "avatar", textContent: initials(c.name) }), el("div", { style: "min-width:0" }, el("b", { className: "ellip", textContent: c.name }), c.dnc ? el("span", { className: "pill dnc", style: "height:20px;font-size:11px;margin-top:4px", textContent: "Do not call" }) : el("span", { className: "muted", textContent: c.call_count ? plural(c.call_count, "call") : "Not called yet" }))),
      el("div", {}, first ? el("span", { className: "num", textContent: first.number }) : el("span", { className: "muted", textContent: "No number" }), c.numbers.length > 1 ? el("span", { className: "muted", textContent: `  +${c.numbers.length - 1}` }) : null),
      el("div", { className: "tags" }, ...contactTags(c).map(tagChip)),
      el("div", { style: "min-width:0" }, lc ? el("div", {}, el("div", { className: "muted", textContent: whenShort(lc.started_at) }), el("div", { style: "display:flex;gap:6px;align-items:center;margin-top:4px" }, outcomePill(lc.status), lc.status === "answered" && lc.duration_secs != null ? el("span", { className: "muted", textContent: fmtDur(lc.duration_secs) }) : null)) : el("span", { className: "muted", textContent: "—" })),
      el("div", { className: "row-actions" }, callBtn, menuButton([["Edit", () => openDrawer(c.id, true)], [c.dnc ? "Allow calls again" : "Mark Do not call", () => setDnc(c, !c.dnc)], ["Delete", () => deleteContact(c), true]])));
    const panel = el("div", { className: "history" + (isOpen ? " open" : "") }, el("div", {}, el("div", { className: "history-inner", id: `h-${c.id}` })));
    row.onclick = () => toggleHistory(c.id);
    box.append(row, panel);
    if (isOpen) loadHistory();
  }
  syncSelection();
}
function renderContactNumbers() { $("contact-numbers").replaceChildren(...S.contacts.filter((c) => !c.dnc).flatMap((c) => c.numbers.map((n) => el("option", { value: n.number, label: c.name })))); }
async function setDnc(c, on) { try { await api("PATCH", `/api/contacts/${c.id}`, { dnc: on }); toast(on ? `${c.name} will not be called.` : `${c.name} can be called again.`); refreshContacts(); refreshBell(); } catch (e) { toast(e.message, true); } }
function toggleHistory(id) {
  const opening = history.id !== id;
  history.id = opening ? id : null; history.page = 1;
  document.querySelectorAll(".c-row").forEach((r) => r.classList.remove("open"));
  document.querySelectorAll(".history").forEach((h) => h.classList.remove("open"));
  if (!opening) return;
  const inner = $(`h-${id}`); if (!inner) return;
  inner.parentElement.parentElement.classList.add("open"); inner.parentElement.parentElement.previousElementSibling.classList.add("open");
  loadHistory();
}
function pager(data, state, reload) {
  const pages = Math.max(1, Math.ceil(data.total / data.per_page)), from = data.total ? (data.page - 1) * data.per_page + 1 : 0, to = Math.min(data.total, data.page * data.per_page);
  const size = el("select", { title: "Rows per page" }); for (const n of [10, 20, 25, 50]) size.append(el("option", { value: n, textContent: n, selected: n === state.perPage }));
  size.onclick = (e) => e.stopPropagation(); size.onchange = () => { state.perPage = +size.value; state.page = 1; reload(); };
  const prev = el("button", { type: "button", className: "ghost", disabled: data.page <= 1 }, "Previous"), next = el("button", { type: "button", className: "ghost", disabled: data.page >= pages }, "Next");
  prev.onclick = (e) => { e.stopPropagation(); state.page--; reload(); }; next.onclick = (e) => { e.stopPropagation(); state.page++; reload(); };
  return el("div", { className: "pager" }, "Rows per page", size, el("span", { textContent: `${from}–${to} of ${data.total}` }), prev, next);
}
async function loadHistory() {
  const id = history.id, inner = $(`h-${id}`); if (!inner) return;
  let data;
  try { data = await api("GET", `/api/contacts/${id}/calls?page=${history.page}&per_page=${history.perPage}`); }
  catch (e) { inner.replaceChildren(el("div", { className: "hint", textContent: e.message })); return; }
  if (history.id !== id) return;
  inner.replaceChildren();
  if (!data.total) { inner.append(el("div", { className: "hint", textContent: "No calls with this contact yet." })); return; }
  const contact = S.contacts.find((c) => c.id === id);
  let day = null, group = null;
  for (const call of data.calls) {
    const when = call.started_at ? new Date(call.started_at) : null;
    const label = when ? dayLabel(when) : "Unknown date";
    if (label !== day) { day = label; group = el("div", { className: "day" }, el("div", { className: "day-head", textContent: label })); inner.append(group); }
    const acts = el("div", { className: "row-actions" });
    if (call.has_transcript) {
      const view = el("button", { type: "button", className: "ghost small-btn" }, "Transcript");
      view.onclick = (e) => { e.stopPropagation(); showTranscript(call, contact); };
      const csv = el("a", { className: "icon-btn", title: "Download CSV", href: `/api/calls/${encodeURIComponent(call.call_id)}/transcript.csv`, download: "" }, icon("i-download"));
      csv.style.display = "inline-grid"; csv.style.placeItems = "center"; csv.onclick = (e) => e.stopPropagation();
      acts.append(view, csv);
    }
    group.append(el("div", { className: "h-row" },
      el("span", { className: "num", textContent: when ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—" }),
      el("span", { className: "muted", textContent: call.direction === "inbound" ? "Incoming" : call.direction === "outbound" ? "Outgoing" : "Call" }),
      el("span", {}, outcomePill(call.status)),
      el("span", { className: "num", textContent: call.status === "answered" ? fmtDur(call.duration_secs) : "—" }),
      el("span", { className: "summary", textContent: call.summary || (call.agent_name ? `Agent: ${call.agent_name}` : call.turns ? `${plural(call.turns, "turn")}, no summary` : call.status === "answered" ? "No conversation" : ""), title: call.summary || "" }),
      acts));
  }
  inner.append(pager(data, history, loadHistory));
}
async function showTranscript(call, contact) {
  $("t-title").textContent = (contact && contact.name) || call.contact_name || call.peer || "Call";
  const when = call.started_at ? new Date(call.started_at) : null;
  $("t-sub").textContent = [call.peer, when ? when.toLocaleString() : null, call.duration_secs != null ? fmtDur(call.duration_secs) : null, call.agent_name].filter(Boolean).join(" · ");
  $("t-csv").href = `/api/calls/${encodeURIComponent(call.call_id)}/transcript.csv`;
  const box = $("t-chat"); box.replaceChildren(el("div", { className: "hint", textContent: "Loading…" }));
  $("t-scrim").classList.add("open");
  try {
    const turns = await api("GET", `/api/calls/${encodeURIComponent(call.call_id)}/transcript`);
    box.replaceChildren();
    if (!turns.length) box.append(el("div", { className: "hint", textContent: "Nothing was said on this call." }));
    for (const t of turns) { const b = bubble(t.role, t.text, false); b.querySelector("time").textContent = t.at ? new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; b.style.animation = "none"; box.append(b); }
  } catch (e) { box.replaceChildren(el("div", { className: "hint", textContent: e.message })); }
}
$("t-scrim").querySelector("[data-close]").onclick = () => $("t-scrim").classList.remove("open");
function syncSelection() {
  const n = selected.size, total = S.contacts.length;
  $("c-count").textContent = n ? `${n} selected` : plural(total, "contact");
  $("c-bulk-delete").hidden = !n || !isOwner();
  $("c-all").checked = total > 0 && n === total; $("c-all").indeterminate = n > 0 && n < total;
}
$("c-all").onclick = () => { if ($("c-all").checked) S.contacts.forEach((c) => selected.add(c.id)); else selected.clear(); renderContacts(); };
$("c-search").oninput = () => renderContacts();
$("c-bulk-delete").onclick = async () => {
  const n = selected.size; if (!(await confirmBox(`Delete ${plural(n, "contact")}?`, "Their numbers and tags go with them. Call history is kept.", "Delete"))) return;
  await api("POST", "/api/contacts/delete", { ids: [...selected] }); selected.clear(); toast(`${n} deleted.`); refreshContacts(); refreshBell();
};
$("new-contact").onclick = () => form({ title: "New contact", fields: [
    { name: "name", label: "Name", placeholder: "Asha Rao" }, { name: "number", label: "Phone number", type: "tel", placeholder: "98765 43210" },
    { name: "tags", label: "Tags", type: "checks", empty: "No tags yet. Open a contact to create one.", options: S.tags.map((t) => ({ value: t.id, label: t.name })) }],
  submit: "Save contact",
  onSubmit: async (d) => { await api("POST", "/api/contacts", { name: d.name, numbers: d.number ? [d.number] : [], tags: d.tags }); toast("Contact saved."); refreshContacts(); refreshBell(); } });
async function deleteContact(c) { if (!(await confirmBox(`Delete ${c.name}?`, "Their numbers and tags go with them. Call history is kept.", "Delete"))) return; await api("DELETE", `/api/contacts/${c.id}`); if (openContactId === c.id) closeDrawer(); toast("Contact deleted."); refreshContacts(); refreshBell(); }

/* ---------- contact drawer: edit name, numbers, tags ---------- */
let editingName = false;
function openDrawer(id, edit) { openContactId = id; editingName = !!edit; renderDrawer(); $("drawer").classList.add("open"); $("drawer-scrim").classList.add("open"); }
function closeDrawer() { openContactId = null; editingName = false; $("drawer").classList.remove("open"); $("drawer-scrim").classList.remove("open"); }
$("d-close").onclick = closeDrawer; $("drawer-scrim").onclick = closeDrawer;
function inlineEdit(value, onSave, opts = {}) {
  const input = el("input", { type: opts.type || "text", value, maxLength: opts.max || 80 });
  const save = el("button", { type: "button", className: "icon-btn", title: "Save" }, icon("i-check"));
  const cancel = el("button", { type: "button", className: "icon-btn", title: "Cancel" }, icon("i-x"));
  const commit = async () => { const v = input.value.trim(); if (!v || v === value) return opts.onCancel(); try { await onSave(v); } catch (e) { toast(e.message, true); input.focus(); } };
  save.onclick = commit; cancel.onclick = () => opts.onCancel();
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { e.stopPropagation(); opts.onCancel(); } };
  setTimeout(() => { input.focus(); input.select(); }, 50);
  return el("div", { style: "display:flex;gap:4px;align-items:center;width:100%" }, input, save, cancel);
}
function renderDrawer() {
  const c = S.contacts.find((x) => x.id === openContactId); if (!c) { closeDrawer(); return; }
  $("d-avatar").textContent = initials(c.name);
  const title = $("d-title"); title.replaceChildren();
  if (editingName) title.append(inlineEdit(c.name, async (v) => { await api("PATCH", `/api/contacts/${c.id}`, { name: v }); editingName = false; toast("Name saved."); await refreshContacts(); refreshBell(); }, { onCancel: () => { editingName = false; renderDrawer(); } }));
  else { const pen = el("button", { type: "button", className: "icon-btn", title: "Edit name" }, icon("i-pencil")); pen.onclick = () => { editingName = true; renderDrawer(); }; title.append(el("h2", { textContent: c.name }), pen); }
  $("d-sub").textContent = [plural(c.numbers.length, "number"), c.call_count ? plural(c.call_count, "call") : null].filter(Boolean).join(" · ");
  const nb = $("d-numbers"); nb.replaceChildren();
  if (!c.numbers.length) nb.append(el("div", { className: "hint", textContent: "No number saved." }));
  for (const n of c.numbers) {
    const row = el("div", { className: "pb-row" });
    const show = () => {
      const call = el("button", { type: "button", className: "icon-btn call-btn", title: c.dnc ? "Do not call" : `Call ${n.number}`, disabled: c.dnc }, icon("i-call")); call.onclick = () => callFrom(c, n);
      const pen = el("button", { type: "button", className: "icon-btn", title: "Edit number" }, icon("i-pencil")); pen.onclick = edit;
      row.replaceChildren(el("div", { className: "num", textContent: n.number }), el("div", { className: "row-actions" }, pen, call));
    };
    const edit = () => row.replaceChildren(inlineEdit(n.number, async (v) => { await api("PATCH", `/api/contacts/${c.id}/numbers/${n.id}`, { number: v }); toast("Number saved."); await refreshContacts(); refreshBell(); }, { type: "tel", max: 20, onCancel: show }));
    show(); nb.append(row);
  }
  const tb = $("d-tags"); tb.replaceChildren();
  const mine = contactTags(c);
  if (!mine.length) tb.append(el("div", { className: "hint", textContent: "No tags on this contact yet." }));
  for (const id of mine) {
    const t = S.tags.find((x) => x.id === id); if (!t) continue;
    tb.append(el("div", { className: "tag-row" }, tagChip(t.id), menuButton([
      ["Remove from contact", () => removeTag(c, id)],
      ["Edit tag", () => tagForm(t)],
      ["Delete tag everywhere", async () => { if (!(await confirmBox(`Delete the tag “${t.name}”?`, "It is taken off every contact that has it.", "Delete"))) return; await api("DELETE", `/api/tags/${t.id}`); toast("Tag deleted."); refreshContacts(); refreshBell(); }, true]])));
  }
  $("d-dnc").checked = !!c.dnc; $("d-dnc").onchange = () => setDnc(c, $("d-dnc").checked);
}
async function removeTag(c, id) {
  await api("PATCH", `/api/contacts/${c.id}`, { tags: (c.tags || []).filter((x) => x !== id) });
  for (const n of c.numbers) if ((n.tags || []).includes(id)) await api("PATCH", `/api/contacts/${c.id}/numbers/${n.id}`, { tags: n.tags.filter((x) => x !== id) });
  refreshContacts();
}
function tagForm(t, attachTo) { form({ title: t ? "Edit tag" : `New tag${attachTo ? " for " + attachTo.name : ""}`, fields: [{ name: "name", label: "Name", value: t ? t.name : "", placeholder: "EMI due" }, { name: "color", label: "Colour", type: "swatch", value: t ? t.color : COLOURS[0] }],
  submit: t ? "Save tag" : "Create tag", onSubmit: async (d) => {
    if (t) await api("PATCH", `/api/tags/${t.id}`, d);
    else { const created = await api("POST", "/api/tags", d); if (attachTo) { const fresh = S.contacts.find((x) => x.id === attachTo.id) || attachTo; await api("PATCH", `/api/contacts/${attachTo.id}`, { tags: [...new Set([...(fresh.tags || []), created.id])] }); } }
    toast(t ? "Tag updated." : attachTo ? `Tag added to ${attachTo.name}.` : "Tag created."); refreshContacts(); refreshBell(); } }); }
$("d-add-tag").onclick = () => tagForm(null, S.contacts.find((x) => x.id === openContactId));
$("d-pick-tag").onclick = () => { const c = S.contacts.find((x) => x.id === openContactId); if (!S.tags.length) return tagForm(null, c);
  form({ title: `Tags for ${c.name}`, fields: [{ name: "tags", label: "Tags", type: "checks", value: contactTags(c), options: S.tags.map((t) => ({ value: t.id, label: t.name })) }],
    onSubmit: async (d) => { await api("PATCH", `/api/contacts/${c.id}`, { tags: d.tags }); for (const n of c.numbers) if ((n.tags || []).some((x) => !d.tags.includes(x))) await api("PATCH", `/api/contacts/${c.id}/numbers/${n.id}`, { tags: n.tags.filter((x) => d.tags.includes(x)) }); toast("Tags updated."); refreshContacts(); refreshBell(); } }); };

/* ---------- calling ---------- */
const agentOptions = (withNone) => [...(withNone ? [{ value: "", label: "Default persona (no agent)" }] : []), ...S.agents.map((a) => ({ value: a.id, label: a.name }))];
const fromOptions = () => S.numbers.map((n) => ({ value: n.id, label: `${n.number} · ${n.provider_label}${n.label ? " · " + n.label : ""}${n.status !== "active" ? " (" + STATUS[n.status][0].toLowerCase() + ")" : ""}`, disabled: n.status !== "active" }));
function callFrom(contact, number, agentId) {
  if (contact && contact.dnc) return toast(`${contact.name} is marked Do not call.`, true);
  const def = (defaultNumberRow() || {}).id;
  form({ title: contact ? `Call ${contact.name}` : "Test call", sub: number ? number.number : "The call uses this agent's prompt, tools and settings.", submit: "Call now",
    fields: [{ name: "agent_id", label: "Agent", type: "select", options: agentOptions(true), value: agentId || (S.agents[0] || {}).id || "" },
             ...(number ? [] : [{ name: "to", label: "Number to call", type: "tel", placeholder: "Your own number, to hear it" }]),
             { name: "from_id", label: "Call from", type: "select", options: fromOptions(), value: def },
             { name: "consent", label: "This person has agreed to be called. The call is recorded.", type: "check" }],
    onSubmit: async (d) => { if (!d.consent) throw new Error("Confirm that this person agreed to be called."); await placeCall(d.from_id, number ? number.number : d.to, contact ? contact.name : null, d.agent_id); } });
}
function renderCallForm() {
  const s = $("call-from"), keep = s.value; s.replaceChildren(...fromOptions().map((o) => el("option", { value: o.value, textContent: o.label, disabled: o.disabled })));
  s.value = S.numbers.some((n) => n.id === keep) ? keep : (defaultNumberRow() || {}).id || "";
  const a = $("call-agent"), keepA = a.value; a.replaceChildren(...agentOptions(true).map((o) => el("option", { value: o.value, textContent: o.label })));
  a.value = S.agents.some((x) => x.id === keepA) ? keepA : (S.agents[0] || {}).id || "";
}
$("call-go").onclick = async () => {
  const to = $("call-to").value.trim();
  if (!to) return toast("Type a number to call.", true);
  if (!$("call-consent").checked) return toast("Confirm that this person agreed to be called.", true);
  const btn = $("call-go"); btn.disabled = true; btn.lastChild.textContent = "Calling…";
  try { await placeCall($("call-from").value, to, null, $("call-agent").value); $("call-consent").checked = false; $("call-to").value = ""; }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.lastChild.textContent = "Call now"; }
};
async function placeCall(fromId, to, name, agentId) {
  const r = await api("POST", "/api/calls", { from_id: fromId, to, consent: true, agent_id: agentId || undefined });
  go("#calls");
  const label = name || (S.contacts.find((c) => c.numbers.some((n) => n.number === r.to)) || {}).name || r.to;
  if (r.request_uuid) watchCall(r.request_uuid, label, [r.to, r.agent_name].filter(Boolean).join(" · "));
  toast(`Ringing ${label}.`); refreshBell(); setTimeout(loadCallLog, 600);
}
const callLog = { page: 1, perPage: 10 };
async function loadCallLog() {
  let data; try { data = await api("GET", `/api/calls?page=${callLog.page}&per_page=${callLog.perPage}`); } catch (e) { return; }
  const log = $("call-log"); log.replaceChildren();
  $("cl-count").textContent = plural(data.total, "call");
  if (!data.calls.length) log.append(el("li", { className: "hint", style: "cursor:default", textContent: "No calls yet." }));
  for (const c of data.calls) log.append(callItem(c));
  $("cl-pager").replaceChildren(data.total > 10 ? pager(data, callLog, loadCallLog) : "");
}

/* ---------- live transcript ---------- */
let source = null, open = { agent: null, caller: null }, typing = null;
function setState(text, cls) { $("chat-state").textContent = text; $("chat-state").className = "pill " + cls; }
function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 120; }
function scrollDown(box, force) { if (force || nearBottom(box)) requestAnimationFrame(() => (box.scrollTop = box.scrollHeight)); }
function stamp() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function showTyping(box) { if (!typing) { typing = el("div", { className: "typing" }, el("i"), el("i"), el("i")); box.append(typing); scrollDown(box, true); } }
function hideTyping() { if (typing) { typing.remove(); typing = null; } }
function bubble(role, text, live) { return el("div", { className: `msg ${role}${live ? " live" : ""}` }, el("span", { className: "t", textContent: text }), el("time", { textContent: stamp() })); }
function watchCall(uuid, label, sub) {
  if (source) source.close();
  open = { agent: null, caller: null }; typing = null;
  const box = $("chat"); box.replaceChildren();
  $("chat-avatar").textContent = label.startsWith("+") ? "☎" : initials(label); $("chat-title").textContent = label; $("chat-sub").textContent = sub;
  setState("Ringing", "warn"); showTyping(box);
  source = new EventSource(`/api/calls/${encodeURIComponent(uuid)}/stream`);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data), stick = nearBottom(box);
    if (e.event === "call_start") setState("Live", "live");
    else if (e.event === "recording_notice_played") { hideTyping(); box.append(el("div", { className: "sys", textContent: "Recording notice played" })); }
    else if (e.event === "live" || e.event === "turn") {
      hideTyping();
      const role = e.role;
      if (role === "agent" && open.caller && e.event === "live") { open.caller.classList.remove("live"); open.caller = null; }
      let b = open[role];
      if (e.event === "live") {
        if (!b) { b = bubble(role, "", true); box.append(b); open[role] = b; }
        const t = b.querySelector(".t");
        t.textContent = role === "agent" ? (t.textContent ? t.textContent + " " : "") + e.text : e.text;  // agent words arrive one by one; caller captions are cumulative
      } else {
        if (b) { b.querySelector(".t").textContent = e.text; b.classList.remove("live"); } else box.append(bubble(role, e.text, false));
        open[role] = null;
      }
    }
    else if (e.event === "tool") { const names = { capture_lead: "Details saved", end_call: "The agent ended the call", transfer_to_human: "Transferred to a person", call_webhook: "Checked your system" }; box.append(el("div", { className: "sys", textContent: names[e.name] || e.name })); }
    else if (e.event === "call_failed") box.append(el("div", { className: "sys", textContent: "A provider failed during the call" }));
    else if (e.event === "no_answer") { hideTyping(); box.append(el("div", { className: "sys", textContent: "Not picked up" })); setState("Not picked up", "muted"); source.close(); loadCallLog(); }
    else if (e.event === "call_end") { hideTyping(); for (const r of ["agent", "caller"]) if (open[r]) open[r].classList.remove("live"); box.append(el("div", { className: "sys", textContent: `Call ended · ${stamp()}` })); setState("Ended", "muted"); source.close(); setTimeout(loadCallLog, 1500); }
    scrollDown(box, stick);
  };
  source.onerror = () => { if (source && source.readyState === EventSource.CLOSED) setState("Disconnected", "muted"); };
}

/* ---------- agents ---------- */
async function refreshAgents() { S.agents = await api("GET", "/api/agents"); renderAgentGrid(); renderCallForm(); renderNumbers(); }
function showAgentList() { $("agents-list").hidden = false; $("agent-detail").hidden = true; refreshAgents(); }
function renderAgentGrid() {
  const g = $("agent-grid"); g.replaceChildren();
  if (!S.agents.length) g.append(el("div", { className: "card glass empty", style: "grid-column:1/-1" }, el("div", { textContent: "No agents yet. Create one for each kind of call you make, like EMI reminders." })));
  for (const a of S.agents) {
    const prompt = S.prompts.find((p) => p.id === a.active_prompt_id);
    const card = el("div", { className: "card glass agent-card", tabIndex: 0, role: "button" },
      el("div", { style: "display:flex;justify-content:space-between;align-items:center" }, el("div", { className: "agent-icon" }, icon("i-agent")), a.numbers.length ? el("span", { className: "pill active", textContent: `Answers ${a.numbers.length > 1 ? plural(a.numbers.length, "number") : a.numbers[0]}` }) : null),
      el("h3", { textContent: a.name }), el("div", { className: "desc", textContent: a.description || "No description yet." }),
      el("div", { className: "meta" }, el("span", { textContent: plural(a.prompt_ids.length, "prompt") }), el("span", { textContent: plural(a.tools.length, "tool") }), el("span", { textContent: plural(a.call_count || 0, "call") }), prompt ? el("span", { className: "ellip", textContent: `In use: ${prompt.name}` }) : null));
    card.onclick = () => go(`#agents/${a.id}`); card.onkeydown = (e) => { if (e.key === "Enter") go(`#agents/${a.id}`); };
    g.append(card);
  }
}
$("new-agent").onclick = () => form({ title: "New agent", sub: "Give it a name, say what it is for, and write how it should talk. You can add more prompts later.", wide: true,
  fields: [{ name: "name", label: "Name", placeholder: "EMI reminder" }, { name: "description", label: "Description", placeholder: "Reminds borrowers a day before their EMI is due" },
           { name: "prompt", label: "Prompt", type: "textarea", placeholder: "You are Riya from Acme Finance. You are calling to remind the person that their EMI is due on…" }],
  submit: "Create agent", onSubmit: async (d) => { const a = await api("POST", "/api/agents", d); toast("Agent created."); await refreshPrompts(true); refreshBell(); go(`#agents/${a.id}`); } });

let agent = null, agentPromptId = null, loadedPromptText = "", agentTab = "prompt";
async function openAgent(id, promptId) {
  $("agents-list").hidden = true; $("agent-detail").hidden = false;
  try { [agent] = await Promise.all([api("GET", `/api/agents/${encodeURIComponent(id)}`), refreshPrompts(true)]); }
  catch (e) { toast(e.message, true); return go("#agents"); }
  agentPromptId = promptId && agent.prompt_ids.includes(promptId) ? promptId : agent.active_prompt_id || agent.prompt_ids[0] || null;
  $("ag-name").textContent = agent.name; $("ag-desc").textContent = agent.description || "No description yet.";
  const menu = $("ag-menu"); menu.replaceChildren();
  for (const [t, fn, bad] of [["Edit name and description", editAgentDetails], ...(isOwner() ? [["Delete agent", deleteAgent, true]] : [])]) { const b = el("button", { type: "button", className: bad ? "bad" : "" }, t); b.onclick = (e) => { e.stopPropagation(); closeMenus(); fn(); }; menu.append(b); }
  setTab(promptId ? "prompt" : agentTab); renderAgentPrompt(); renderTools(); renderSettings();
}
$("ag-more").onclick = (e) => toggleMenu($("ag-menu"), e);
$("agent-back").onclick = () => go("#agents");
$("ag-edit").onclick = () => editAgentDetails();
$("ag-test").onclick = () => callFrom(null, null, agent.id);
function setTab(tab) { agentTab = tab; for (const b of $("ag-tabs").children) b.classList.toggle("on", b.dataset.tab === tab); for (const t of ["prompt", "tools", "settings"]) $("tab-" + t).hidden = t !== tab; }
for (const b of $("ag-tabs").children) b.onclick = () => setTab(b.dataset.tab);
function editAgentDetails() { form({ title: "Edit agent", fields: [{ name: "name", label: "Name", value: agent.name }, { name: "description", label: "Description", value: agent.description }], onSubmit: async (d) => { await api("PATCH", `/api/agents/${agent.id}`, d); toast("Agent updated."); refreshBell(); openAgent(agent.id, agentPromptId); } }); }
async function deleteAgent() { if (!(await confirmBox(`Delete ${agent.name}?`, "Its prompts are kept on the Prompts page. Numbers it answered go back to the default persona.", "Delete agent"))) return; await api("DELETE", `/api/agents/${agent.id}`); toast("Agent deleted."); refreshBell(); go("#agents"); }
function renderAgentPrompt() {
  const chips = $("ag-prompts"); chips.replaceChildren();
  for (const pid of agent.prompt_ids) {
    const p = S.prompts.find((x) => x.id === pid); if (!p) continue;
    const c = el("button", { type: "button", className: "chip" + (pid === agentPromptId ? " on" : "") }, p.name, pid === agent.active_prompt_id ? el("span", { className: "use", textContent: "In use" }) : null);
    c.onclick = async () => { if (unsaved() && !(await confirmBox("Discard your changes?", "This prompt has edits that are not saved.", "Discard"))) return; go(`#agents/${agent.id}/${pid}`); };
    chips.append(c);
  }
  const add = el("button", { type: "button", className: "chip" }, icon("i-plus"), "New prompt");
  add.onclick = () => newPromptForm(agent.id); chips.append(add);
  const p = S.prompts.find((x) => x.id === agentPromptId);
  for (const id of ["ap-name", "ap-text", "ap-save"]) $(id).disabled = !p;
  $("ap-name").value = p ? p.name : ""; $("ap-text").value = p ? p.prompt : ""; loadedPromptText = $("ap-text").value; $("ap-name").dataset.loaded = $("ap-name").value;
  $("ap-use").hidden = !p || p.id === agent.active_prompt_id;
  $("ap-updated").textContent = p ? `${p.id === agent.active_prompt_id ? "In use on calls · " : ""}Saved ${whenShort(p.updated_at)}` : "This agent has no prompt. Add one.";
  countPrompt(); loadVersions();
}
const unsaved = () => agentPromptId && ($("ap-text").value !== loadedPromptText || $("ap-name").value !== $("ap-name").dataset.loaded);
function countPrompt() { const n = $("ap-text").value.trim().length, max = S.cfg.max_chars; $("ap-count").textContent = `${n.toLocaleString()} / ${max.toLocaleString()}`; $("ap-count").style.color = n > max ? "var(--err)" : ""; $("ap-save").disabled = !agentPromptId || n === 0 || n > max; }
async function savePrompt() {
  if ($("ap-save").disabled) return;
  try { await api("PATCH", `/api/prompts/${agentPromptId}`, { name: $("ap-name").value, text: $("ap-text").value }); await refreshPrompts(true); renderAgentPrompt(); refreshBell(); toast("Saved. The next call uses it."); } catch (e) { toast(e.message, true); }
}
$("ap-text").addEventListener("input", countPrompt); $("ap-save").onclick = savePrompt;
$("ap-use").onclick = async () => { try { agent = await api("PATCH", `/api/agents/${agent.id}`, { active_prompt_id: agentPromptId }); await refreshPrompts(true); renderAgentPrompt(); refreshBell(); toast("Calls now use this prompt."); } catch (e) { toast(e.message, true); } };
async function loadVersions() {
  const list = $("v-list"); list.replaceChildren(); $("v-count").textContent = "";
  if (!agentPromptId) return;
  let versions = [];
  try { versions = await api("GET", `/api/prompts/${agentPromptId}/versions`); } catch (e) { list.append(el("div", { className: "hint", textContent: e.message })); return; }
  $("v-count").textContent = `${versions.length}`;
  versions.forEach((v, i) => {
    const isCurrent = i === 0;
    const restore = el("button", { type: "button", className: "primary small-btn", disabled: isCurrent }, "Restore");
    const del = el("button", { type: "button", className: "ghost small-btn", disabled: isCurrent, title: isCurrent ? "This is the version in use" : "" }, "Delete");
    restore.onclick = async () => { await api("POST", `/api/prompts/${agentPromptId}/versions/${v.id}/restore`); await refreshPrompts(true); renderAgentPrompt(); refreshBell(); toast("Version restored. The next call uses it."); };
    del.onclick = async () => { if (!(await confirmBox("Delete this version?", "It is removed from the history. The current prompt is not changed.", "Delete"))) return; await api("DELETE", `/api/prompts/${agentPromptId}/versions/${v.id}`); await refreshPrompts(true); loadVersions(); toast("Version deleted."); };
    const when = v.saved_at ? new Date(v.saved_at) : null;
    const row = el("div", { className: "v-row" },
      el("div", { className: "v-head" }, el("div", { style: "min-width:0" }, el("div", {}, el("b", { textContent: when ? when.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Earlier" }), isCurrent ? el("span", { className: "v-current", textContent: "Current" }) : null), el("div", { className: "preview", textContent: v.prompt.split("\n")[0] })), el("span", { className: "muted", textContent: `${v.prompt.length.toLocaleString()} chars` })),
      el("div", { className: "v-body" }, el("pre", { textContent: v.prompt }), el("div", { style: "display:flex;gap:var(--s2)" }, restore, del)));
    row.querySelector(".v-head").onclick = () => { const o = row.classList.contains("open"); list.querySelectorAll(".v-row").forEach((r) => r.classList.remove("open")); if (!o) row.classList.add("open"); };
    list.append(row);
  });
}
function renderTools() {
  const box = $("ag-tools"); box.replaceChildren();
  for (const t of S.tools) {
    const input = el("input", { type: "checkbox", value: t.name, checked: agent.tools.includes(t.name), ariaLabel: t.label });
    box.append(el("div", { className: "tool-row" }, el("div", {}, el("b", { textContent: t.label }), el("span", { className: "hint", textContent: t.description }), !t.ready ? el("div", { className: "hint", style: "color:var(--marigold);margin-top:4px", textContent: `Needs ${t.needs} set up on the server before it can work.` }) : null), el("label", { className: "switch" }, input, el("span"))));
  }
}
$("ag-tools-save").onclick = async () => { const tools = [...$("ag-tools").querySelectorAll("input:checked")].map((i) => i.value); try { agent = await api("PATCH", `/api/agents/${agent.id}`, { tools }); toast("Tools saved. The next call uses them."); refreshBell(); } catch (e) { toast(e.message, true); } };
function renderSettings() {
  const s = agent.settings, L = S.cfg.limits;
  $("as-open").value = s.opening_line || ""; $("as-max").value = s.max_minutes; $("as-max").max = L.max_minutes; $("as-max-hint").textContent = `The call is ended after this, whatever is happening. Up to ${L.max_minutes} minutes on this server.`; $("as-ring").value = s.ring_secs; $("as-ring").min = L.ring_secs[0]; $("as-ring").max = L.ring_secs[1];
  $("as-numbers").replaceChildren(...(agent.numbers.length ? agent.numbers.map((n) => el("div", { className: "pb-row" }, el("span", { className: "num", textContent: n }), el("span", { className: "pill active", textContent: "Answers" }))) : [el("div", { className: "hint", textContent: "No number answers with this agent yet. It can still make calls." })]));
}
$("as-save").onclick = async () => { try { agent = await api("PATCH", `/api/agents/${agent.id}`, { settings: { opening_line: $("as-open").value, max_minutes: $("as-max").value, ring_secs: $("as-ring").value } }); renderSettings(); toast("Settings saved. The next call uses them."); refreshBell(); } catch (e) { toast(e.message, true); } };

/* ---------- prompts ---------- */
async function refreshPrompts(quiet) { S.prompts = await api("GET", "/api/prompts"); if (!quiet || $("view-prompts").classList.contains("on")) renderPrompts(); }
function renderPrompts() {
  const box = $("p-rows"); box.replaceChildren();
  if (!S.prompts.length) box.append(el("div", { className: "empty", textContent: "No prompts yet. Create an agent, or a prompt here." }));
  for (const p of S.prompts) {
    const name = el("button", { type: "button", className: "link ellip", textContent: p.name, title: p.agent_id ? `Open in ${p.agent_name}` : "Edit" });
    name.onclick = () => p.agent_id ? go(`#agents/${p.agent_id}/${p.id}`) : editPromptForm(p);
    box.append(el("div", { className: "row p-row", dataset: { prompt: p.id } },
      el("div", { style: "min-width:0" }, name, el("div", { className: "muted ellip", textContent: p.prompt.split("\n")[0] })),
      el("div", { className: "ellip" }, p.agent_name ? el("span", {}, p.agent_name) : el("span", { className: "muted", textContent: "Not assigned" })),
      el("span", { className: "num", textContent: p.version_count }),
      el("span", {}, el("span", { className: "pill " + (p.in_use ? "active" : "muted"), textContent: p.in_use ? "In use" : "Not in use" })),
      el("span", { className: "muted", textContent: whenShort(p.updated_at) }),
      el("div", { className: "row-actions" }, menuButton([["Edit", () => editPromptForm(p)], ["Change agent", () => assignForm(p)], ...(isOwner() ? [["Delete", () => deletePrompt(p), true]] : [])]))));
  }
}
function newPromptForm(agentId) { form({ title: "New prompt", wide: true, fields: [{ name: "name", label: "Name", placeholder: "EMI reminder, Hindi" }, { name: "agent_id", label: "Agent", type: "select", options: [{ value: "", label: "No agent yet" }, ...agentOptions(false)], value: agentId || "" }, { name: "prompt", label: "Prompt", type: "textarea" }],
  submit: "Create prompt", onSubmit: async (d) => { const p = await api("POST", "/api/prompts", { ...d, agent_id: d.agent_id || null }); toast("Prompt created."); await refreshPrompts(); refreshBell(); if (p.agent_id) go(`#agents/${p.agent_id}/${p.id}`); } }); }
$("new-prompt").onclick = () => newPromptForm(null);
function editPromptForm(p) { form({ title: "Edit prompt", sub: "Saving a change to the text keeps the old one as a version.", wide: true, fields: [{ name: "name", label: "Name", value: p.name }, { name: "text", label: "Prompt", type: "textarea", value: p.prompt }],
  onSubmit: async (d) => { await api("PATCH", `/api/prompts/${p.id}`, d); toast("Prompt saved."); await refreshPrompts(); refreshBell(); } }); }
function assignForm(p) { form({ title: `Change the agent for ${p.name}`, sub: "If it was the prompt in use, its old agent switches to another of its prompts.", fields: [{ name: "agent_id", label: "Agent", type: "select", options: [{ value: "", label: "No agent" }, ...agentOptions(false)], value: p.agent_id || "" }],
  submit: "Move prompt", onSubmit: async (d) => { await api("POST", `/api/prompts/${p.id}/assign`, { agent_id: d.agent_id || null }); toast("Prompt moved."); await refreshPrompts(); refreshAgents(); refreshBell(); } }); }
async function deletePrompt(p) { if (!(await confirmBox(`Delete ${p.name}?`, `It and its ${plural(p.version_count, "version")} are removed.${p.in_use ? " Its agent switches to another of its prompts, or the default persona." : ""}`, "Delete"))) return; await api("DELETE", `/api/prompts/${p.id}`); toast("Prompt deleted."); refreshPrompts(); refreshBell(); }

/* ---------- tour ---------- */
const TOUR = [
  { sel: "#rail", view: "dashboard", title: "Welcome to Kaho AI Studio", text: "Everything lives in this sidebar. Hover it to see the names. Here's a quick walk through, about a minute." },
  { sel: "#kpis", view: "dashboard", title: "Your dashboard", text: "How many calls went out, how many people picked up, and how many real conversations happened." },
  { sel: "#outcome-card", view: "dashboard", title: "How calls ended", text: "Picked up, no answer, declined or failed, at a glance. Sync with Plivo fills in older calls." },
  { sel: "#new-call-card", view: "calls", title: "Make a call", text: "Pick an agent and your number, type who to call, and watch the conversation live on the right." },
  { sel: "#view-contacts .list", view: "contacts", title: "Contacts", text: "Your people, their last call and tags. Click one for every call with them; mark anyone Do not call." },
  { sel: "#new-agent", view: "agents", title: "Agents", text: "Make one agent per job. Each has its own prompts, tools and call settings, and a Test call button." },
  { sel: "#view-prompts .list", view: "prompts", title: "Prompts", text: "Every prompt in one table: which agent uses it and how many versions it has. Move or edit from ⋯." },
  { sel: "#view-numbers .list", view: "numbers", title: "Numbers", text: "Your phone lines, and which agent answers each one." },
  { sel: "#bell-btn", title: "Notifications", text: "Changes in your workspace show up here. Click one to jump straight to it." },
  { sel: "#me-btn", title: "Your profile", text: "Your account, what's linked to it, and your team's invite code. Press ? any time to see this tour again." },
];
let tourAt = -1, spot = null, pop = null;
function startTour() { endTour(); tourAt = 0; spot = el("div", { className: "tour-spot" }); pop = el("div", { className: "tour-pop", role: "dialog", ariaLabel: "Tour" }); document.body.append(spot, pop); showStep(); }
function endTour() { if (spot) spot.remove(); if (pop) pop.remove(); spot = pop = null; tourAt = -1; store.set("kaho-toured", "1"); $("rail").classList.remove("pinned"); }
function showStep() {
  const s = TOUR[tourAt]; if (!s) return endTour();
  if (s.view && !location.hash.startsWith("#" + s.view)) go("#" + s.view);
  $("rail").classList.toggle("pinned", s.sel === "#rail" || s.sel === "#me-btn");
  setTimeout(() => {
    const target = document.querySelector(s.sel); if (!target) { tourAt++; return showStep(); }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      const r = target.getBoundingClientRect(), m = 8;
      Object.assign(spot.style, { left: `${r.left - m}px`, top: `${r.top - m}px`, width: `${r.width + 2 * m}px`, height: `${r.height + 2 * m}px` });
      const back = el("button", { type: "button", className: "ghost small-btn", disabled: tourAt === 0 }, "Back"), next = el("button", { type: "button", className: "primary small-btn" }, tourAt === TOUR.length - 1 ? "Done" : "Next"), skip = el("button", { type: "button", className: "link", style: "font-size:13px;color:var(--ink-500)" }, "Skip tour");
      back.onclick = () => { tourAt--; showStep(); }; next.onclick = () => { tourAt++; showStep(); }; skip.onclick = endTour;
      pop.replaceChildren(el("div", { className: "step", textContent: `${tourAt + 1} of ${TOUR.length}` }), el("h3", { textContent: s.title }), el("p", { textContent: s.text }), el("div", { className: "actions" }, skip, el("div", { style: "display:flex;gap:8px" }, back, next)));
      const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = innerWidth, vh = innerHeight;
      let left = r.right + 20, top = r.top;
      if (left + pw > vw - 16) { left = Math.min(Math.max(16, r.left), vw - pw - 16); top = r.bottom + 20; }
      if (top + ph > vh - 16) top = Math.max(16, r.top - ph - 20);
      Object.assign(pop.style, { left: `${left}px`, top: `${Math.max(16, top)}px` }); next.focus();
    }, 320);
  }, 120);
}
$("help-btn").onclick = startTour;
addEventListener("resize", () => { if (tourAt >= 0) showStep(); });

/* ---------- keys, boot ---------- */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && location.hash.startsWith("#agents/") && agentTab === "prompt") { e.preventDefault(); savePrompt(); }
  if (e.key === "Escape") { if (tourAt >= 0) return endTour(); document.querySelectorAll(".scrim.open").forEach((s) => s.classList.remove("open")); closeMenus(); closeDrawer(); }
  if (tourAt >= 0 && e.key === "ArrowRight") { tourAt++; showStep(); }
  if (tourAt >= 0 && e.key === "ArrowLeft" && tourAt > 0) { tourAt--; showStep(); }
});
window.addEventListener("beforeunload", (e) => { if (location.hash.startsWith("#agents/") && unsaved()) { e.preventDefault(); e.returnValue = ""; } });
let bellTimer = null;
async function boot() {
  S.me = await api("GET", "/api/me");
  $("auth").hidden = true; $("app").hidden = false; renderMe();
  $("add-btn").hidden = !isOwner(); $("d-sync").hidden = !isOwner();
  const [cfg, provs, tools] = await Promise.all([api("GET", "/api/config"), api("GET", "/api/providers"), api("GET", "/api/tools")]);
  S.cfg = cfg; S.providers = provs; S.tools = tools; renderAddMenu();
  await Promise.all([refreshPrompts(true), refreshContacts()]);
  await refreshAgents(); await refreshNumbers();
  route(); refreshBell(); clearInterval(bellTimer); bellTimer = setInterval(refreshBell, 30000);
}
(async () => { try { await boot(); } catch { showAuth(); } })();
