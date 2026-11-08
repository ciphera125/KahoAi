"""The call is no longer announced as recorded at the start. If the caller asks, the agent
says so, plainly and truthfully: it is told whether this call really is recorded."""
import main


def test_no_notice_is_played_at_the_start_by_default(monkeypatch):
    monkeypatch.delenv("RECORDING_NOTICE_ENABLED", raising=False)
    monkeypatch.delenv("RECORDING_ENABLED", raising=False)
    assert main.recording_notice_text() is None


def test_the_notice_can_still_be_switched_on(monkeypatch):
    monkeypatch.setenv("RECORDING_NOTICE_ENABLED", "true")
    monkeypatch.delenv("RECORDING_ENABLED", raising=False)
    assert main.recording_notice_text() == main.DEFAULT_NOTICE


def test_an_unrecorded_call_never_has_a_notice_even_when_it_is_on(monkeypatch):
    monkeypatch.setenv("RECORDING_NOTICE_ENABLED", "true")
    monkeypatch.setenv("RECORDING_ENABLED", "false")
    assert main.recording_notice_text() is None


def test_a_recorded_call_tells_the_agent_to_say_so_when_asked_and_not_before():
    rules = " ".join(main.voice_rules("auto", recorded=True).split())
    assert "This call is being recorded" in rules
    assert "unless the caller asks" in rules
    assert "say yes" in rules


def test_an_unrecorded_call_does_not_claim_to_be_recorded():
    rules = " ".join(main.voice_rules("auto", recorded=False).split())
    assert "being recorded" not in rules
    assert "not recorded" in rules


def test_every_language_mode_carries_it():
    for mode in ("auto", "english", "hindi", "mix"):
        assert "being recorded" in main.voice_rules(mode, recorded=True)


def test_the_prompt_a_call_is_given_carries_it(monkeypatch):
    prompt = main.load_system_prompt(persona_text="You are Ria.", recorded=True)
    assert "This call is being recorded" in prompt
    assert prompt.endswith("You are Ria.")


def test_the_default_rules_are_unchanged_for_anything_that_does_not_say(monkeypatch):
    assert main.voice_rules("auto") == main.voice_rules("auto", recorded=None)
    assert "recorded" not in main.voice_rules("auto")


async def test_the_server_does_not_play_a_cached_notice_unless_the_notice_is_on(monkeypatch):
    import notice_audio
    import server

    pcm = b"\x00\x01" * 4000
    notice = await notice_audio.PrespokenNotice.from_pcm(main.DEFAULT_NOTICE, pcm, 8000)
    monkeypatch.setattr(server, "_prespoken_notice", notice)
    monkeypatch.delenv("RECORDING_NOTICE_ENABLED", raising=False)
    assert server.prespoken_for_call() is None
    monkeypatch.setenv("RECORDING_NOTICE_ENABLED", "true")
    assert server.prespoken_for_call() is notice
