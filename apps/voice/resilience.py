"""Keep a live call from going silent when a provider fails.

Without this, a dead STT, LLM or TTS leaves the pipeline running and the caller
listening to nothing, with no idea whether to wait or hang up. The rules here
turn every way a call can go quiet into something defined:

1. A role (stt, llm, tts) with a backup provider fails over to it. That part is
   Pipecat's ServiceSwitcher; this module only watches the result.
2. A role with no usable service left ends the call deliberately: a spoken
   apology if TTS still works, otherwise the line is handed to Plivo's own
   text-to-speech (see server.py), so the caller hears something either way.
3. Errors that never mark a service unusable are caught by a rate check: too
   many in a short window counts as failure.
4. Failures that raise no error at all, such as a hung request, are caught by a
   response deadline: after the caller finishes speaking, the bot must start
   talking within RESPONSE_DEADLINE_SECS, and missing it twice in a row ends the
   call.

Everything is recorded in the call transcript as a `call_failed` event with the
role and reason, never with call content.
"""

import asyncio
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable

from loguru import logger
from pipecat.frames.frames import BotStartedSpeakingFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.utils.errors import ErrorCategory

DEFAULT_FILLER = "One moment."
# Speak the filler if the reply is this slow, well before the deadline gives up.
FILLER_AFTER_SECS = 3.0

DEFAULT_APOLOGY = "Sorry, we're having a technical problem. Please call back in a few minutes."

ERROR_THRESHOLD = 3
ERROR_WINDOW_SECS = 20.0
RESPONSE_DEADLINE_SECS = 10.0
MAX_MISSED_RESPONSES = 2
# How long to let a spoken apology play before cutting the call regardless.
APOLOGY_BACKSTOP_SECS = 10.0


# Provider errors can carry request headers, URLs and echoed credentials. What is
# logged and stored keeps only the first sentence-ish part, scrubbed of anything
# that looks like a secret; the full error stays in the (unstored) process log.
_SECRETS = re.compile(
    r"(?i)\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{6,}"
    r"|(?i:\b(api[_-]?key|authorization|xi-api-key|api-subscription-key)\b)['\"]?\s*[:=]\s*\S+"
)


def safe_reason(text: object, limit: int = 160) -> str:
    text = str(text or "unknown error")
    for marker in (" headers:", " Headers:", "{"):
        text = text.split(marker, 1)[0]
    text = _SECRETS.sub("[REDACTED]", text).strip(" ,:(")
    return (text[:limit] + "...") if len(text) > limit else text


