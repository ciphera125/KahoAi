"""Stand-ins for the providers at the edges of the pipeline that build_worker wires up.

The LLM, aggregators, CallHealth and every frame between them are real; only what
would reach the network is replaced.
"""

import asyncio

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    LLMAssistantPushAggregationFrame,
    LLMContextFrame,
    TTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.utils.text.base_text_aggregator import AggregationType


class PassThrough(FrameProcessor):
    """Stands in for the transport ends and for Deepgram STT."""

    class Settings:
        def __init__(self, **kwargs):
            pass

    def __init__(self, **kwargs):
        super().__init__()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class SpeakingTTS(FrameProcessor):
    """Says each TTSSpeakFrame: bot speech starts, lasts a moment, stops.

    Like the real output transport, each start and stop goes both ways: the
    downstream copy is what CallHealth counts, the upstream one is what the
    caller-mute strategy in the user aggregator watches. Like a real TTS service,
    the spoken text goes on as TTSTextFrames carrying the frame's append_to_context,
    and is committed to the LLM's context only when that is set.
    """

    def __init__(self):
        super().__init__()
        self.said = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSSpeakFrame):
            self.said.append(frame.text)
            keep = frame.append_to_context
            await self.push_frame(TTSStartedFrame(append_to_context=keep))
            await self.push_frame(BotStartedSpeakingFrame())
            await self.push_frame(BotStartedSpeakingFrame(), FrameDirection.UPSTREAM)
            text = TTSTextFrame(frame.text, aggregated_by=AggregationType.SENTENCE)
            text.append_to_context = keep
            await self.push_frame(text)
            if keep:
                await self.push_frame(LLMAssistantPushAggregationFrame())
            await self.push_frame(TTSStoppedFrame())
            await asyncio.sleep(0.05)
            await self.push_frame(BotStoppedSpeakingFrame())
            await self.push_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
            return
        await self.push_frame(frame, direction)


class GreetingLLM(FrameProcessor):
    """Answers every request with GREETING and keeps the messages each one carried."""

    GREETING = "Hi, I'm Kaho. How can I help?"

    def __init__(self):
        super().__init__()
        self.requests = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            self.requests.append([dict(m) for m in frame.context.get_messages()])
            await self.push_frame(TTSSpeakFrame(self.GREETING))
            return
        await self.push_frame(frame, direction)


class Transport:
    def __init__(self):
        self._in, self._out = PassThrough(), PassThrough()

    def input(self):
        return self._in

    def output(self):
        return self._out
