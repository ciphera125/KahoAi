"""What the caller said, cleaned up before the model reads it.

Seen live: nova-3 heard "Kaho AI" as "Cairo AI" in a Hindi sentence, and the
agent said it knew nothing about it; and it wrote "अच्छा" partly in Bengali
script ("Aচ্ছা"), which nova-3's multilingual mode does not even support.
"""

import pytest
from main import NormalizeTranscripts, normalize_transcript
from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection


@pytest.mark.parametrize("heard", ["Cairo AI", "cairo a.i.", "Kairo AI", "Caho AI",
                                   "Kahoo AI", "Cahu AI", "कैरो AI", "काहो एआई", "कहो ए आई"])
def test_the_brand_name_is_put_back(heard):
    assert normalize_transcript(f"मुझे {heard} के बारे में बताओ") == "मुझे Kaho AI के बारे में बताओ"


@pytest.mark.parametrize("text", ["Cairo is a city", "कहो क्या हाल है", "I said AI is fine",
                                  "Tell me about Kaho AI"])
def test_ordinary_words_are_left_alone(text):
    assert normalize_transcript(text) == text


def test_bengali_letters_become_the_devanagari_ones():
    assert normalize_transcript("Aচ্ছা") == "Aच्छा"
    assert normalize_transcript("আমি") == "आमि"


async def test_the_processor_fixes_final_and_interim_transcripts():
    fixed = []
    proc = NormalizeTranscripts()

    async def capture(frame, direction=None):
        fixed.append(frame)

    proc.push_frame = capture
    for cls in (TranscriptionFrame, InterimTranscriptionFrame):
        await proc.process_frame(cls("Cairo AI से बात करनी है", "u1", "t"),
                                 FrameDirection.DOWNSTREAM)
    assert [f.text for f in fixed] == ["Kaho AI से बात करनी है"] * 2
