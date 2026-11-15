// Book-a-call form: validation and the mailto fallback. Nothing here stores or logs data.
import { PLAN_NAMES } from "../content/pricing";

export const BUSINESS_TYPES = ["Clinic", "Salon", "Service company", "Other"] as const;

export type Booking = {
  name: string;
  business: string;
  phone: string;
  email: string;
  businessType: string;
  plan: string;
  message: string;
  website: string; // honeypot: people never see or fill it
};

export const emptyBooking: Booking = { name: "", business: "", phone: "", email: "", businessType: "", plan: "", message: "", website: "" };

/** A 10-digit Indian mobile number, with +91, 91 or 0 in front allowed. Returns the 10 digits or null. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;
  const digits = s.replace(/^\+?91(?=\d{10}$)/, "").replace(/^0(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

export type Errors = Partial<Record<keyof Booking, string>>;

export function validateBooking(f: Booking): Errors {
  const e: Errors = {};
  if (!f.name.trim()) e.name = "Please enter your name.";
  if (!f.business.trim()) e.business = "Please enter your business name.";
  if (!f.phone.trim()) e.phone = "Please enter your phone number.";
  else if (!normalizePhone(f.phone)) e.phone = "Please enter a 10-digit Indian mobile number.";
  if (!f.email.trim()) e.email = "Please enter your email.";
  else if (!isEmail(f.email)) e.email = "Please enter a valid email address.";
  if (!f.businessType) e.businessType = "Please choose your business type.";
  return e;
}

/** ?plan=growth -> "Growth". Only known plan names are accepted. */
export function planFromSearch(search: string): string {
  const raw = new URLSearchParams(search).get("plan") || "";
  return PLAN_NAMES.find((p) => p.toLowerCase() === raw.trim().toLowerCase()) || "";
}

const LABELS: [keyof Booking, string][] = [
  ["name", "Name"], ["business", "Business"], ["phone", "Phone"], ["email", "Email"],
  ["businessType", "Business type"], ["plan", "Plan"], ["message", "Message"],
];

export function bookingPayload(f: Booking) {
  return Object.fromEntries(LABELS.map(([k]) => [k, f[k].trim()]));
}

export function mailtoHref(to: string, f: Booking): string {
  const body = LABELS.map(([k, label]) => `${label}: ${f[k].trim() || "-"}`).join("\n");
  return `mailto:${to}?subject=${encodeURIComponent(`Demo call request: ${f.business.trim()}`)}&body=${encodeURIComponent(body)}`;
}

export function isSafeHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}
