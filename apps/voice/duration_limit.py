"""A hard ceiling on how long any call can run.

A call that never ends costs money on every provider (telephony, STT, LLM, TTS)
for as long as it lasts, and an outbound call can be left running by a caller
who has simply walked away. So the ceiling is enforced by a timer that does not
depend on the pipeline being healthy: it runs beside it, and when it fires it
works down a list of ways to end the call, each with its own timeout, so one
that hangs or fails cannot stop the next.

The ceiling comes from the server's own configuration. A request (an outbound
call's --max-duration) can only lower it, never raise it, so nobody holding the
webhook token can extend a call past what the operator allowed.
"""

import asyncio
import math
import os
from collections.abc import Awaitable, Callable

from loguru import logger

DEFAULT_MAX_SECS = 600.0
# Below this a call could not even finish its greeting, so it is a typo, not a policy.
FLOOR_SECS = 10.0
STEP_TIMEOUT_SECS = 10.0

Step = tuple[str, Callable[[], Awaitable[None]]]


def configured_ceiling() -> float:
    """MAX_CALL_DURATION_SECS, or the default. An invalid value is an error, not a default."""
    raw = (os.getenv("MAX_CALL_DURATION_SECS") or "").strip()
    if not raw:
        return DEFAULT_MAX_SECS
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"MAX_CALL_DURATION_SECS={raw!r} is not a number") from None
    if not math.isfinite(value) or value < FLOOR_SECS:
        raise ValueError(f"MAX_CALL_DURATION_SECS={raw!r} must be at least {FLOOR_SECS:g}")
    return value


def resolve_max_duration(requested: float | None = None) -> float:
    """The ceiling for one call: the requested value if it is lower, otherwise the server's."""
    ceiling = configured_ceiling()
    if requested is None or not math.isfinite(requested):
        return ceiling
    return min(ceiling, max(FLOOR_SECS, requested))


async def _run_step(name: str, step: Callable[[], Awaitable[None]], timeout: float) -> bool:
    try:
        await asyncio.wait_for(step(), timeout)
    except TimeoutError:
        logger.error(f"Max duration: '{name}' did not finish within {timeout:g}s")
    except Exception as e:
        logger.error(f"Max duration: '{name}' failed: {e!r}")
    else:
        logger.info(f"Max duration: '{name}' done")
        return True
    return False


async def enforce_max_duration(
    max_secs: float,
    steps: list[Step],
    *,
    record: Callable[..., None] | None = None,
    step_timeout: float = STEP_TIMEOUT_SECS,
) -> None:
    """Sleep for `max_secs`, then end the call by every means in `steps`, in order.

    Runs as a task beside the call; cancel it when the call ends first. It does
    nothing until the time is up, and never raises.
    """
    await asyncio.sleep(max_secs)
    logger.error(f"Call exceeded the maximum duration of {max_secs:g}s; hanging up")
    if record is not None:
        try:
            record("max_duration_exceeded", limit_secs=max_secs)
        except Exception as e:
            logger.error(f"Could not record the max-duration event: {e!r}")
    for name, step in steps:
        await _run_step(name, step, step_timeout)
