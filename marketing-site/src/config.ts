// Build-time settings from .env (see .env.example). All optional.
import { createContext, useContext } from "react";

export type SiteConfig = {
  demoPhone: string; // VITE_DEMO_PHONE: empty hides the Talk to Kaho section
  bookingUrl: string; // VITE_BOOKING_URL: Cal.com or Calendly page to embed (https only)
  formEndpoint: string; // VITE_FORM_ENDPOINT: where the form is POSTed as JSON (https only)
  contactEmail: string; // VITE_CONTACT_EMAIL: mailto fallback for the form
};

const env = import.meta.env;

export const envConfig: SiteConfig = {
  demoPhone: (env.VITE_DEMO_PHONE || "").trim(),
  bookingUrl: (env.VITE_BOOKING_URL || "").trim(),
  formEndpoint: (env.VITE_FORM_ENDPOINT || "").trim(),
  // The footer already lists this address publicly; used only when the env var is empty.
  contactEmail: (env.VITE_CONTACT_EMAIL || "").trim() || "hello@kaho.ai",
};

export const ConfigContext = createContext<SiteConfig>(envConfig);
export const useConfig = () => useContext(ConfigContext);

/** "+91 80000 00000" -> "tel:+918000000000" */
export const telHref = (phone: string) => "tel:" + phone.replace(/[^\d+]/g, "");

export const SITE_URL = "https://kahoai.in";
