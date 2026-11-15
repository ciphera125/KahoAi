// The admin site's address must be https once the server is in production, EXCEPT on this machine: the Studio itself
// runs from http://localhost in production mode, and a rule stricter than the Studio's would have stopped the backend
// from starting here (found 2026-11-15, before the restart that would have hit it).
import { describe, expect, it } from "vitest";
import { adminOriginsProblem } from "../src/config/env.js";

describe("where the admin site may be served from", () => {
  it("anything goes while developing", () => {
    expect(adminOriginsProblem(["http://localhost:5174", "http://admin.example.com"], false)).toBeNull();
  });

  it("in production an https address is fine", () => {
    expect(adminOriginsProblem(["https://admin.kaho.in"], true)).toBeNull();
  });

  it("in production a plain-http address on this machine is fine: localhost, 127.0.0.1, [::1]", () => {
    expect(adminOriginsProblem(["http://localhost:5174"], true)).toBeNull();
    expect(adminOriginsProblem(["http://127.0.0.1:5174"], true)).toBeNull();
    expect(adminOriginsProblem(["http://[::1]:5174"], true)).toBeNull();
  });

  it("in production a plain-http address anywhere else is refused, however much it looks like localhost", () => {
    for (const bad of ["http://admin.kaho.in", "http://localhost.evil.com", "http://localhost@evil.com", "http://evil.com/localhost",
      "http://127.0.0.1.evil.com", "http://192.168.1.5:5174", "http://0.0.0.0:5174"]) {
      expect(adminOriginsProblem([bad], true), bad).toMatch(/https/);
    }
  });

  it("one bad address among good ones is still refused", () => {
    expect(adminOriginsProblem(["https://admin.kaho.in", "http://admin.example.com"], true)).toMatch(/https/);
  });

  it("a value that is not an address is a problem, not a crash", () => {
    expect(adminOriginsProblem(["not a url"], true)).toMatch(/address/);
  });
});
