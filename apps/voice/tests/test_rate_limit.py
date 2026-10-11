"""ConnectionLimiter: the pure accounting behind the /ws rate limit, with no
server, no websocket, no I/O — just the two counters and the clock."""

import pytest
from rate_limit import (
    ConnectionLimiter,
    ws_max_concurrent_calls,
    ws_rate_limit_per_minute,
)


def test_a_connection_under_both_limits_is_accepted():
    limiter = ConnectionLimiter(per_ip_per_minute=5, max_concurrent=5)
    assert limiter.try_accept("1.2.3.4") is None


def test_the_sixth_connection_from_one_ip_in_a_minute_is_rejected():
    clock = [0.0]
    limiter = ConnectionLimiter(per_ip_per_minute=5, max_concurrent=100, clock=lambda: clock[0])
    for _ in range(5):
        assert limiter.try_accept("1.2.3.4") is None
        limiter.release()  # free the global slot; only the per-IP window matters here
    reason = limiter.try_accept("1.2.3.4")
    assert reason is not None
    assert "per-IP" in reason


def test_a_different_ip_is_not_affected_by_anothers_per_ip_limit():
    clock = [0.0]
    limiter = ConnectionLimiter(per_ip_per_minute=1, max_concurrent=100, clock=lambda: clock[0])
    assert limiter.try_accept("1.2.3.4") is None
    assert limiter.try_accept("5.6.7.8") is None


def test_the_per_ip_window_expires_after_sixty_seconds():
    clock = [0.0]
    limiter = ConnectionLimiter(per_ip_per_minute=1, max_concurrent=100, clock=lambda: clock[0])
    assert limiter.try_accept("1.2.3.4") is None
    assert limiter.try_accept("1.2.3.4") is not None
    clock[0] = 60.1
    assert limiter.try_accept("1.2.3.4") is None


def test_a_rejected_attempt_does_not_count_against_the_callers_own_quota():
    """Hitting the global cap must not also burn the IP's per-minute allowance:
    the caller did not actually get a connection, so it should not be charged."""
    clock = [0.0]
    limiter = ConnectionLimiter(per_ip_per_minute=5, max_concurrent=1, clock=lambda: clock[0])
    assert limiter.try_accept("1.2.3.4") is None  # takes the one global slot
    for _ in range(10):
        reason = limiter.try_accept("5.6.7.8")
        assert reason is not None and "global" in reason
    limiter.release()
    # 5.6.7.8 was never actually accepted, so its own quota is untouched.
    assert limiter.try_accept("5.6.7.8") is None


def test_the_third_concurrent_connection_overall_is_rejected():
    limiter = ConnectionLimiter(per_ip_per_minute=100, max_concurrent=2)
    assert limiter.try_accept("1.1.1.1") is None
    assert limiter.try_accept("2.2.2.2") is None
    reason = limiter.try_accept("3.3.3.3")
    assert reason is not None
    assert "global" in reason


def test_release_frees_a_concurrent_slot_for_the_next_connection():
    limiter = ConnectionLimiter(per_ip_per_minute=100, max_concurrent=1)
    assert limiter.try_accept("1.1.1.1") is None
    assert limiter.try_accept("2.2.2.2") is not None
    limiter.release()
    assert limiter.try_accept("2.2.2.2") is None


def test_release_without_a_prior_accept_never_goes_negative():
    limiter = ConnectionLimiter(per_ip_per_minute=5, max_concurrent=1)
    limiter.release()
    limiter.release()
    assert limiter.try_accept("1.1.1.1") is None
    assert limiter.try_accept("2.2.2.2") is not None


def test_ws_rate_limit_per_minute_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("WS_RATE_LIMIT_PER_MINUTE", raising=False)
    assert ws_rate_limit_per_minute() == 5
    monkeypatch.setenv("WS_RATE_LIMIT_PER_MINUTE", "20")
    assert ws_rate_limit_per_minute() == 20


def test_ws_max_concurrent_calls_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("WS_MAX_CONCURRENT_CALLS", raising=False)
    assert ws_max_concurrent_calls() == 10
    monkeypatch.setenv("WS_MAX_CONCURRENT_CALLS", "25")
    assert ws_max_concurrent_calls() == 25


@pytest.mark.parametrize("raw", ["0", "-1", "nope", "1.5"])
def test_invalid_values_raise_instead_of_falling_back(monkeypatch, raw):
    monkeypatch.setenv("WS_RATE_LIMIT_PER_MINUTE", raw)
    with pytest.raises(ValueError):
        ws_rate_limit_per_minute()
    monkeypatch.setenv("WS_MAX_CONCURRENT_CALLS", raw)
    with pytest.raises(ValueError):
        ws_max_concurrent_calls()
