import main


def test_indian_english_into_means_multiply():
    # Callers say "100 into 4,000" for multiplication; without this line both
    # gpt-oss models read it as division most of the time (2/12 and 4/12 right,
    # 10/12 and 9/12 with it), and a caller heard "forty" on a real call.
    rules = main.VOICE_RULES.lower()
    assert "into" in rules and "multipl" in rules
