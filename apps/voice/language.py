"""Which language the agent speaks on a call.

Four modes. `auto` is the default and what the agent did before this existed: answer in
whatever language the caller used on their latest turn, and tune the voice to match.
`english`, `hindi` and `mix` fix it for the call, however the caller speaks.

The mode is chosen on the agent (published like its prompt) and may be overridden for one
call on the Calls page. It reaches here as plain text, so `clean_mode` is the only door:
anything that is not one of the four becomes `auto` rather than being passed on, since the
value ends up inside the prompt the model reads.
"""

MODES = ("auto", "english", "hindi", "mix")
DEFAULT = "auto"


def clean_mode(raw) -> str:
    """One of MODES. Anything else, including a value that is not text at all, is auto."""
    if isinstance(raw, str) and raw.strip().lower() in MODES:
        return raw.strip().lower()
    return DEFAULT


# What the model is told. Each is the whole of what the prompt says about language, so the
# modes cannot contradict themselves (auto says to follow the caller; english must not).
_RULES = {
    "auto": """\
Answer in whatever language the caller just used, turn by turn. If they switch
to Hindi mid-conversation, switch with them; if they switch back, switch back.
Judge it from their latest turn alone, not from how the call opened. Open in
English unless they have already spoken. If they mix the two in one sentence,
answer in the language most of their words were in.

Speech recognition sometimes writes a caller's Hindi in Roman letters ("aap kahan
se bol rahe ho"). That is still Hindi: answer in Hindi, in Devanagari, never in
Roman letters.

Any line these instructions quote for you to say (a greeting, a goodbye) is an
example of what to say, not the exact words: say it in the language you are
speaking now, so a Hindi call never ends in an English sentence.

In Hindi, use the verb forms of the person you are playing: a woman says
"मैं कर सकती हूँ", never "सकता".

Write Hindi in Devanagari, not romanised, because the voice pronounces its own
script far better than a transliteration. English stays in the Latin alphabet.
Keep a reply in one language rather than mixing the two in a sentence, except
for words that have no natural translation.""",

    "english": """\
Speak only in English for this whole call, whatever language the caller uses.
If they speak Hindi, understand them and answer in English. Any line these
instructions quote for you to say is also said in English. Keep names and
numbers as they were said.""",

    "hindi": """\
Speak only in Hindi for this whole call, whatever language the caller uses, and
write it in Devanagari, never romanised, because the voice pronounces its own
script far better than a transliteration. If they speak English, understand
them and answer in Hindi. Words with no natural Hindi equivalent (EMI, OTP,
names) stay as they are. Any line these instructions quote for you to say (a
greeting, a goodbye) is an example: say it in the language you are speaking,
which is Hindi. Use the verb forms of the person you are playing.""",

    "mix": """\
Speak natural Hinglish, the way an educated Indian speaks on the phone: Hindi
grammar and everyday Hindi words in Devanagari, with common English words kept
in the Latin alphabet. Every reply has both, even if the caller speaks only
English, and even if the caller's Hindi was written in Roman letters by speech
recognition: always write the Hindi part in Devanagari, never in Roman letters,
because the voice reads Roman letters as English. Examples of the style:
- "जी, मैं आपकी tasks और reminders में help कर सकती हूँ।"
- "आपका EMI payment कब तक हो जाएगा?"
- "ठीक है, thank you, आपका दिन अच्छा रहे।"
Match how much English the caller uses: more if they use more, less if they use
less. Any line these instructions quote for you to say (a greeting, a goodbye)
is an example: say it in this mixed style, in the language you are speaking.
Use the verb forms of the person you are playing: a woman says "सकती", never
"सकता".""",
}


def language_rules(mode: str) -> str:
    return _RULES[clean_mode(mode)]


# The voice. `None` means follow the caller (FollowCallerLanguage retunes it each turn).
# A mix is pinned to Hindi: its Devanagari has to be pronounced as Hindi, and the English
# words in it come out of the same multilingual voice.
_VOICE = {"auto": None, "english": "en", "hindi": "hi", "mix": "hi"}


def tts_language(mode: str) -> str | None:
    return _VOICE[clean_mode(mode)]


def follows_caller(mode: str) -> bool:
    return clean_mode(mode) == "auto"


def greeting_hint(mode: str) -> str:
    """A few words added to the instruction to open the call, so the first line is in the
    language the call is meant to be in. Empty for auto: it opens in English as before."""
    return {"auto": "", "english": " Greet in English.", "hindi": " Greet in Hindi.",
            "mix": " Greet in natural Hinglish."}[clean_mode(mode)]
