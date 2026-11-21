// An instant as people in India read it. Everything stored is UTC; everything shown or spoken is
// India's clock, or a task due at 1 a.m. on the 15th is read out as the 14th (2026-11-22).
const TZ = "Asia/Kolkata";

const parts = (iso, options) => {
  const when = iso instanceof Date ? iso : new Date(String(iso));
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...options }).formatToParts(when)
    .reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
};

/** "Fri 13 Nov, 9:00 am": for a line on screen. */
export function shortWhen(iso) {
  const p = parts(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  if (!p) return null;
  return `${p.weekday} ${p.day} ${p.month}, ${Number(p.hour)}:${p.minute} ${p.dayPeriod.toLowerCase()}`;
}

/** "Friday 13 November at 9:00 am": for the agent to say out loud. */
export function spokenWhen(iso) {
  const p = parts(iso, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });
  if (!p) return null;
  return `${p.weekday} ${p.day} ${p.month} at ${Number(p.hour)}:${p.minute} ${p.dayPeriod.toLowerCase()}`;
}

/** "2026-11-13T09:00:00+05:30": the same instant, written on India's clock, so a model reading it
 * never has to work out the time zone itself. */
export function indiaIso(iso) {
  const p = parts(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (!p) return null;
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}+05:30`;
}
