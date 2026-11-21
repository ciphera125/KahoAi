"""What the agent does when the caller goes quiet (owner, 2026-11-22).

It used to wait in silence for as long as the caller did. Now, after the agent's own number of
seconds, it asks whether they are there, up to its number of times, then says goodbye and hangs up
(or keeps waiting, if the agent is set so). Anything the caller says starts the count again.
"""

from silence import SilenceFollowUp


def cfg(**kw):
    return SilenceFollowUp.from_config(
        {"enabled": True, "after_secs": 10, "times": 2, "message": "", "hang_up": True, **kw})


def test_off_or_unset_means_no_timer():
    assert SilenceFollowUp.from_config(None).timeout == 0
    assert SilenceFollowUp.from_config({"enabled": False, "after_secs": 10}).timeout == 0


def test_asks_then_says_goodbye_and_hangs_up():
    s = cfg()
    assert s.timeout == 10
    assert s.next_step("auto") == ("ask", "Are you still there?")
    assert s.next_step("auto") == ("ask", "Are you still there?")
    kind, text = s.next_step("auto")
    assert kind == "end" and "goodbye" in text.lower()
    assert s.next_step("auto") is None  # once it has ended, nothing more


def test_the_agents_own_words_and_the_callers_language():
    s = cfg(after_secs=8, times=1, message="Hello, can you hear me?")
    assert s.next_step("auto") == ("ask", "Hello, can you hear me?")
    h = cfg(after_secs=8, times=1)
    assert h.next_step("hindi") == ("ask", "क्या आप लाइन पर हैं?")


def test_without_hang_up_it_stops_asking_and_waits():
    s = cfg(times=1, hang_up=False)
    assert s.next_step("auto")[0] == "ask"
    assert s.next_step("auto") is None


def test_the_caller_speaking_starts_the_count_again():
    s = cfg(times=1)
    assert s.next_step("auto")[0] == "ask"
    s.caller_spoke()
    assert s.next_step("auto")[0] == "ask"


def test_bad_values_fall_back_to_safe_ones():
    s = cfg(after_secs="x", times=99, message=None)
    assert s.timeout == 10 and s.times == 5
    assert SilenceFollowUp.from_config({"enabled": True, "after_secs": 1}).timeout == 5
