import main


def test_indian_english_into_means_multiply():
    # Callers say "100 into 4,000" for multiplication; without this line both
    # gpt-oss models read it as division most of the time (2/12 and 4/12 right,
    # 10/12 and 9/12 with it), and a caller heard "forty" on a real call.
    rules = main.VOICE_RULES.lower()
    assert "into" in rules and "multipl" in rules


def test_the_filler_is_hindi_after_a_hindi_turn_and_english_otherwise(monkeypatch):
    monkeypatch.delenv("FILLER_MESSAGE", raising=False)
    monkeypatch.delenv("FILLER_MESSAGE_HI", raising=False)
    assert main.filler_line(["मेरा EMI कब है?"]) == main.DEFAULT_FILLER_HI
    assert main.filler_line(["When is my EMI due?"]) == "One moment."
    assert main.filler_line([]) == "One moment."
    monkeypatch.setenv("FILLER_MESSAGE_HI", "बस एक पल।")
    assert main.filler_line(["हाँ"]) == "बस एक पल।"


def test_the_model_is_told_to_use_only_the_tools_it_was_given():
    # 2026-11-07, call db32d982: the persona named four tools the agent did not have
    # and the model called one, so Groq refused the turn. A persona is data and can say
    # anything; this rule is always in front of it.
    assert "Only use the tools you were given" in main.VOICE_RULES
    assert "answer in words" in main.VOICE_RULES.lower()


def test_the_caller_is_never_told_about_tools_or_internals():
    assert "Never mention" in main.VOICE_RULES


def test_the_no_tools_retry_line_is_not_part_of_every_turn():
    # It belongs to the one retry after a refusal, not to every turn of every call.
    assert main.NO_TOOLS_LINE not in main.VOICE_RULES
