"""The phone server listens on this machine only, unless told otherwise (2026-11-22).

It listened on every network interface (0.0.0.0), so anyone on the same Wi-Fi could reach it
directly, around the tunnel and the Studio. A real deployment behind a proxy or in a container
sets SERVER_HOST.
"""
import pytest
import server


def test_it_listens_on_this_machine_only_by_default(monkeypatch):
    monkeypatch.delenv("SERVER_HOST", raising=False)
    assert server.bind_host() == "127.0.0.1"


def test_a_deployment_can_say_otherwise(monkeypatch):
    monkeypatch.setenv("SERVER_HOST", "0.0.0.0")
    assert server.bind_host() == "0.0.0.0"


@pytest.mark.parametrize("bad", ["", "  ", "evil host", "1.2.3.4; rm -rf", "http://x", "a" * 300])
def test_nonsense_falls_back_to_this_machine(monkeypatch, bad):
    monkeypatch.setenv("SERVER_HOST", bad)
    assert server.bind_host() == "127.0.0.1"
