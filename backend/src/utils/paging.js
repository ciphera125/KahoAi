// A page number that arrived from the network: always a whole number from 1 to MAX_PAGE, so it can
// never overflow the database's OFFSET (`?page=1e99` used to be a 500). Anything odd becomes page 1;
// anything huge becomes the last page we allow, which is simply empty.
export const MAX_PAGE = 100_000;

export function pageNumber(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}
