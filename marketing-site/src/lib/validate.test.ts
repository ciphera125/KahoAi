import { describe, expect, test } from "vitest";
import { validateBooking, normalizePhone, isEmail, planFromSearch, mailtoHref, emptyBooking, isSafeHttpsUrl } from "./validate";

const good = { ...emptyBooking, name: "Asha", business: "Asha Clinic", phone: "98765 43210", email: "asha@example.com", businessType: "Clinic" };

describe("phone", () => {
  test("accepts a 10-digit Indian mobile with or without +91, spaces or dashes", () => {
    expect(normalizePhone("9876543210")).toBe("9876543210");
    expect(normalizePhone("+91 98765-43210")).toBe("9876543210");
    expect(normalizePhone("098765 43210")).toBe("9876543210");
  });
  test("rejects landlines, short numbers and letters", () => {
    expect(normalizePhone("1234567890")).toBeNull();
    expect(normalizePhone("98765")).toBeNull();
    expect(normalizePhone("98765abcde")).toBeNull();
  });
});

describe("email", () => {
  test("simple format check", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail("a b@c.com")).toBe(false);
  });
});

describe("validateBooking", () => {
  test("a complete form has no errors", () => {
    expect(validateBooking(good)).toEqual({});
  });
  test("required fields are named", () => {
    const e = validateBooking(emptyBooking);
    expect(Object.keys(e).sort()).toEqual(["business", "businessType", "email", "name", "phone"]);
  });
  test("bad email and phone get their own messages", () => {
    const e = validateBooking({ ...good, email: "nope", phone: "12" });
    expect(e.email).toMatch(/email/i);
    expect(e.phone).toMatch(/10-digit/);
  });
});

describe("planFromSearch", () => {
  test("prefills a known plan, ignores anything else", () => {
    expect(planFromSearch("?plan=Growth")).toBe("Growth");
    expect(planFromSearch("?plan=growth")).toBe("Growth");
    expect(planFromSearch("?plan=<script>")).toBe("");
    expect(planFromSearch("")).toBe("");
  });
});

describe("mailtoHref", () => {
  test("encodes every field and never includes the honeypot", () => {
    const href = mailtoHref("hello@kaho.ai", { ...good, website: "spam", message: "Hi & bye" });
    expect(href.startsWith("mailto:hello@kaho.ai?subject=")).toBe(true);
    expect(href).toContain(encodeURIComponent("Asha Clinic"));
    expect(href).toContain(encodeURIComponent("Hi & bye"));
    expect(href).not.toContain("spam");
  });
});

describe("isSafeHttpsUrl", () => {
  test("only https URLs are embedded or posted to", () => {
    expect(isSafeHttpsUrl("https://cal.com/kaho/demo")).toBe(true);
    expect(isSafeHttpsUrl("http://example.com")).toBe(false);
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("")).toBe(false);
  });
});
