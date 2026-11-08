// A call written out as plain text, and the name its files are given.
//
// The same text is what the "Download transcript" button serves and what is saved beside
// the recording in Supabase Storage, so what a person reads in either place is the same.
// Everything in it is already masked: it is built from the stored lines, never the audio.
const IST = "Asia/Kolkata";

const fmt = (iso, options) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, ...options }).format(new Date(iso));
const clock = (iso) => fmt(iso, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }).toLowerCase();

function length(secs) {
  if (!Number.isFinite(Number(secs)) || secs === null) return null;
  const s = Math.round(secs);
  if (s < 60) return `${s} sec`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} sec` : ""}`;
}

export function transcriptText({ name = null, peer = null, agent = null, startedAt = null,
  durationSecs = null, turns = [], answers = [] } = {}) {
  const who = name ? (peer ? `${name} (${peer})` : name) : (peer ?? "an unknown caller");
  const lines = [`Call with ${who}`];
  if (agent) lines.push(`Agent: ${agent}`);
  if (startedAt) {
    lines.push(`Date: ${fmt(startedAt, { day: "numeric", month: "short", year: "numeric" })}, `
      + `${fmt(startedAt, { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase()} IST`);
  }
  if (length(durationSecs)) lines.push(`Length: ${length(durationSecs)}`);
  lines.push("");
  if (!turns.length) lines.push("Nothing was said on this call.");
  for (const t of turns) lines.push(`[${clock(t.at)}] ${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`);
  if (answers.length) {
    lines.push("", "Saved on this call:", ...answers.map((a) => `${a.label}: ${a.value}`));
  }
  return `${lines.join("\n")}\n`;
}

/** `Ravi-Kumar_2026-11-08_1555_ab12cd34`: who, the day and time in India, a short id. The
 * name can come from a person, so only letters, digits, - and _ survive: it ends up in a
 * path in storage and in a download's file name. */
export function fileStem({ name = null, peer = null, startedAt = null, callId = "" } = {}) {
  const clean = (text) => String(text ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const who = clean(name).slice(0, 40) || clean(peer).slice(0, 20) || "unknown";
  let when = "undated";
  if (startedAt && !Number.isNaN(new Date(startedAt).getTime())) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(startedAt))
      .reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
    when = `${p.year}-${p.month}-${p.day}_${p.hour === "24" ? "00" : p.hour}${p.minute}`;
  }
  const id = String(callId).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "call";
  return `${who}_${when}_${id}`;
}
