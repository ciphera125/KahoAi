// Who may ever hold an admin account, as shipped: exactly the two addresses the owner named (2026-11-15), and no one
// else. The other admin tests set the list themselves so they can change it; this one reads what a fresh server gets.
import { describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { isAllowed } from "../src/models/Admin.js";

describe("the admin allowlist a fresh server starts with", () => {
  it("is exactly the two addresses the owner named", () => {
    expect(config.adminEmails).toEqual(["adityanair5002@gmail.com", "aayushimakker10@gmail.com"]);
  });

  it("lets those two in, whatever the capital letters, and no one else", () => {
    expect(isAllowed("adityanair5002@gmail.com")).toBe(true);
    expect(isAllowed(" AadityaNair5002@Gmail.com ".replace("Aaditya", "Aditya"))).toBe(true);
    expect(isAllowed("aayushimakker10@gmail.com")).toBe(true);
    for (const other of ["ayushimakkad10@gmail.com", "adityanir5002@gmail.com", "aayushimakkad10@gmail.com", "adityanair5002+x@gmail.com",
      "aayushimakker10+x@gmail.com", "adityanair5002@gmail.com.evil.in", "someone@gmail.com", "", null, undefined, ["adityanair5002@gmail.com"]]) {
      expect(isAllowed(other), String(other)).toBe(false);
    }
  });

  it("is two addresses, not more: a third would be a person nobody agreed to", () => {
    expect(config.adminEmails).toHaveLength(2);
    expect(new Set(config.adminEmails).size).toBe(2);
  });
});