class CallHealth:
    """Watches one call. Each callback is supplied by whoever built the pipeline.

    roles:        role name -> the services that can do it, primary first
    record:       write a marker to the transcript, record(event, **fields)
    say_and_end:  speak text, then end the call gracefully
    abort:        stop the call now; spoken says whether the caller heard an apology
    switch_to:    force a role over to another of its services
    say:          speak text without ending the call (the "one moment" filler); optional
    wrappers:     role -> processors that stand for the whole role (a ServiceSwitcher).
                  Its own error means every service behind it has been tried.
    """

    def __init__(
        self,
        roles: dict[str, list],
        *,
        record: Callable[..., None],
        say_and_end: Callable[[str], Awaitable[None]],
        abort: Callable[[bool], Awaitable[None]],
        switch_to: Callable[[object], Awaitable[None]] | None = None,
        say: Callable[[str], Awaitable[None]] | None = None,
        filler: str = DEFAULT_FILLER,
        filler_after_secs: float = FILLER_AFTER_SECS,
        wrappers: dict[str, list] | None = None,
        apology: str = DEFAULT_APOLOGY,
        error_threshold: int = ERROR_THRESHOLD,
        error_window_secs: float = ERROR_WINDOW_SECS,
        response_deadline_secs: float = RESPONSE_DEADLINE_SECS,
        max_missed_responses: int = MAX_MISSED_RESPONSES,
        apology_backstop_secs: float = APOLOGY_BACKSTOP_SECS,
        recheck_secs: float = 0.5,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._roles = roles
        self._wrappers = wrappers or {}
        self._record = record
        self._say_and_end = say_and_end
        self._abort = abort
        self._switch_to = switch_to
        self._say = say
        self._filler = filler
        self._filler_after = filler_after_secs
        # True from the moment the filler is queued until its own audio starts, so
        # that audio is not mistaken for the reply and does not disarm the deadline.
        self._filler_pending = False
        self._apology = apology
        self._threshold = error_threshold
        self._window = error_window_secs
        self._deadline = response_deadline_secs
        self._max_missed = max_missed_responses
        self._backstop = apology_backstop_secs
        self._recheck_secs = recheck_secs
        self._rechecks: set[asyncio.Task] = set()
        self._closed = False
        self._clock = clock
        self._errors: dict[str, deque] = {role: deque() for role in roles}
        self._missed = 0
        self._watch_task: asyncio.Task | None = None
        self._backstop_task: asyncio.Task | None = None
        self.failed: str | None = None

    # -- helpers ---------------------------------------------------------------

    def _role_of(self, processor) -> str | None:
        for role, services in self._roles.items():
            if any(processor is s for s in services):
                return role
        for role, wrappers in self._wrappers.items():
            if any(processor is w for w in wrappers):
                return role
        return None

    def _usable(self, role: str) -> bool:
        return any(s.is_usable for s in self._roles.get(role, []))

    def _other_usable(self, role: str, processor):
        for s in self._roles.get(role, []):
            if s is not processor and s.is_usable:
                return s
        return None

    # -- provider errors -------------------------------------------------------

    async def on_error(self, frame) -> None:
        """Feed every ErrorFrame that reaches the pipeline worker through here."""
        if self.failed or self._closed:
            return
        # A tool that raised says nothing about whether a provider is healthy.
        if getattr(frame, "category", None) == ErrorCategory.APPLICATION:
            return
        role = self._role_of(getattr(frame, "processor", None))
        if role is None:
            return

        processor = frame.processor
        why = safe_reason(frame.error)
        if not self._usable(role):
            await self.fail(role, f"no usable {role} service left ({why})")
            return
        # A provider's error can arrive a moment before the flag that marks it
        # unusable is set, so look again shortly rather than trust one reading.
        task = asyncio.create_task(self._recheck(role, why))
        self._rechecks.add(task)
        task.add_done_callback(self._rechecks.discard)
        if any(processor is w for w in self._wrappers.get(role, [])):
            return  # a wrapper's error is only worth the recheck above
        if not processor.is_usable:
            # Permanent failure but a backup exists: Pipecat's switcher is
            # already failing over, so there is nothing to do but note it.
            logger.warning(f"{role} provider is down; relying on its backup")
            self._record("provider_failover", role=role)
            return

        # Transient errors: one or two are normal, a burst is a dead provider.
        now = self._clock()
        recent = self._errors[role]
        recent.append(now)
        while recent and now - recent[0] > self._window:
            recent.popleft()
        if len(recent) < self._threshold:
            return
        recent.clear()
        backup = self._other_usable(role, processor)
        if backup is not None and self._switch_to is not None:
            logger.error(f"{self._threshold} {role} errors in {self._window:g}s; switching")
            self._record("provider_failover", role=role, cause="repeated errors")
            await self._switch_to(backup)
        else:
            await self.fail(role, f"{self._threshold} {role} errors within {self._window:g}s")

    async def _recheck(self, role: str, why: str) -> None:
        try:
            await asyncio.sleep(self._recheck_secs)
        except asyncio.CancelledError:
            return
        if not self.failed and not self._closed and not self._usable(role):
            await self.fail(role, f"no usable {role} service left ({why})")

    # -- response deadline -----------------------------------------------------

    def arm(self) -> None:
        """The caller finished speaking (or the call opened): a reply is now due."""
        if self.failed or self._closed:
            return
        self.disarm(reset_misses=False)
        self._watch_task = asyncio.create_task(self._watch())

    def disarm(self, reset_misses: bool = True) -> None:
        """The bot has started speaking, so the pipeline is alive."""
        if self._filler_pending:
            # This is the filler's audio, not the reply: keep the deadline running.
            self._filler_pending = False
            return
        if self._watch_task:
            self._watch_task.cancel()
            self._watch_task = None
        if reset_misses:
            self._missed = 0

    async def _watch(self) -> None:
        try:
            remaining = self._deadline
            # A slow reply gets a spoken "one moment" rather than dead air, once.
            if self._say and self._filler and 0 < self._filler_after < self._deadline:
                await asyncio.sleep(self._filler_after)
                remaining -= self._filler_after
                await self._speak_filler()
            await asyncio.sleep(remaining)
        except asyncio.CancelledError:
            return
        self._filler_pending = False
        self._watch_task = None
        if self._closed:
            return
        self._missed += 1
        logger.warning(
            f"No reply within {self._deadline:g}s ({self._missed}/{self._max_missed} misses)"
        )
        if self._missed >= self._max_missed:
            reason = f"no reply within {self._deadline:g}s, {self._missed} times"
            await self.fail("response", reason)
        else:
            # Keep watching: a silent caller must not give a dead line more time.
            self.arm()

    async def _speak_filler(self) -> None:
        logger.warning(f"No reply after {self._filler_after:g}s; saying the filler line")
        self._record("filler_spoken", after_secs=self._filler_after)
        self._filler_pending = True
        try:
            await self._say(self._filler)
        except Exception as e:
            # The deadline still runs, so a filler that cannot be spoken costs nothing.
            self._filler_pending = False
            logger.error(f"Could not queue the filler line: {safe_reason(e)}")

    # -- ending the call -------------------------------------------------------

    async def fail(self, role: str, reason: str) -> None:
        """End the call on purpose. Idempotent: only the first failure acts."""
        if self.failed:
            return
        self.failed = f"{role}: {reason}"
        self.disarm()
        logger.error(f"Call cannot continue, {self.failed}")
        self._record("call_failed", role=role, reason=reason)

        # TTS being the broken part means an apology cannot be spoken by us.
        if role != "tts" and self._usable("tts"):
            try:
                await self._say_and_end(self._apology)
            except Exception as e:
                logger.error(f"Could not queue the apology: {e!r}")
                await self._abort(False)
                return
            # If the apology never plays (TTS hangs too), do not wait forever.
            self._backstop_task = asyncio.create_task(self._backstop_then_abort())
        else:
            await self._abort(False)

    async def _backstop_then_abort(self) -> None:
        try:
            await asyncio.sleep(self._backstop)
        except asyncio.CancelledError:
            return
        logger.error("The apology did not finish in time; ending the call")
        await self._abort(False)

    def finished(self) -> None:
        """The pipeline has ended: stop every timer this call started."""
        self._closed = True
        self.disarm()
        for task in list(self._rechecks):
            task.cancel()
        self._rechecks.clear()
        if self._backstop_task:
            self._backstop_task.cancel()
            self._backstop_task = None


class BotSpeechObserver(BaseObserver):
    """Tell CallHealth the moment the bot's audio actually starts.

    Watching the audible signal, not the LLM's text, is what lets the response
    deadline catch a TTS that swallows the text and says nothing.
    """

    def __init__(self, health: CallHealth):
        super().__init__()
        self._health = health

    async def on_push_frame(self, data: FramePushed) -> None:
        if isinstance(data.frame, BotStartedSpeakingFrame):
            self._health.disarm()
