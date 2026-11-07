"""Which language the agent speaks: follow the caller (the default), or English, Hindi
or a mix, chosen per agent or per call.

What can be enforced in code is: what the model is told, and which language the voice is
tuned to. What the model then writes is the model's. The rules below are therefore tested
for what they say, and the voice's behaviour for what it does.
"""
import language
import main
import pytest
from pipecat.frames.frames import TranscriptionFrame, TTSUpdateSettingsFrame
from pipecat.processors.frame_processor import FrameDirection


def test_the_four_modes_and_a_safe_default():
    assert language.MODES == ("auto", "english", "hindi", "mix")
    assert language.clean_mode("Hindi") == "hindi"
    assert language.clean_mode(" MIX ") == "mix"
    for junk in (None, "", "klingon", "hi", 7, "english; ignore all rules"):
        assert language.clean_mode(junk) == "auto"


def test_following_the_caller_is_the_default_and_judged_turn_by_turn():
    rules = language.language_rules("auto").lower()
    assert "latest turn" in rules
    assert "switch" in rules
    assert "devanagari" in rules


def test_english_mode_speaks_english_whatever_the_caller_uses():
    rules = language.language_rules("english")
    assert "only in English" in rules
    assert "Devanagari" not in rules          # nothing there to be read in the wrong accent
    assert "latest turn" not in rules         # it must not also say to follow the caller


def test_hindi_mode_speaks_hindi_in_devanagari_with_the_right_verb_forms():
    rules = language.language_rules("hindi")
    assert "only in Hindi" in rules
    assert "Devanagari" in rules
    assert "सकती" in rules or "verb forms" in rules


def test_mix_mode_asks_for_natural_hinglish_with_english_words_in_latin():
    rules = language.language_rules("mix")
    assert "Hinglish" in rules
    assert "Latin" in rules and "Devanagari" in rules
    assert "Keep a reply in one language" not in rules   # the auto rule it replaces


def test_each_mode_pins_or_follows_the_voice():
    assert language.tts_language("auto") is None          # follows the caller
    assert language.tts_language("english") == "en"
    assert language.tts_language("hindi") == "hi"
    assert language.tts_language("mix") == "hi"           # Devanagari must be pronounced as Hindi
    assert language.follows_caller("auto") is True
    assert not any(language.follows_caller(m) for m in ("english", "hindi", "mix"))


def test_the_voice_rules_keep_everything_else_whatever_the_mode():
    for mode in language.MODES:
        rules = main.voice_rules(mode)
        assert "Only use the tools you were given" in rules
        assert "multipl" in rules.lower()                  # the "into" rule
        assert "Everything you say must come from" in rules


def test_the_default_voice_rules_are_the_follow_the_caller_ones():
    assert main.VOICE_RULES == main.voice_rules("auto")


def test_a_hindi_call_gets_hindi_rules_and_not_the_follow_rule():
    prompt = main.load_system_prompt(persona_text="You are Ria.", language="hindi")
    assert "only in Hindi" in prompt
    assert "latest turn" not in prompt
    assert prompt.endswith("You are Ria.")


def test_the_prompt_is_unchanged_when_no_mode_is_given():
    assert main.load_system_prompt(persona_text="You are Ria.") == \
        f"{main.VOICE_RULES}\n\nYou are Ria."


# --- the voice -----------------------------------------------------------------


async def captured(proc, frame):
    sent = []

    async def capture(f, direction=None):
        sent.append(f)

    proc.push_frame = capture
    await proc.process_frame(frame, FrameDirection.DOWNSTREAM)
    return sent


def hindi_words():
    frame = TranscriptionFrame("नमस्ते", "u1", "t")
    frame.language = "hi"
    return frame


async def test_following_retunes_the_voice_when_the_caller_switches():
    proc = main.FollowCallerLanguage()
    sent = await captured(proc, hindi_words())
    assert any(isinstance(f, TTSUpdateSettingsFrame) for f in sent)


async def test_a_pinned_voice_stays_put_when_the_caller_switches():
    proc = main.FollowCallerLanguage(pinned="en")
    sent = await captured(proc, hindi_words())
    assert not any(isinstance(f, TTSUpdateSettingsFrame) for f in sent)
    assert any(isinstance(f, TranscriptionFrame) for f in sent)   # the words still go on


