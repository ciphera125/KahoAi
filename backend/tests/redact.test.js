import { describe, expect, it } from "vitest";
import { redactPII } from "../src/models/redact.js";

describe("what is kept out of the files in Storage", () => {
  it("removes e-mail addresses", () => {
    expect(redactPII("mail me at ravi.k+loan@gmail.com please")).toBe("mail me at [email] please");
  });
  it("removes phone numbers however they are written, but not dates, amounts or short numbers", () => {
    expect(redactPII("call 9876543210 or +91 98765 43210 or 098-7654-3210")).toBe("call [number] or [number] or [number]");
    expect(redactPII("the date is 2026-12-05, EMI 5,00,000 rupees, 4 people, 1234")).toBe("the date is 2026-12-05, EMI 5,00,000 rupees, 4 people, 1234");
  });
  it("removes long number runs of any kind (card, account, Aadhaar that slipped through)", () => {
    expect(redactPII("account 123456789012 and 4111 1111 1111 1111")).toBe("account [number] and [number]");
  });
  it("leaves already masked values as they are", () => {
    expect(redactPII("Aadhaar XXXX XXXX 1234 and PAN XXXXX1234X")).toBe("Aadhaar XXXX XXXX 1234 and PAN XXXXX1234X");
  });
  it("removes a PAN that slipped through", () => {
    expect(redactPII("my PAN is ABCDE1234F ok")).toBe("my PAN is [PAN] ok");
  });
  it("removes the names it is told about, whole words only, any case, and their parts", () => {
    expect(redactPII("Hello Ravi Kumar, is this ravi? Kumari is fine", { names: ["Ravi Kumar"] })).toBe("Hello [name] [name], is this [name]? Kumari is fine");
  });
  it("ignores names too short to remove safely, and a name that is a common word is still only removed whole", () => {
    expect(redactPII("Al is here", { names: ["Al"] })).toBe("Al is here");
  });
  it("does not choke on nothing, on non-text, or on very long text", () => {
    expect(redactPII("")).toBe("");
    expect(redactPII(null)).toBe("");
    expect(redactPII(undefined)).toBe("");
    const long = "9".repeat(100000);
    expect(redactPII(long)).toBe("[number]");
  });
  it("is the same when run twice", () => {
    const once = redactPII("9876543210 a@b.co Ravi", { names: ["Ravi"] });
    expect(redactPII(once, { names: ["Ravi"] })).toBe(once);
  });
});
