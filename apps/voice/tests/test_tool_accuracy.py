"""What the tool history says about a tool call must be what happened.

Found by reading the tools against the history page (2026-11-15): a document lookup that FOUND
something was recorded as failed, because the instruction to the model that rides along with a
good answer was read as an error; and the agent could save the same lead twice in one call.
"""

import json

import pytest
import tools
from tests.test_tools import lead_rows, make_call, params, run
from transcript import CallTranscript, tool_succeeded


@pytest.fixture
def leads(tmp_path, monkeypatch):
    monkeypatch.setenv("LEADS_DIR", str(tmp_path / "leads"))
    return tmp_path / "leads"


def tool_lines(transcript):
    text = transcript.path.read_text(encoding="utf-8")
    return [json.loads(x) for x in text.splitlines() if '"tool"' in x]


# --- did it work? ------------------------------------------------------------


@pytest.mark.parametrize(
    "result, worked",
    [
        # A lookup that found passages: `what_to_do` is the instruction to the model, not an error.
        ({"found": True, "passages": ["Fees are 500"],
          "what_to_do": "Answer only from these passages"}, True),
        # A lookup that ran and found nothing is an answer, not a broken tool.
        ({"found": False, "what_to_do": "I do not have that in my documents."}, True),
        ({"tasks": [], "count": 0}, True),
        ({"saved": True, "value": "2026-11-20"}, True),
        ({"status": "saved", "phone_saved": "+911111111111"}, True),
        ({"status": "ending"}, True),
        ({"ok": True, "balance": 100}, True),
        ({"name": "Ravi", "tags": [], "details": {}, "answers": {}}, True),
        # These said they could not do it.
        ({"what_to_do": "I could not read the list just now."}, False),
        ({"saved": False, "what_to_do": "Please ask again."}, False),
        ({"ok": False, "what_to_do": "I could not do that."}, False),
        ({"error": "the tool failed; tell the caller you could not do that"}, False),
        ({"what_to_do": "I do not have their details."}, False),
        ({"added": False}, False),
        ({"moved": False, "what_to_do": "I could not move it."}, False),
        ({"done": False, "what_to_do": "I could not tick it off."}, False),
        # An error beats anything else in the same answer.
        ({"found": True, "error": "boom"}, False),
        ("not a dict", True),
        (None, True),
    ],
)
def test_a_tool_result_is_judged_by_what_it_says_not_by_its_advice(result, worked):
    assert tool_succeeded(result) is worked


async def test_a_good_document_lookup_is_logged_as_having_worked(tmp_path):
    call, transcript = make_call(tmp_path)

    async def run_tool(name, **args):
        return {"ok": True, "passages": ["Fees are 500 a month."]}

    call.run_tool = run_tool
    schemas = tools.build_tool_schemas(call, ["search_knowledge"])
    p, got = params(question="what are the fees")
    await run(schemas, "search_knowledge", p)
    assert got[0]["found"] is True
    line = tool_lines(transcript)[0]
    assert line["ok"] is True


async def test_a_lookup_with_nothing_found_is_logged_as_having_worked(tmp_path):
    call, transcript = make_call(tmp_path)

    async def run_tool(name, **args):
        return {"ok": True, "passages": [], "message": "I do not have that in my documents."}

    call.run_tool = run_tool
    schemas = tools.build_tool_schemas(call, ["search_knowledge"])
    p, got = params(question="what is the moon made of")
    await run(schemas, "search_knowledge", p)
    assert got[0]["found"] is False
    line = tool_lines(transcript)[0]
    assert line["ok"] is True


# --- a lead is saved once ----------------------------------------------------


async def test_the_same_lead_twice_in_one_call_is_saved_once(leads, tmp_path):
    call, _ = make_call(tmp_path)
    call.caller_number = "+911111111111"
    for text in ("Hi, I'm Asha Rao.", "Please call me back about pricing."):
        call.transcript.user(text)
    reported = []

    async def report_lead(lead):
        reported.append(lead)

    call.report_lead = report_lead
    schemas = tools.build_tool_schemas(call, ["capture_lead"])
    first, got1 = params(name="Asha Rao", reason="wants a callback about pricing")
    await run(schemas, "capture_lead", first)
    again, got2 = params(name="  asha   rao ", reason="Wants a callback about pricing.")
    await run(schemas, "capture_lead", again)
    assert got1[0]["status"] == "saved"
    # The model is told, and says nothing new to the caller.
    assert got2[0]["status"] == "already_saved"
    assert len(lead_rows(leads)) == 1
    assert len(reported) == 1


async def test_a_different_request_from_the_same_caller_is_a_second_lead(leads, tmp_path):
    call, _ = make_call(tmp_path)
    call.caller_number = "+911111111111"
    for text in ("Hi, I'm Asha Rao.", "Call me about pricing and also about the demo."):
        call.transcript.user(text)
    schemas = tools.build_tool_schemas(call, ["capture_lead"])
    for reason in ("wants a callback about pricing", "wants a demo of the product"):
        p, got = params(name="Asha Rao", reason=reason)
        await run(schemas, "capture_lead", p)
        assert got[0]["status"] == "saved"
    assert len(lead_rows(leads)) == 2


async def test_two_calls_do_not_share_their_saved_leads(leads, tmp_path):
    for call_id in ("c1", "c2"):
        transcript = CallTranscript(call_id, tmp_path / call_id)
        call = tools.CallContext(call_id=call_id, transcript=transcript)
        call.caller_number = "+911111111111"
        call.transcript.user("Hi, I'm Asha Rao. Call me about pricing.")
        schemas = tools.build_tool_schemas(call, ["capture_lead"])
        p, got = params(name="Asha Rao", reason="wants a callback about pricing")
        await run(schemas, "capture_lead", p)
        assert got[0]["status"] == "saved"
    assert len(lead_rows(leads)) == 2
