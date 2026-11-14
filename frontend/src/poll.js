// Refresh something on a timer, but only while someone can see it. A tab left open in the
// background used to ask the server every few seconds for ever; with thousands of people
// signed in, nearly all of those requests were for nobody. Returns a function that stops it.
//
// - Nothing is asked while the tab is hidden; when it is shown again it refreshes at once.
// - A request is never started while the last one is still out, so a slow server is not piled on.
// - A failed request does not stop the polling (the caller shows its own error).

/** The real page: hidden or not, and a way to hear when that changes. */
export const browserPage = () => ({
  hidden: () => typeof document !== "undefined" && document.hidden,
  onChange: (cb) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", cb);
    return () => document.removeEventListener("visibilitychange", cb);
  },
});

export function startPolling(fn, ms, page = browserPage()) {
  let timer = null;
  let out = false;
  let stopped = false;
  const ask = async () => {
    if (stopped || out || page.hidden()) return;
    out = true;
    try { await fn(); } catch { /* the caller reports its own errors */ } finally { out = false; }
  };
  const arm = () => { if (!timer) timer = setInterval(ask, ms); };
  const disarm = () => { clearInterval(timer); timer = null; };
  const changed = () => {
    if (stopped) return;
    if (page.hidden()) disarm();
    else { arm(); ask(); }
  };
  const unlisten = page.onChange(changed);
  if (!page.hidden()) arm();
  return () => { stopped = true; disarm(); unlisten(); };
}
