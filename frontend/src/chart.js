// What a "calls per day" chart needs to explain itself: a sensible top for the scale, the
// busiest day, the totals, and the few dates worth printing under it.
export function chartFacts(byDay) {
  const days = Array.isArray(byDay) ? byDay : [];
  const most = Math.max(0, ...days.map((d) => d.calls));
  // A round top, so the numbers on the side are ones a person can read at a glance.
  const steps = [4, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];
  const top = steps.find((s) => s >= most) ?? Math.ceil(most / 1000) * 1000;
  const busiest = most > 0 ? days.reduce((a, d) => (d.calls > a.calls ? d : a)) : null;
  const ticks = days.length === 0 ? []
    : [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].map((i) => days[i]);
  return { top, busiest, ticks, calls: days.reduce((n, d) => n + d.calls, 0), answered: days.reduce((n, d) => n + d.answered, 0) };
}
