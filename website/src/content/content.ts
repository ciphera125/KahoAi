// All page copy lives here. Plain, warm, short. Nothing invented: no clients, no
// statistics, no channels other than voice, no languages other than Hindi and English.
import type { IconName } from "../components/Icon";

export const hero = {
  eyebrow: "Voice agents for Indian businesses",
  title: ["Never miss a customer call", "again."] as const, // second part is the one serif word
  sub: "Kaho AI answers your calls, books appointments and follows up with your customers, in Hindi and English, all day and night.",
  example: {
    label: "Example conversation",
    customer: "मुझे कल की अपॉइंटमेंट चाहिए।",
    agent: "Sure, I have 11:30 AM free tomorrow. Shall I book it?",
  },
};

export const talk = {
  eyebrow: "Talk to Kaho",
  title: "Talk to Kaho right now",
  line: "Call our AI agent and speak to it in Hindi or English. No sign-up needed.",
};

export const beforeAfter = {
  eyebrow: "After hours",
  title: ["What happens to a call after", "7 PM?"] as const,
  without: {
    label: "Without Kaho",
    text: "Customer calls the clinic at 8:10 PM. Phone rings out. They call the next clinic.",
    tag: "Customer lost",
  },
  with: {
    label: "With Kaho",
    text: "Customer calls at 8:10 PM. Kaho answers, asks what they need, books tomorrow at 11:30 AM.",
    tag: "Appointment booked",
  },
};

export const agents = {
  eyebrow: "Agents",
  title: ["One platform, many", "jobs"] as const,
  items: [
    { icon: "calendar", title: "Appointment booking", text: "Answers the call, checks availability and books the slot while the customer is still on the line." },
    { icon: "bell", title: "Reminders and follow-ups", text: "Calls customers about upcoming appointments and pending items so fewer people forget." },
    { icon: "filter", title: "Lead qualification", text: "Asks the right questions and hands your team only the serious leads." },
  ] as { icon: IconName; title: string; text: string }[],
  tag: "Hindi + English",
};

export const how = {
  eyebrow: "How it works",
  title: ["Live in three", "steps"] as const,
  steps: [
    { title: "Tell us about your business", text: "Share your services, timings and how you like to talk to customers." },
    { title: "We set up your agent", text: "We build your agent and connect it to your own phone number." },
    { title: "Calls start, you stay in control", text: "Every call, contact and transcript appears in your dashboard." },
  ],
};

export const whatYouGet = {
  eyebrow: "What you get",
  title: ["Everything your front desk does, minus the", "missed calls"] as const,
  tiles: [
    { icon: "incoming", title: "Answers incoming calls" },
    { icon: "outgoing", title: "Makes outgoing calls" },
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
    { name: "Sample caller 1", time: "09:42 AM", duration: "2m 10s", outcome: "Appointment booked" },
    { name: "Sample caller 2", time: "11:05 AM", duration: "1m 34s", outcome: "Follow-up noted" },
    { name: "Sample caller 3", time: "07:18 PM", duration: "3m 02s", outcome: "Lead qualified" },
  ],
};

export const pricing = {
  eyebrow: "Pricing",
  title: ["Simple monthly", "pricing"] as const,
  sub: "Pay only for connected calls. No lock-in, cancel any month.",
};

export const faq = {
  eyebrow: "FAQ",
  title: ["Questions,", "answered"] as const,
};

/** FAQ 6 depends on whether the demo number is public yet. */
export function faqItems(hasDemo: boolean) {
  return [
    { q: "Which languages do you support?", a: "Hindi and English. If your customer switches language during the call, the agent switches with them." },
    { q: "How long does setup take?", a: "We set up your agent with you. The timing depends on your use case, and we will tell you on the call." },
    { q: "Do I need my own phone number?", a: "Yes. You bring your own number and telephony provider, and we connect to it." },
    // TODO(legal): replace after legal review of call-recording consent under DPDP.
    { q: "Are my calls recorded, and where is the data kept?", a: "We will share the details of recording and data handling on the call." },
    // TODO(product): confirm this matches what the agent really does.
    { q: "What happens if the agent cannot answer?", a: "The agent tells the caller politely and notes the request so your team can follow up." },
    {
      q: "Can I try it before paying?",
      a: hasDemo ? "Call our demo number, or book a call and we will show you a live demo." : "Book a call and we will show you a live demo.",
    },
  ];
}

export const calculator = {
  eyebrow: "Missed calls",
  title: ["You are missing out on customers every", "minute"] as const,
  intro: "Enter your own numbers to see what unanswered calls cost you.",
  inputs: {
    callsPerDay: { label: "Calls your business gets per day", start: "40" },
    missedPct: { label: "Calls you miss or cannot answer (%)", start: "30" },
    customerValue: { label: "Average value of one customer (Rs)", start: "1500" },
  },
  exampleNote: "Example values. Change them to your own.",
  note: "Based on the numbers you entered. Your own figures will differ.",
};

export const homeCta = { title: "You are missing out on customers every minute. Let's fix that." };
export const featuresCta = { title: "Ready to hear it on your own calls?" };

export const featuresPage = {
  eyebrow: "Features",
  title: ["Everything your phone line", "needs"] as const,
  sub: "One voice agent for your incoming calls, outgoing calls and follow-ups, in Hindi and English.",
  blocks: [
    { art: "incoming", title: "Answers every incoming call", text: "No hold music, no busy tone, even when several customers call together. Your agent is on the line day and night." },
    { art: "outgoing", title: "Makes outgoing calls", text: "Reminders, follow-ups and lead calls, made for you and logged automatically." },
    { art: "booking", title: "Books appointments on the call", text: "The agent checks availability and confirms the slot while the customer is still talking to it." },
    { art: "language", title: "Hindi and English in the same call", text: "If your customer starts in Hindi and switches to English, the agent keeps up without restarting." },
    { art: "person", title: "Talks like a person", text: "Handles interruptions, replies in short natural sentences, and pauses when the caller speaks." },
    { art: "dashboard", title: "Your dashboard", text: "Contacts, call logs and transcripts in one place, so you can review any call." },
    { art: "number", title: "Works with your own number", text: "Bring your own phone number and telephony provider. We connect Kaho to it." },
    { art: "setup", title: "Set up around your business", text: "Your services, your timings, your tone. We shape the agent to fit how you already talk to customers." },
  ] as const,
};

export const bookPage = {
  eyebrow: "Book a call",
  title: ["Book a 15-minute demo", "call"] as const,
  points: ["No obligation", "See a live demo on a real call", "Get your questions answered"],
};
