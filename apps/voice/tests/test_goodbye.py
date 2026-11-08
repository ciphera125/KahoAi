"""The agent always says goodbye before the line is hung up, even when the model forgot to."""
from types import SimpleNamespace

import tools
from tools import CallContext, closing_line, said_goodbye


def context(turns, mode="auto", say=True, reply=""):
    spoken = []
    hung = []

    async def hang_up():
        hung.append(1)

    async def speak(text):
        spoken.append(text)

    call = CallContext(call_id="c1", transcript=SimpleNamespace(turns=turns), hang_up=hang_up)
    call.language_mode = mode
    # What the model has said so far in this very response: when it says goodbye and calls
    # end_call together, that goodbye is not in the transcript yet.
    call.reply_text = lambda: reply
    if say:
        call.say = speak
    return call, spoken, hung


async def hang_up(call):
    return await tools.REGISTRY["end_call"].handler({}, call)


def test_what_counts_as_already_having_said_goodbye():
    closings = ["Thank you, have a great day.", "Goodbye!", "Take care.", "धन्यवाद, नमस्ते।",
                "आपका दिन शुभ हो", "Thanks for your time"]
    for line in closings:
        assert said_goodbye(line), line
    for line in ["Sure, I can move it to Friday.", "What date works for you?", "", None]:
        assert not said_goodbye(line), line


def test_the_closing_line_follows_the_calls_language():
    assert closing_line("english", "anything") == "Thanks for talking. Goodbye!"
    assert "धन्यवाद" in closing_line("hindi", "anything")
    assert "धन्यवाद" in closing_line("mix", "anything")
    # The caller spoke Hindi, so the line is Hindi.
    assert closing_line("auto", "ठीक है, बस इतना ही") != "Thanks for talking. Goodbye!"
    assert closing_line("auto", "okay that is all") == "Thanks for talking. Goodbye!"
    assert closing_line("auto", None) == "Thanks for talking. Goodbye!"


async def test_a_goodbye_is_spoken_when_the_agent_did_not_say_one():
    turns = [("agent", "Your EMI is due on the fifteenth."), ("caller", "okay bye")]
    call, spoken, hung = context(turns)
    assert await hang_up(call) == {"status": "ending"}
    assert spoken == ["Thanks for talking. Goodbye!"]
    assert hung == [1]


async def test_it_is_not_said_twice_when_the_agent_already_said_it():
    turns = [("agent", "Anything else?"), ("caller", "bye")]
    call, spoken, hung = context(turns, reply="Thank you, have a great day.")
    await hang_up(call)
    assert spoken == [] and hung == [1]


async def test_a_hindi_call_is_closed_in_hindi():
    turns = [("agent", "आपकी किस्त पंद्रह तारीख को है।"), ("caller", "ठीक है, अलविदा")]
    call, spoken, _ = context(turns, mode="auto")
    await hang_up(call)
    assert "धन्यवाद" in spoken[0]


async def test_the_call_still_ends_when_there_is_no_way_to_speak():
    turns = [("agent", "Your EMI is due."), ("caller", "bye")]
    call, spoken, hung = context(turns, say=False)
    assert await hang_up(call) == {"status": "ending"}
    assert hung == [1]


async def test_it_does_not_hang_up_on_a_caller_who_has_not_said_goodbye():
    turns = [("agent", "Anything else?"), ("caller", "what is the date")]
    call, spoken, hung = context(turns)
    assert "error" in await hang_up(call)
    assert spoken == [] and hung == []


async def test_a_speaker_that_fails_never_stops_the_hang_up():
    call, _, hung = context([("agent", "Your EMI is due."), ("caller", "bye")])

    async def broken(text):
        raise RuntimeError("tts down")

    call.say = broken
    assert await hang_up(call) == {"status": "ending"}
    assert hung == [1]


# --- remembering what the model has said in this response ----------------------------


async def test_the_words_of_the_current_response_are_remembered_and_reset_for_the_next():
    from main import ReplyTextRecorder
    from pipecat.frames.frames import LLMFullResponseStartFrame, LLMTextFrame
    from pipecat.processors.frame_processor import FrameDirection

    recorder = ReplyTextRecorder()
    sent = []

    async def capture(frame, direction=None):
        sent.append(frame)

    recorder.push_frame = capture
    frames = (LLMFullResponseStartFrame(), LLMTextFrame("Thank you, "), LLMTextFrame("goodbye."))
    for frame in frames:
        await recorder.process_frame(frame, FrameDirection.DOWNSTREAM)
    assert recorder.text == "Thank you, goodbye."
    assert len(sent) == 3                       # everything still goes on to the voice
    await recorder.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    assert recorder.text == ""
