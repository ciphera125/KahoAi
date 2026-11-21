"""One question at a time (2026-11-22).

On call c8f8d8ab two tool results each led to a reply, and the caller heard "Could you
tell me your name?" and then "May I have your name?" with no chance to answer. Until the
caller speaks again, a second question is not said; the silence follow-up still is."""

import main


async def test_a_second_question_before_the_caller_answers_is_not_said():
    turns = {"n": 3}
    f = main.OneQuestionAtATime(lambda: turns["n"])
    first = "Great, could you tell me your name?"
    assert await f.filter(first) == first
    assert await f.filter("Sure, may I have your name?") == ""
    assert await f.filter("I will set that up for you.") == "I will set that up for you."
    turns["n"] = 4  # the caller answered
    assert await f.filter("And what time suits you?") == "And what time suits you?"


async def test_the_silence_follow_up_is_still_said():
    f = main.OneQuestionAtATime(lambda: 1)
    await f.filter("What is your name?")
    f.allow_next()
    assert await f.filter("Are you still there?") == "Are you still there?"


async def test_an_interruption_starts_again():
    f = main.OneQuestionAtATime(lambda: 1)
    await f.filter("What is your name?")
    await f.handle_interruption()
    assert await f.filter("What is your name?") == "What is your name?"


def test_every_voice_of_the_call_shares_one_filter_so_a_backup_voice_keeps_the_count():
    voices = [type("V", (), {"_text_filters": []})(), type("V", (), {"_text_filters": []})()]
    f = main.attach_one_question(voices, lambda: 0)
    assert all(v._text_filters == [f] for v in voices)
