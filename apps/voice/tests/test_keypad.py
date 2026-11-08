"""Keypad (DTMF) input: pressed digits reach the agent as text, when it is switched on."""

import pytest
from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import InputDTMFFrame, TranscriptionFrame
from pipecat.tests.utils import SleepFrame, run_test

import main

pytestmark = pytest.mark.asyncio


def test_it_is_off_unless_switched_on(monkeypatch):
    monkeypatch.delenv("DTMF_INPUT", raising=False)
    assert main.keypad_enabled() is False
    assert main.keypad_processors() == []
    assert "DTMF" not in main.voice_rules("auto")


@pytest.mark.parametrize("value", ["true", "1", "yes", "ON"])
def test_it_switches_on(monkeypatch, value):
    monkeypatch.setenv("DTMF_INPUT", value)
    assert main.keypad_enabled() is True
    assert len(main.keypad_processors()) == 1


@pytest.mark.parametrize("value", ["false", "0", "", "maybe"])
def test_anything_else_is_off(monkeypatch, value):
    monkeypatch.setenv("DTMF_INPUT", value)
    assert main.keypad_enabled() is False


def test_the_agent_is_told_what_a_keypad_line_is(monkeypatch):
    monkeypatch.setenv("DTMF_INPUT", "true")
    rules = main.voice_rules("auto")
    assert "DTMF:" in rules
    assert "keypad" in rules.lower()


async def test_pressed_digits_become_one_line_of_caller_text(monkeypatch):
    monkeypatch.setenv("DTMF_INPUT", "true")
    (proc,) = main.keypad_processors()
    down, _ = await run_test(
        proc,
        frames_to_send=[InputDTMFFrame(KeypadEntry.ONE), InputDTMFFrame(KeypadEntry.TWO),
                        InputDTMFFrame(KeypadEntry.POUND), SleepFrame(0.1)],
    )
    said = [f.text for f in down if isinstance(f, TranscriptionFrame)]
    assert said == ["DTMF: 12#"]
