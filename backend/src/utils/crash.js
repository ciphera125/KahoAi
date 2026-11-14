// What a worker does when something nobody caught goes wrong: say so in the structured log,
// with the secrets stripped, and exit non-zero so the primary starts a clean worker. Carrying on
// after an uncaught exception leaves a process in a state nobody has reasoned about.

const SECRETS = [
  /\b(?:proxy-)?authorization\b['"]?\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[^\s,;'"}]+/gi,
  /\b(?:bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b[\w-]*(?:api[_-]?key|token|secret|passw(?:or)?d)\b['"]?\s*[:=]\s*[^\s,;'"}]+/gi,
  /\b(?:sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{6,}/g,
];

/** A reason as short, secret-free text, whatever it is. Never throws. */
export function describeReason(reason, max = 300) {
  let text;
  try { text = reason instanceof Error ? reason.message : String(reason); } catch { text = "unprintable reason"; }
  return scrub(text, max);
}

function scrub(text, max) {
  for (const re of SECRETS) text = text.replace(re, "[redacted]");
  return text.slice(0, max);
}

export function installCrashHandlers(proc, log) {
  const die = (what) => (reason) => {
    try { log.fatal({ err: describeReason(reason), stack: reason instanceof Error ? scrub(String(reason.stack ?? ""), 1500) : undefined }, what); } catch { /* exiting anyway */ }
    proc.exit(1);
  };
  proc.on("unhandledRejection", die("unhandled rejection; this worker will restart"));
  proc.on("uncaughtException", die("uncaught exception; this worker will restart"));
}
