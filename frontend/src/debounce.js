export function debounce(fn, ms) {
  let timer;
  const run = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  run.cancel = () => clearTimeout(timer);
  return run;
}
