"""The developer role must never reach the model — Qwen 400s on it."""

import main


class _Params(dict):
    """Stands in for the context params the base class merges in."""


def build(monkeypatch, messages):
    """Call the role-normalising layer without constructing a real service."""
    svc = object.__new__(main.PortableGroqLLMService)
    monkeypatch.setattr(
        main.GroqLLMService,
        "build_chat_completion_params",
        lambda self, p: {"model": "qwen/qwen3.8-27b", "messages": messages},
    )
    return svc.build_chat_completion_params(_Params())


def test_developer_role_becomes_user(monkeypatch):
    out = build(
        monkeypatch,
        [
            {"role": "system", "content": "be brief"},
            {"role": "developer", "content": "you were cut off"},
            {"role": "user", "content": "hello"},
        ],
    )
    roles = [m["role"] for m in out["messages"]]
    assert "developer" not in roles
    assert roles == ["system", "user", "user"]


def test_content_is_preserved(monkeypatch):
    out = build(monkeypatch, [{"role": "developer", "content": "you were cut off"}])
    assert out["messages"][0]["content"] == "you were cut off"


def test_other_roles_untouched(monkeypatch):
    original = [
        {"role": "system", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]
    assert build(monkeypatch, original)["messages"] == original