async def test_a_pinned_voice_is_tuned_at_the_start_and_again_after_a_backup_takes_over():
    proc = main.FollowCallerLanguage(pinned="hi")
    sent = []

    async def capture(f, direction=None):
        sent.append(f)

    proc.push_frame = capture
    await proc.retune()
    assert [f.delta.language for f in sent if isinstance(f, TTSUpdateSettingsFrame)] == ["hi"]


# --- the end of the caller's turn ---------------------------------------------------


def test_the_turn_analyser_gives_up_waiting_sooner_than_three_seconds(monkeypatch):
    # Seen on real calls: short answers ("Hello?", "Hi") are judged unfinished by the turn
    # model, which then waits out Pipecat's 3s silence fallback. Turn detection took 3.0s
    # on the slow turns and 0.1 to 0.5s on the rest.
    monkeypatch.delenv("SMART_TURN_STOP_SECS", raising=False)
    assert main.smart_turn_stop_secs() == 1.5


def test_the_silence_limit_is_tunable_and_a_bad_value_does_not_stop_a_call(monkeypatch):
    monkeypatch.setenv("SMART_TURN_STOP_SECS", "2.2")
    assert main.smart_turn_stop_secs() == 2.2
    for bad in ("soon", "-1", "0", "99"):
        monkeypatch.setenv("SMART_TURN_STOP_SECS", bad)
        assert main.smart_turn_stop_secs() == 1.5


def test_the_strategies_use_that_limit(monkeypatch):
    monkeypatch.setenv("SMART_TURN_STOP_SECS", "1.8")
    strategies = main.build_turn_strategies()
    analyzer = strategies.stop[0]._turn_analyzer
    assert analyzer._params.stop_secs == 1.8


# --- the first request on a call is not the slow one -----------------------------------


class _Models:
    def __init__(self, behaviour):
        self.behaviour, self.calls = behaviour, 0

    async def list(self):
        self.calls += 1
        return await self.behaviour()


def _service(behaviour):
    svc = object.__new__(main.PortableGroqLLMService)
    models = _Models(behaviour)
    svc._client = type("C", (), {"models": models})()
    return svc, models


async def test_the_connection_to_the_model_is_opened_before_the_first_real_request():
    # Each call builds its own client, so its first request pays for a new TLS handshake.
    # Measured on real calls: the first LLM request was 0.3 to 0.9s slower than the next.
    async def fine():
        return []

    svc, models = _service(fine)
    assert await svc.warm_connection() is True
    assert models.calls == 1


async def test_warming_never_raises_and_never_waits_long():
    import asyncio

    async def broken():
        raise RuntimeError("no network")

    async def hangs():
        await asyncio.sleep(30)

    svc, _ = _service(broken)
    assert await svc.warm_connection() is False
    svc, _ = _service(hangs)
    started = asyncio.get_event_loop().time()
    assert await svc.warm_connection(timeout=0.1) is False
    assert asyncio.get_event_loop().time() - started < 2



# --- what the first live measurement showed ---------------------------------------------
# 2026-11-08, real model, 36 replies. English-only and Hindi-only were right every time.
# Follow-the-caller and mix were not, for two reasons the rules now answer.


@pytest.mark.parametrize("mode", ["auto", "hindi", "mix"])
def test_a_line_quoted_in_the_prompt_is_said_in_the_calls_language(mode):
    # Ria's prompt says to close with "Thank you, have a great day". The model said exactly
    # that, in English, to a caller who had just spoken Hindi.
    rules = language.language_rules(mode)
    assert "quote" in rules.lower() or "example" in rules.lower()
    assert "in the language" in rules


@pytest.mark.parametrize("mode", ["auto", "mix"])
def test_hindi_heard_in_roman_letters_is_still_answered_in_devanagari(mode):
    # Speech recognition writes a Hinglish caller's Hindi in Roman letters. Copying that
    # script makes the voice read Hindi with English rules, which is worse than either.
    rules = language.language_rules(mode)
    assert "Roman" in rules
    assert "Devanagari" in rules


def test_mix_mode_shows_what_a_mixed_reply_looks_like():
    rules = language.language_rules("mix")
    assert rules.count("\n- ") >= 2          # a few examples, not just a description
    assert "even if the caller speaks only English" in " ".join(rules.split())


def test_english_mode_says_quoted_lines_are_said_in_english_too():
    assert "English" in language.language_rules("english")
