// How the agent speaks on a call. The same four modes as the voice service's language.py.
//
// "auto" is the default and what every agent did before this existed: answer in whatever
// language the caller used last. The others fix it for the whole call.
export const LANGUAGES = [
  { value: "auto", label: "Follow the caller", hint: "Hindi when they speak Hindi, English when they speak English, turn by turn." },
  { value: "english", label: "English only", hint: "Always English, even if the caller speaks Hindi." },
  { value: "hindi", label: "Hindi only", hint: "Always Hindi, even if the caller speaks English." },
  { value: "mix", label: "Hinglish (a mix)", hint: "Hindi and English mixed the way people talk." },
];
export const LANGUAGE_VALUES = LANGUAGES.map((l) => l.value);
export const DEFAULT_LANGUAGE = "auto";

/** Plain words for what is allowed, for an error message. */
export const LANGUAGE_CHOICES = LANGUAGES.map((l) => l.label).join(", ");
