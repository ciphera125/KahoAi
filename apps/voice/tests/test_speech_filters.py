import main
import pytest


async def test_dashes_become_commas():
    """An em-dash is a pause when spoken, and some voices read it aloud."""
    out = await main.SpokenPunctuationFilter().filter(
        "I'm not sure what you need—could you tell me more?"
    )
    assert "—" not in out
    assert out == "I'm not sure what you need, could you tell me more?"


async def test_smart_quotes_flattened():
    out = await main.SpokenPunctuationFilter().filter("“Kaho’s here,” she said")
    assert out == '"Kaho\'s here," she said'


async def test_plain_text_untouched():
    plain = "The clinic is open until seven in the evening."
    assert await main.SpokenPunctuationFilter().filter(plain) == plain


def test_markdown_filter_runs_first():
    """Markdown is stripped before punctuation is normalised."""
    names = [type(f).__name__ for f in main.speech_text_filters()]
    assert names[:2] == ["MarkdownTextFilter", "SpokenPunctuationFilter"]


async def test_spaced_dash_does_not_double_space():
    out = await main.SpokenPunctuationFilter().filter("nine to five — closed Sunday")
    assert out == "nine to five, closed Sunday"


# --- the same sentence twice in a row is said once ----------------------------------


async def test_a_sentence_repeated_back_to_back_is_dropped():
    # Seen live: "मेरा नाम आयुशी है…" said twice in one reply.
    f = main.RepeatedSentenceFilter()
    assert await f.filter("मेरा नाम आयुशी है।") == "मेरा नाम आयुशी है।"
    assert await f.filter(" मेरा नाम आयुशी है। ") == ""
    assert await f.filter("Your EMI is due tomorrow.") == "Your EMI is due tomorrow."
    assert await f.filter("your emi is due tomorrow") == ""  # case and punctuation aside


async def test_a_sentence_may_come_back_after_something_else():
    f = main.RepeatedSentenceFilter()
    for text in ["Hello.", "How can I help?", "Hello."]:
        assert await f.filter(text) == text


async def test_an_interruption_forgets_the_last_sentence():
    f = main.RepeatedSentenceFilter()
    await f.filter("Could you repeat that?")
    await f.handle_interruption()
    assert await f.filter("Could you repeat that?") == "Could you repeat that?"


def test_the_repeat_filter_is_on_only_when_text_goes_by_sentence(monkeypatch):
    monkeypatch.setenv("TTS_TEXT_AGGREGATION", "sentence")
    assert any(isinstance(f, main.RepeatedSentenceFilter) for f in main.speech_text_filters())
    monkeypatch.setenv("TTS_TEXT_AGGREGATION", "token")
    assert not any(isinstance(f, main.RepeatedSentenceFilter)
                   for f in main.speech_text_filters())


# --- the brand is spoken from the spelling the owner chose by ear ---------------------


@pytest.mark.parametrize("written", ["Kaho AI", "kaho ai", "Kaho-AI", "Kaho A.I.", "KAHO AI",
                                     "KahoAI", "कहो AI", "काहो एआई", "कहो ए आई"])
async def test_every_way_of_writing_the_brand_is_spoken_as_kahoai(written):
    # Owner, 2026-10-24: "KahoAI" in a Hindi sentence sounded right (brand/b_KahoAI_hi_sentence).
    out = await main.BrandNameFilter().filter(f"मैं {written} से बोल रही हूँ।")
    assert out == "मैं KahoAI से बोल रही हूँ।"


@pytest.mark.parametrize("text", ["Say AI clearly.", "कहो, आप कैसे हैं?", "Kahoot is a game."])
async def test_other_words_are_left_alone(text):
    assert await main.BrandNameFilter().filter(text) == text


def test_the_brand_filter_is_always_on():
    assert any(isinstance(f, main.BrandNameFilter) for f in main.speech_text_filters())
