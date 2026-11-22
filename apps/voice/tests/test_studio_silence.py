"""The silence follow-up set in the Studio reaches the call (2026-11-22).

studio_link._clean_config builds a fixed shape, so a field the Studio sent was dropped unless
it was named there, and `silence` was not: every call from the Studio ran with the follow-up
off, whatever the agent's Settings said. The Studio's answer is cleaned again here because it
decides what a live call does.
"""

import studio_link
from silence import SilenceFollowUp

BASE = {"agent_id": "ag_6d26dca7bd61", "org_id": "org_8f2a91c4d0e7", "name": "Ria", "prompt": "hi",
        "tools": [], "opening_line": None, "max_secs": 600.0, "ring_secs": 40, "version": 3}
ON = {"enabled": True, "after_secs": 15, "times": 3, "message": "Hello, are you there?",
      "hang_up": False}


def clean(silence):
    return studio_link._clean_config({**BASE, "silence": silence})["silence"]


def test_the_agents_silence_settings_reach_the_call():
    assert clean(ON) == ON


def test_they_make_a_working_follow_up():
    follow = SilenceFollowUp.from_config(clean(ON))
    assert (follow.timeout, follow.times, follow.hang_up) == (15, 3, False)
    assert follow.message == "Hello, are you there?"


def test_a_switched_off_follow_up_stays_off():
    assert SilenceFollowUp.from_config(clean({**ON, "enabled": False})).timeout == 0


def test_a_studio_that_sends_nothing_gives_no_follow_up():
    assert studio_link._clean_config(BASE)["silence"] is None


def test_junk_is_never_obeyed():
    for junk in ("on", 5, [1], {"enabled": "yes"}, {"enabled": 1}):
        out = clean(junk)
        assert out is None or isinstance(out["enabled"], bool)
        assert SilenceFollowUp.from_config(out).timeout == 0, junk


def test_numbers_are_held_to_the_limits_the_studio_allows():
    out = clean({**ON, "after_secs": 9999, "times": -4})
    assert out["after_secs"] == 60 and out["times"] == 1
    out = clean({**ON, "after_secs": "soon", "times": None})
    assert out["after_secs"] == 10 and out["times"] == 2


def test_the_words_are_one_short_line_of_text():
    long_text = "x " * 400
    out = clean({**ON, "message": long_text})
    assert len(out["message"]) <= 200 and "\n" not in out["message"]
    assert clean({**ON, "message": 12345})["message"] == ""
