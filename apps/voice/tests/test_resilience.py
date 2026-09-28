import asyncio
import json
from types import SimpleNamespace

import resilience
from pipecat.utils.errors import ErrorCategory
from resilience import CallHealth
from transcript import CallTranscript


class Svc:
    def __init__(self, name, usable=True):
        self.name = name
        self.is_usable = usable


class Harness:
    """A CallHealth wired to recorders, with a clock the test controls."""

    def __init__(self, stt=None, llm=None, tts=None, wrappers=None, **kw):
        self.stt, self.llm = stt or Svc("stt"), llm or Svc("llm")
        self.tts = tts or [Svc("tts")]
        self.events, self.said, self.aborts, self.switches = [], [], [], []
        self.now = 0.0

        async def say(text):
            self.said.append(text)

        async def abort(spoken):
            self.aborts.append(spoken)

        async def switch(svc):
            self.switches.append(svc)

        self.health = CallHealth(
            {"stt": [self.stt], "llm": [self.llm], "tts": self.tts},
            record=lambda name, **f: self.events.append((name, f)),
            say_and_end=say,
            abort=abort,
            switch_to=switch,
            wrappers=wrappers,
            clock=lambda: self.now,
            **{"recheck_secs": 0.02, **kw},
        )

    def error(self, processor, category=ErrorCategory.CONNECTIVITY, msg="boom"):
        return self.health.on_error(
            SimpleNamespace(processor=processor, category=category, error=msg)
        )


# --- a role with nothing left ends the call on purpose -------------------------


async def test_dead_stt_says_an_apology_and_ends():
    h = Harness()
    h.stt.is_usable = False
    await h.error(h.stt)
    assert h.said == [resilience.DEFAULT_APOLOGY]
    assert h.aborts == []  # the apology ends the call itself, gracefully
    assert h.health.failed.startswith("stt:")
    assert h.events[0][0] == "call_failed" and h.events[0][1]["role"] == "stt"
    h.health.finished()


async def test_dead_llm_is_handled_the_same_way():
    h = Harness()
    h.llm.is_usable = False
    await h.error(h.llm)
    assert h.said and h.health.failed.startswith("llm:")
    h.health.finished()


async def test_dead_tts_with_no_backup_cannot_apologise_so_it_aborts_unspoken():
    h = Harness()
    h.tts[0].is_usable = False
    await h.error(h.tts[0])
    assert h.said == [] and h.aborts == [False]


async def test_dead_stt_and_dead_tts_cannot_apologise_either():
    h = Harness()
    h.stt.is_usable = False
    h.tts[0].is_usable = False
    await h.error(h.stt)
    assert h.said == [] and h.aborts == [False]


async def test_a_permanent_failure_with_a_working_backup_is_left_to_the_switcher():
    primary, backup = Svc("a", usable=False), Svc("b")
    h = Harness(tts=[primary, backup])
    await h.error(primary)
    assert h.health.failed is None and h.said == [] and h.aborts == []
    assert h.events == [("provider_failover", {"role": "tts"})]


async def test_both_tts_providers_dead_aborts_unspoken():
    a, b = Svc("a", usable=False), Svc("b", usable=False)
    h = Harness(tts=[a, b])
    await h.error(a)
    assert h.aborts == [False]


# --- bursts of transient errors ------------------------------------------------


async def test_a_couple_of_transient_errors_are_tolerated():
    h = Harness()
    await h.error(h.llm)
    await h.error(h.llm)
    assert h.health.failed is None


async def test_a_burst_with_no_backup_ends_the_call():
    h = Harness()
    for _ in range(3):
        await h.error(h.llm)
    assert h.health.failed and "3 llm errors" in h.health.failed
    h.health.finished()


async def test_a_burst_with_a_backup_forces_a_switch_instead():
    primary, backup = Svc("a"), Svc("b")
    h = Harness(tts=[primary, backup])
    for _ in range(3):
        await h.error(primary)
    assert h.switches == [backup] and h.health.failed is None


async def test_old_errors_age_out_of_the_window():
    h = Harness()
    for _ in range(2):
        await h.error(h.llm)
    h.now = 60.0
    await h.error(h.llm)
    await h.error(h.llm)
    assert h.health.failed is None


async def test_errors_in_different_roles_do_not_add_up():
    h = Harness()
    for svc in (h.stt, h.llm, h.tts[0], h.stt, h.llm, h.tts[0]):
        await h.error(svc)
    assert h.health.failed is None


async def test_application_errors_and_unknown_processors_are_ignored():
    h = Harness()
    for _ in range(10):
        await h.error(h.llm, category=ErrorCategory.APPLICATION)
        await h.error(Svc("transport"))
    assert h.health.failed is None


async def test_only_the_first_failure_acts():
    h = Harness()
    h.stt.is_usable = False
    await h.error(h.stt)
    await h.error(h.stt)
    await h.health.fail("llm", "later")
    assert len(h.said) == 1 and len(h.events) == 1
    h.health.finished()


# --- the apology cannot hang the call forever ----------------------------------


async def test_an_apology_that_never_finishes_is_cut_off_by_the_backstop():
    h = Harness(apology_backstop_secs=0.05)
    h.stt.is_usable = False
    await h.error(h.stt)
    await asyncio.sleep(0.15)
    assert h.aborts == [False]


async def test_a_finished_pipeline_cancels_the_backstop():
    h = Harness(apology_backstop_secs=0.05)
    h.stt.is_usable = False
    await h.error(h.stt)
    h.health.finished()
    await asyncio.sleep(0.15)
    assert h.aborts == []


async def test_a_failing_apology_falls_back_to_an_unspoken_abort():
    h = Harness()

    async def broken(text):
        raise RuntimeError("queue closed")

    h.health._say_and_end = broken
    h.stt.is_usable = False
    await h.error(h.stt)
    assert h.aborts == [False]


