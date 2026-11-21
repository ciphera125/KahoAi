// All page copy lives here. Plain, warm, short. Nothing invented: no clients, no
// statistics, no channels other than voice, no languages other than Hindi and English.
// Kaho makes OUTBOUND calls only: the business's agent calls its customers and leads.
import type { IconName } from "../components/Icon";

export type Turn = { who: "agent" | "customer"; text: string; hindi?: boolean };

export const hero = {
  eyebrow: "Voice agents for businesses",
  title: ["Your follow-up calls, made", "for you."] as const, // second part is the one serif phrase
  sub: "Kaho AI calls your customers for you. It reminds them about appointments, follows up with leads and books the slot on the call, in Hindi and English.",
  example: {
    label: "Example conversation",
    status: "Kaho is calling a customer",
    turns: [
      { who: "agent", text: "Hello, this is a reminder from the clinic about your follow-up visit. Is tomorrow at 11:30 AM good for you?" },
      { who: "customer", text: "हाँ, कल सुबह ठीक रहेगा।", hindi: true },
      { who: "agent", text: "Done. You are booked for tomorrow at 11:30 AM." },
    ] as Turn[],
  },
};

export const talk = {
  eyebrow: "Talk to Kaho",
  title: "Talk to Kaho right now",
  line: "Call our AI agent and speak to it in Hindi or English. No sign-up needed.",
};

export const beforeAfter = {
  eyebrow: "Follow-ups",
  title: ["What happens to a lead nobody calls", "back?"] as const,
  without: {
    label: "Without Kaho",
    text: "A customer enquires on Monday. The team gets busy and nobody calls back. By Thursday they have booked somewhere else.",
    tag: "Customer lost",
  },
  with: {
    label: "With Kaho",
    text: "Kaho calls them back, answers their questions and books a visit for tomorrow at 11:30 AM.",
    tag: "Appointment booked",
  },
};

export const agents = {
  eyebrow: "Agents",
  title: ["One platform, many", "jobs"] as const,
  items: [
    { icon: "calendar", title: "Appointment booking", text: "Calls your customers, checks availability and books the slot during the call." },
    { icon: "bell", title: "Reminders and follow-ups", text: "Calls customers about upcoming appointments and pending items so fewer people forget." },
    { icon: "filter", title: "Lead qualification", text: "Calls new leads, asks the right questions and hands your team only the serious ones." },
  ] as { icon: IconName; title: string; text: string }[],
  tag: "Hindi + English",
};

export const how = {
  eyebrow: "How it works",
  title: ["Live in three", "steps"] as const,
  steps: [
    { title: "Tell us about your business", text: "Share your services, timings and how you like to talk to customers." },
    { title: "We set up your agent", text: "We build your agent and connect it to your own phone number." },
    { title: "Calls go out, you stay in control", text: "Every call, contact and transcript appears in your dashboard." },
  ],
};

export const whatYouGet = {
  eyebrow: "What you get",
  title: ["Every follow-up made, without the", "busywork"] as const,
  tiles: [
    { icon: "outgoing", title: "Calls your customers for you" },
    { icon: "bell", title: "Reminders and follow-ups on time" },
    { icon: "calendar", title: "Books appointments on the call" },
    { icon: "language", title: "Hindi and English in one call" },
    { icon: "dashboard", title: "Dashboard with contacts, call logs and transcripts" },
    { icon: "wave", title: "Handles interruptions like a person" },
  ] as { icon: IconName; title: string }[],
  link: "See all features",
};

export const dashboard = {
  eyebrow: "Dashboard",
  title: ["See every call, in one", "place"] as const,
  line: "Contacts, call logs and full transcripts, all in your Kaho dashboard.",
  sampleLabel: "Sample data",
  nav: ["Dashboard", "Contacts", "Call logs"],
  rows: [
    { name: "Sample contact 1", time: "09:42 AM", duration: "2m 10s", outcome: "Appointment booked" },
    { name: "Sample contact 2", time: "11:05 AM", duration: "1m 34s", outcome: "Reminder confirmed" },
    { name: "Sample contact 3", time: "04:18 PM", duration: "3m 02s", outcome: "Lead qualified" },
  ],
};

