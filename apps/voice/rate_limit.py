"""A lightweight, in-process guard in front of /ws.

This is a safety net, not the real guard: it cannot tell a legitimate burst of
calls from a malicious one, and it does nothing against a distributed attacker
with many IPs. The real guard is Plivo webhook signature validation (still
open, see HANDOFF.md); this exists only so a leaked WEBHOOK_SECRET, a stuck
retry loop, or an unexpected spike cannot spin up unbounded Groq-calling
pipelines in the meantime.

Every check here is synchronous, in-memory, and does no I/O: a rejection is
instant and happens before any pipeline work starts (before persona lookup,
before the websocket is even accepted). Two independent limits:

- per-IP: how many connections one address has been ACCEPTED for in the last
  60 seconds (a rejected attempt never counts against the caller's own quota);
- global: how many accepted connections are open right now, across every IP.

Single-process, single-event-loop state: there is no lock, because nothing
here awaits between reading and updating its counters, so one check-and-update
call can never interleave with another.
"""

import math
import os
import time
from collections import defaultdict

DEFAULT_PER_IP_PER_MINUTE = 5
DEFAULT_MAX_CONCURRENT = 10
WINDOW_SECS = 60.0


def ws_rate_limit_per_minute() -> int:
    """WS_RATE_LIMIT_PER_MINUTE, or the default. An invalid value is an error."""
    raw = (os.getenv("WS_RATE_LIMIT_PER_MINUTE") or "").strip()
    if not raw:
        return DEFAULT_PER_IP_PER_MINUTE
    return _positive_int(raw, "WS_RATE_LIMIT_PER_MINUTE")


def ws_max_concurrent_calls() -> int:
    """WS_MAX_CONCURRENT_CALLS, or the default. An invalid value is an error."""
    raw = (os.getenv("WS_MAX_CONCURRENT_CALLS") or "").strip()
    if not raw:
        return DEFAULT_MAX_CONCURRENT
    return _positive_int(raw, "WS_MAX_CONCURRENT_CALLS")


def _positive_int(raw: str, name: str) -> int:
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name}={raw!r} is not a number") from None
    if not math.isfinite(value) or value < 1 or value != int(value):
        raise ValueError(f"{name}={raw!r} must be a positive whole number")
    return int(value)


class ConnectionLimiter:
    """Tracks accepted /ws connections to enforce both limits.

    `clock` is injectable so tests can move time without sleeping.
    """

    def __init__(
        self,
        per_ip_per_minute: int,
        max_concurrent: int,
        clock=time.monotonic,
    ):
        self._per_ip_per_minute = per_ip_per_minute
        self._max_concurrent = max_concurrent
        self._clock = clock
        self._recent: dict[str, list[float]] = defaultdict(list)
        self._concurrent = 0

    def try_accept(self, ip: str) -> str | None:
        """None if accepted (and counted); otherwise which limit was hit, to log."""
        now = self._clock()
        window = [t for t in self._recent[ip] if now - t < WINDOW_SECS]
        self._recent[ip] = window
        if len(window) >= self._per_ip_per_minute:
            return f"per-IP limit ({self._per_ip_per_minute}/min)"
        if self._concurrent >= self._max_concurrent:
            return f"global concurrent limit ({self._max_concurrent})"
        window.append(now)
        self._concurrent += 1
        return None

    def release(self) -> None:
        """Call exactly once for every try_accept() that returned None."""
        self._concurrent = max(0, self._concurrent - 1)