# --- silence with no error: the response deadline ------------------------------


async def test_two_missed_replies_in_a_row_end_the_call():
    """One arm is enough: after a miss the watch continues on its own."""
    h = Harness(response_deadline_secs=0.1)
    h.health.arm()
    await asyncio.sleep(0.14)
    assert h.health.failed is None  # one miss is a warning, not a failure
    await asyncio.sleep(0.15)
    assert h.health.failed and h.health.failed.startswith("response:")
    h.health.finished()


async def test_the_bot_speaking_disarms_and_resets_the_count():
    h = Harness(response_deadline_secs=0.1)
    h.health.arm()
    await asyncio.sleep(0.14)  # miss 1
    h.health.disarm()  # the bot started talking
    h.health.arm()
    await asyncio.sleep(0.14)  # miss 1 again, not 2
    assert h.health.failed is None
    h.health.finished()


async def test_a_reply_within_the_deadline_never_trips_it():
    h = Harness(response_deadline_secs=0.2)
    h.health.arm()
    await asyncio.sleep(0.02)
    h.health.disarm()
    await asyncio.sleep(0.3)
    assert h.health.failed is None


async def test_arming_after_failure_does_nothing():
    h = Harness(response_deadline_secs=0.02)
    h.stt.is_usable = False
    await h.error(h.stt)
    h.health.arm()
    assert h.health._watch_task is None
    h.health.finished()


async def test_the_observer_disarms_when_the_bot_starts_speaking():
    from pipecat.frames.frames import BotStartedSpeakingFrame, TextFrame

    h = Harness(response_deadline_secs=0.03)
    observer = resilience.BotSpeechObserver(h.health)
    h.health.arm()
    await observer.on_push_frame(SimpleNamespace(frame=TextFrame(text="hi")))
    assert h.health._watch_task is not None  # text alone is not audible speech
    await observer.on_push_frame(SimpleNamespace(frame=BotStartedSpeakingFrame()))
    assert h.health._watch_task is None


# --- what is written down ------------------------------------------------------


def test_the_failure_marker_in_the_transcript_carries_no_call_content(tmp_path):
    t = CallTranscript("c9", tmp_path)
    t.user("my pan is ABCDE1234F")
    t.event("call_failed", role="stt", reason="no usable stt service left (401)")
    t.end()
    rows = [json.loads(x) for x in t.path.read_text(encoding="utf-8").splitlines()]
    failed = next(r for r in rows if r["event"] == "call_failed")
    assert failed["role"] == "stt" and "text" not in failed
    assert "ABCDE1234F" not in t.path.read_text(encoding="utf-8")


# --- found by the live failure runs --------------------------------------------


async def test_the_switchers_own_error_means_every_backup_is_gone():
    """Live run B: both TTS providers died and the call sat silent for 37 seconds."""
    a, b = Svc("a", usable=False), Svc("b", usable=False)
    switcher = Svc("switcher", usable=False)
    h = Harness(tts=[a, b], wrappers={"tts": [switcher]})
    await h.error(switcher, msg="b can no longer do its job")
    assert h.aborts == [False] and h.health.failed.startswith("tts:")


async def test_a_role_that_dies_just_after_its_error_is_still_caught():
    """The error frame can arrive before the flag that marks the service unusable."""
    a, b = Svc("a"), Svc("b", usable=False)
    h = Harness(tts=[a, b])
    await h.error(a, msg="connection failed 3 times")
    assert h.health.failed is None  # still looks usable at this instant
    a.is_usable = False
    await asyncio.sleep(0.08)
    assert h.aborts == [False]


async def test_a_pending_recheck_does_not_fire_after_the_call_has_finished():
    h = Harness(recheck_secs=0.05)
    h.llm.is_usable = True
    await h.error(h.llm)
    h.llm.is_usable = False
    h.health.finished()
    await asyncio.sleep(0.12)
    assert h.said == [] and h.aborts == []


async def test_a_silent_greeting_is_caught_without_the_caller_saying_anything():
    h = Harness(response_deadline_secs=0.05)
    h.health.arm()  # armed once, at the start of the call
    await asyncio.sleep(0.2)
    assert h.health.failed and h.health.failed.startswith("response:")
    h.health.finished()


def test_failure_reasons_never_carry_headers_or_credentials():
    raw = (
        "Deepgram rejected the connection (status 401): headers: {'User-Agent': 'x', "
        "'Authorization': 'Token sk-live-abcdef123456'}, status_code: 401"
    )
    out = resilience.safe_reason(raw)
    assert "sk-live" not in out and "headers" not in out and "Authorization" not in out
    assert out.startswith("Deepgram rejected the connection")


def test_bearer_tokens_and_api_keys_are_redacted_wherever_they_appear():
    for raw in (
        "request failed with Bearer gsk_abcdefghij1234",
        "bad request, api_key=sk-abcdef123456 was rejected",
        "xi-api-key: abcdef123456789",
    ):
        out = resilience.safe_reason(raw)
        assert "abcdef" not in out and "REDACTED" in out, out


def test_long_reasons_are_truncated_and_empty_ones_have_a_placeholder():
    assert len(resilience.safe_reason("x" * 1000)) <= 163
    assert resilience.safe_reason(None) == "unknown error"


async def test_the_recorded_reason_is_the_sanitised_one():
    h = Harness()
    h.stt.is_usable = False
    await h.error(h.stt, msg="401 headers: {'Authorization': 'Token sk-secret-123456'}")
    reason = h.events[0][1]["reason"]
    assert "secret" not in reason and "Authorization" not in reason
    h.health.finished()