export const faq = {
  eyebrow: "FAQ",
  title: ["Questions,", "answered"] as const,
};

/** The last answer depends on whether the demo number is public yet. */
export function faqItems(hasDemo: boolean) {
  return [
    { q: "Which languages do you support?", a: "Hindi and English. If your customer switches language during the call, the agent switches with them." },
    { q: "Who does the agent call?", a: "Only the customers and leads you give it, at the times you choose." },
    { q: "How long does setup take?", a: "We set up your agent with you. The timing depends on your use case, and we will tell you on the call." },
    { q: "Do I need my own phone number?", a: "Yes. You bring your own number and telephony provider, and the calls go out from it." },
    // TODO(legal): replace after legal review of call-recording consent under DPDP.
    { q: "Are calls recorded, and where is the data kept?", a: "We will share the details of recording and data handling on the call." },
    // TODO(product): confirm this matches what the agent really does.
    { q: "What happens if the agent cannot answer a question?", a: "The agent tells the customer politely and notes the question so your team can follow up." },
    { q: "How much does it cost?", a: "It depends on your plan and call volume. Book a call and we will share pricing for your business." },
    {
      q: "Can I try it before paying?",
      a: hasDemo ? "Call our demo number, or book a call and we will show you a live demo." : "Book a call and we will show you a live demo.",
    },
  ];
}

export const calculator = {
  eyebrow: "Missed follow-ups",
  title: ["You are missing out on customers every", "minute"] as const,
  intro: "Enter your own numbers to see what leads without a follow-up call cost you.",
  inputs: {
    callsPerDay: { label: "New enquiries or leads per day", start: "40" },
    missedPct: { label: "Leads nobody calls back (%)", start: "30" },
    customerValue: { label: "Average value of one customer (Rs)", start: "1500" },
  },
  outputs: {
    perDay: "Customers lost per day",
    perMonth: "Customers lost per month",
    perMinute: "Lost per minute of business hours",
    revenue: "Estimated revenue lost per month",
  },
  exampleNote: "Example values. Change them to your own.",
  note: "Based on the numbers you entered. Your own figures will differ.",
};

export const homeCta = { title: "You are missing out on customers every minute. Let's fix that." };
export const featuresCta = { title: "Ready to hear it call your customers?" };

export const featuresPage = {
  eyebrow: "Features",
  title: ["Everything your follow-up calls", "need"] as const,
  sub: "One voice agent for your reminders, follow-ups and lead calls, in Hindi and English.",
  blocks: [
    { art: "outgoing", title: "Calls your customers for you", text: "Reminders, follow-ups and lead calls, made for you and logged automatically." },
    { art: "list", title: "Works through your whole list", text: "Give Kaho your contacts and it calls them, several at a time, within the hours you set." },
    { art: "booking", title: "Books appointments on the call", text: "The agent checks availability and confirms the slot while the customer is still on the line." },
    { art: "language", title: "Hindi and English in the same call", text: "If your customer starts in Hindi and switches to English, the agent keeps up without restarting." },
    { art: "person", title: "Talks like a person", text: "Handles interruptions, replies in short natural sentences, and pauses when the customer speaks." },
    { art: "dashboard", title: "Your dashboard", text: "Contacts, call logs and transcripts in one place, so you can review any call." },
    { art: "number", title: "Calls from your own number", text: "Calls go out from your own phone number and telephony provider. We connect Kaho to them." },
    { art: "setup", title: "Set up around your business", text: "Your services, your timings, your tone. We shape the agent to fit how you already talk to customers." },
  ] as const,
};

export const bookPage = {
  eyebrow: "Book a call",
  title: ["Book a 15-minute demo", "call"] as const,
  intro: "On the call we will show you a live demo, recommend the right plan for your call volume and share pricing.",
  points: ["No obligation", "See a live demo on a real call", "Get your questions answered", "Get a plan recommended for your call volume"],
};
