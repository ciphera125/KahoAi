// Paging a list that is already in the browser. Lists the Studio fetches whole (agents,
// prompts, numbers, team, tags, tasks) are cut into pages here, so a page never grows
// down the screen as the list does. Lists that are big enough to page on the server
// (calls, contacts) keep doing that.
export const SIZES = [10, 25, 50, 100];

export function paginate(items, page, size = 10) {
  const per = Number.isInteger(size) && size > 0 ? size : 10;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const wanted = Number.parseInt(page, 10);
  const at = Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), pages) : 1;
  const start = (at - 1) * per;
  return { items: items.slice(start, start + per), page: at, pages, total,
    from: total ? start + 1 : 0, to: Math.min(start + per, total) };
}

/** Which page numbers to show: the first, the last, and a few around where you are. */
export function pageNumbers(page, pages) {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1);
  const wanted = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 2) wanted.add(3);
  if (page >= pages - 1) wanted.add(pages - 2);
  const sorted = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("…");
    out.push(n);
  });
  return out;
}

/** The same numbers `paginate` gives, for a list the server pages: it sends one page and
 * the total, so there is nothing to cut here, only a footer to describe. */
export function serverView({ page, total, size }) {
  const per = Number.isInteger(size) && size > 0 ? size : 10;
  const pages = Math.max(1, Math.ceil(total / per));
  const at = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), pages);
  const start = (at - 1) * per;
  return { page: at, pages, total, from: total ? start + 1 : 0, to: Math.min(start + per, total) };
}
