import main


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
    assert names == ["MarkdownTextFilter", "SpokenPunctuationFilter"]


async def test_spaced_dash_does_not_double_space():
    out = await main.SpokenPunctuationFilter().filter("nine to five — closed Sunday")
    assert out == "nine to five, closed Sunday"
