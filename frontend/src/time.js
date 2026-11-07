// Days as people say them. Always India's day, because that is where the calls are made:
// a call at half past midnight is "today" to the person who made it, not "yesterday".
const IST = "Asia/Kolkata";

function parts(date) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return { y: +p.year, m: +p.month, d: +p.day };
}
const dayNumber = ({ y, m, d }) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

export function dayWord(iso, now = new Date()) {
  if (!iso) return "-";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "-";
  const a = parts(when), b = parts(now);
  const apart = dayNumber(b) - dayNumber(a);
  if (apart === 0) return "Today";
  if (apart === 1) return "Yesterday";
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short",
    ...(a.y === b.y ? {} : { year: "numeric" }) }).format(when);
  return text;
}
