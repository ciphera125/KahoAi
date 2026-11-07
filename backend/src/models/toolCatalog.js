// The tools an agent can be given. Kept apart from Agent.js so promptCheck.js can
// read it without a circular import (Agent.js -> Prompt.js -> promptCheck.js).
export const KNOWN_TOOLS = ["end_call", "capture_lead", "save_answer", "transfer_to_human", "call_webhook"];
export const DEFAULT_TOOLS = ["end_call", "capture_lead"];

export const TOOL_CATALOG = [
  { name: "end_call", label: "End the call",
    description: "Hangs up once the person says goodbye, or says no to “anything else?”.", needs: null },
  { name: "capture_lead", label: "Save details",
    description: "Saves the person's name, number and what they need, for a follow-up.", needs: null },
  { name: "save_answer", label: "Save what the caller says",
    description: "Saves the answers to the questions you set below, like a payment date or an amount.", needs: null },
  { name: "transfer_to_human", label: "Transfer to a person",
    description: "Hands the call to your team's number when the person asks for a human.", needs: "TRANSFER_NUMBER" },
  { name: "call_webhook", label: "Your system (webhook)",
    description: "Looks something up or saves it in your own system, through a webhook.", needs: "TOOL_WEBHOOK_URL" },
];

export const labelOf = (name) => TOOL_CATALOG.find((t) => t.name === name)?.label ?? null;
