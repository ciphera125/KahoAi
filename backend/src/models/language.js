// How the agent speaks on a call: three choices (owner, 2026-11-14): follow the caller, English,
// Hindi. Hinglish ("mix") is no longer offered; an agent saved with it follows the caller. The voice
// service still understands "mix" but is never sent it.
export const LANGUAGES = [
  { value: "auto", label: "Follow the caller", hint: "Replies in whatever language the caller speaks, turn by turn." },
  { value: "english", label: "English", hint: "Always English, even if the caller speaks Hindi." },
  { value: "hindi", label: "Hindi", hint: "Always Hindi, even if the caller speaks English." },
];
export const LANGUAGE_VALUES = LANGUAGES.map((l) => l.value);
export const DEFAULT_LANGUAGE = "auto";

/** Plain words for what is allowed, for an error message. */
export const LANGUAGE_CHOICES = LANGUAGES.map((l) => l.label).join(", ");
