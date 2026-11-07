"""server.NonceStore: a signed webhook's nonce is good once, for a bounded time and space."""

import server


def store(**kw):
    clock = {"t": 1000.0}
    s = server.NonceStore(clock=lambda: clock["t"], **kw)
    return s, clock


def test_first_use_passes_second_is_a_replay():
    s, _ = store(ttl=600, cap=100)
    assert s.claim("n1") is True
    assert s.claim("n1") is False


def test_a_nonce_is_forgotten_after_the_ttl():
    s, clock = store(ttl=600, cap=100)
    assert s.claim("n1")
    clock["t"] += 601
    assert s.claim("n1") is True  # Plivo's own window is long past; memory is not kept forever


def test_the_store_never_exceeds_its_cap_and_evicts_the_oldest():
    s, clock = store(ttl=600, cap=3)
    for i in range(5):
        clock["t"] += 1
        assert s.claim(f"n{i}")
    assert len(s) == 3
    assert s.claim("n4") is False  # newest still remembered
    assert s.claim("n0") is True   # oldest was evicted
