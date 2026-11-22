"""What is sent to Deepgram when a call's speech recognition connects.

Keyterms (words this agent should listen for), language hints (a nudge towards the languages
callers speak) and two usage labels (tag, extra). Everything here is a pure function so it can
be tested without a network.

One rule runs through all of it: a value Deepgram rejects ends the whole connection, and a call
with no speech recognition is a dead call. So a bad value is dropped, never sent. The limits come
from Deepgram's own pages (read 2026-11-22): keyterms are limited to 500 tokens per request,
commas, semicolons and line breaks are not separators and a weight such as "term:0.15" is not
read, an unknown language_hint is an HTTP 400, tags are 128 characters at most.
"""

import math
import re

MAX_KEYTERMS = 50           # Deepgram's own advice is "the most important 20-50 terms"
MAX_KEYTERM_CHARS = 40
# Deepgram refuses a connection over 500 tokens and does not say how it counts them, so the
# budget is well under the limit and the estimate below leans high.
KEYTERM_TOKEN_BUDGET = 300

# Characters that make a keyterm useless or ambiguous: control characters, and the two
# separators Deepgram does not treat as separators.
_BAD_CHARS = re.compile(r"[\x00-\x1f\x7f,;]")
_WEIGHT = re.compile(r":\s*[\d.]+$")   # "term:0.15", a weight Deepgram does not read

# The codes Deepgram lists for Nova-3 multilingual (nova-3-language-prompting page,
# 2026-11-22). Only these may be sent as a hint: anything else is an HTTP 400.
_HINT_CODES = (
    "af ar be bn bs bg ca zh-HK zh zh-CN zh-Hans hr cs da nl en en-US en-GB en-AU en-NZ en-IN "
    "en-CA et fi nl-BE fr gl de el gu he hi hu id it ja kn ko lv lt mk ms mr no fa pl pt ro ru sr "
    "sk sl es sv tl ta te th tr uk vi xh zu"
).split()
_HINTS = {code.lower(): code for code in _HINT_CODES}
DEFAULT_HINTS = "hi,en"

# Ids that go into a label: letters, digits, underscore and hyphen only, so nothing a
# network caller sends can add a parameter to the connection.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def estimate_tokens(term: str) -> int:
    """A deliberately high guess at what Deepgram counts for one keyterm. English runs about
    three characters a token; Indian scripts about one, so they are counted that way."""
    ascii_chars = sum(1 for c in term if ord(c) < 128)
    other_chars = len(term) - ascii_chars
    return math.ceil(ascii_chars / 3) + other_chars + 1


def clean_keyterms(raw) -> list[str]:
    """The usable words from a list: trimmed, no repeats (case ignored), nothing Deepgram
    would read wrongly, at most MAX_KEYTERMS. Anything that is not a list gives nothing."""
    if not isinstance(raw, list | tuple):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        term = item.strip()
        too_long = len(term) > MAX_KEYTERM_CHARS
        if not term or too_long or _BAD_CHARS.search(term) or _WEIGHT.search(term):
            continue
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(term)
        if len(out) == MAX_KEYTERMS:
            break
    return out


def keyterms_from_text(text) -> list[str]:
    """DEEPGRAM_KEYTERMS: one comma-separated line."""
    if not isinstance(text, str):
        return []
    return clean_keyterms([part for part in text.split(",")])


def merge_keyterms(agent_terms, global_terms, budget: int = KEYTERM_TOKEN_BUDGET) -> list[str]:
    """This agent's words first, then the deployment's, without repeats, cut off before the
    token budget so Deepgram never refuses the connection for length."""
    merged = clean_keyterms([*clean_keyterms(agent_terms), *clean_keyterms(global_terms)])
    out: list[str] = []
    used = 0
    for term in merged:
        cost = estimate_tokens(term)
        if used + cost > budget:
            break
        used += cost
        out.append(term)
    return out


def language_hints(raw) -> list[str]:
    """DEEPGRAM_LANGUAGE_HINTS: codes separated by commas; unset means Hindi and English, "off"
    means none. A code Deepgram does not list is dropped, because it would end the call."""
    text = raw.strip() if isinstance(raw, str) else ""
    if not text:
        text = DEFAULT_HINTS
    if text.lower() == "off":
        return []
    out: list[str] = []
    for part in text.split(","):
        code = _HINTS.get(part.strip().lower())
        if code and code not in out:
            out.append(code)
    return out


def usage_tag(org_id) -> str | None:
    """The tag Deepgram files this call's usage under: the organization's own id (opaque,
    "org_" and twelve hex characters), so a usage report splits by customer without a name
    ever leaving. None when there is nothing safe to send."""
    return org_id if isinstance(org_id, str) and _SAFE_ID.match(org_id) else None


def usage_extra(call_id, agent_id) -> list[str]:
    """Key:value labels Deepgram hands back with the call's metadata."""
    out = []
    for key, value in (("call_id", call_id), ("agent_id", agent_id)):
        if isinstance(value, str) and _SAFE_ID.match(value):
            out.append(f"{key}:{value}")
    return out
