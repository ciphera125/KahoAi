// The one place the Studio talks to a language model (Groq). "Test this agent" and the setup
// assistant both use it, so there is one key, one deadline, and one thing tests replace.
import { config } from "../config/env.js";

const TIMEOUT_MS = 25000;

let injected = null;
/** Tests hand in a stand-in. null puts the real one back. */
export const useModel = (fn) => { injected = fn; };

async function groq({ messages, tools, maxTokens = 600, effort = "medium", toolChoice = "auto" }) {
  const key = config.GROQ_API_KEY;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.GROQ_MODEL_ID, messages, max_tokens: maxTokens,
      reasoning_effort: effort, ...(tools ? { tools, tool_choice: toolChoice } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `the model answered ${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code;
    error.generation = body?.error?.failed_generation;
    throw error;
  }
  return { message: body.choices?.[0]?.message ?? {} };
}

export const model = () => injected ?? (config.GROQ_API_KEY ? groq : null);

