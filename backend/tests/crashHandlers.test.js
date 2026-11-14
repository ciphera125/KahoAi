// A stray rejection or exception in a worker must leave a structured log line and a clean exit
// (the primary starts another worker), never a bare stack on stderr and a half-alive process.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installCrashHandlers } from "../src/utils/crash.js";

function setup() {
  const proc = new EventEmitter();
  const exits = [];
  proc.exit = (code) => exits.push(code);
  const lines = [];
  const log = { fatal: (o, m) => lines.push({ o, m }) };
  installCrashHandlers(proc, log);
  return { proc, exits, lines };
}

describe("crash handlers", () => {
  it("an unhandled rejection is logged with its reason and the worker exits non-zero", () => {
    const { proc, exits, lines } = setup();
    proc.emit("unhandledRejection", new Error("boom"));
    expect(lines).toHaveLength(1);
    expect(lines[0].o.err).toBe("boom");
    expect(exits).toEqual([1]);
  });

  it("an uncaught exception is logged and the worker exits non-zero", () => {
    const { proc, exits, lines } = setup();
    proc.emit("uncaughtException", new Error("bad"));
    expect(lines[0].o.err).toBe("bad");
    expect(exits).toEqual([1]);
  });

  it("a non-error reason is logged as text, truncated, and never throws", () => {
    const { proc, exits, lines } = setup();
    proc.emit("unhandledRejection", "x".repeat(5000));
    expect(lines[0].o.err.length).toBeLessThanOrEqual(300);
    proc.emit("unhandledRejection", undefined);
    proc.emit("unhandledRejection", Object.create(null));
    expect(exits).toEqual([1, 1, 1]);
  });

  it("does not put a bearer token or key in the log line", () => {
    const { proc, lines } = setup();
    proc.emit("unhandledRejection", new Error("request failed: Authorization: Bearer abcdef123456 api_key=sk-secretsecret"));
    expect(lines[0].o.err).not.toMatch(/abcdef123456|secretsecret/);
    expect(JSON.stringify(lines[0].o)).not.toMatch(/abcdef123456|secretsecret/); // the stack repeats the message
  });
});
