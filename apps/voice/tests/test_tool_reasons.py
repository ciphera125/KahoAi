"""Every message a tool can send back to the agent must have a reading on the Studio's Tool calls page.

The page tells a business owner whether a tool call worked, needed more from the caller, was stopped by
a safety check, or broke; it decides from the message (backend/src/models/toolReasons.json). A new
message written here without a line there would be shown as "Failed" with the model's own words, so
this test makes adding a message and deciding what it means one change.
"""

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
KEYS = {"error", "what_to_do", "message"}


def _reasons() -> list[str]:
    shared = json.loads((ROOT / "backend/src/models/toolReasons.json").read_text())
    return [r["match"] for r in shared["reasons"]]


def _strings(node: ast.AST) -> list[str]:
    """The text a dict value can carry: a plain string, the fixed parts of an f-string, or the
    fallback after `or` (reply.get("message") or "I could not add it.")."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.JoinedStr):
        return [" ".join(v.value for v in node.values if isinstance(v, ast.Constant))]
    if isinstance(node, ast.BoolOp):
        return [s for v in node.values for s in _strings(v)]
    return []


def _messages() -> list[str]:
    tree = ast.parse((ROOT / "apps/voice/tools.py").read_text())
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        keys = {k.value for k in node.keys if isinstance(k, ast.Constant)}
        if "found" in keys:
            continue  # a lookup that ran: its advice rides along with the answer and is not a failure
        for key, value in zip(node.keys, node.values, strict=True):
            if isinstance(key, ast.Constant) and key.value in KEYS:
                found += [s for s in _strings(value) if len(s.strip()) > 3]
    return found


def test_the_voice_service_sends_back_messages_this_test_can_see():
    messages = _messages()
    assert len(messages) > 15
    assert any("has not said goodbye" in m for m in messages)


def test_every_message_a_tool_sends_back_has_a_reading_on_the_tool_calls_page():
    reasons = _reasons()
    unread = [m for m in _messages() if not any(r in m.lower() for r in reasons)]
    assert not unread, "add these to backend/src/models/toolReasons.json: " + "; ".join(unread)
