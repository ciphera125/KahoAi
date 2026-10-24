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
