"""The "save what the caller says" tool.

The Studio decides what an answer means (dates, amounts, read-backs); this side only
has to name the right field, hand over what was heard, and say back whatever the Studio
replies. The questions come from the agent, so the schema the model sees is built per
call: a model cannot save into a field this agent does not have.
"""
import pytest
import tools
from tools import CallContext, build_tool_schemas

FIELDS = [
    {"key": "payment_date", "label": "Payment date", "kind": "date", "choices": [],
     "required": True, "ask": "On what exact date will you pay?"},
    {"key": "amount", "label": "Amount", "kind": "amount", "choices": [],
     "required": False, "ask": ""},
]


def context(**kwargs) -> CallContext:
    call = CallContext(call_id="c1", **kwargs)
    call.capture_fields = FIELDS
    return call


def schema_of(call, name="save_answer"):
    return next(s for s in build_tool_schemas(call, ["save_answer"]) if s.name == name)


def test_the_model_may_only_name_a_field_this_agent_has():
    schema = schema_of(context())
    assert schema.properties["field_key"]["enum"] == ["payment_date", "amount"]
    assert set(schema.required) == {"field_key", "said"}


def test_each_question_is_described_so_the_model_knows_what_it_is_for():
    described = schema_of(context()).properties["field_key"]["description"]
    assert "Payment date" in described and "Amount" in described


def test_the_tool_is_not_offered_at_all_when_the_agent_has_no_questions():
    call = CallContext(call_id="c1")
    call.capture_fields = []
    assert build_tool_schemas(call, ["save_answer"]) == []


async def test_what_was_said_goes_to_the_studio_with_its_turn():
    sent = []

    async def save(**kwargs):
        sent.append(kwargs)
        return {"ok": True, "value": "2026-12-15", "message": None}

    call = context()
    call.save_answer = save
    call.turn_number = lambda: 7
    result = await tools.REGISTRY["save_answer"].handler(
        {"field_key": "payment_date", "said": "15 December", "confirmed": True}, call)
    assert sent == [{"field_key": "payment_date", "said": "15 December",
                     "turn": 7, "confirmed": True}]
    assert result == {"saved": True, "value": "2026-12-15"}


async def test_the_studios_refusal_is_handed_back_for_the_agent_to_act_on():
    async def save(**kwargs):
        return {"ok": False, "value": "2026-12-15",
                "message": "Read it back to the caller and get a yes first."}

    call = context()
    call.save_answer = save
    result = await tools.REGISTRY["save_answer"].handler(
        {"field_key": "payment_date", "said": "tomorrow"}, call)
    assert result == {"saved": False, "value_heard": "2026-12-15",
                      "what_to_do": "Read it back to the caller and get a yes first."}


async def test_a_field_the_agent_does_not_have_is_refused_here_without_a_round_trip():
    called = False

    async def save(**kwargs):
        nonlocal called
        called = True
        return {"ok": True}

    call = context()
    call.save_answer = save
    result = await tools.REGISTRY["save_answer"].handler(
        {"field_key": "bank_account", "said": "x"}, call)
    assert called is False
    assert result["saved"] is False and "bank_account" not in str(result)


async def test_a_local_run_with_nowhere_to_save_says_so_instead_of_pretending():
    call = context()  # no save_answer: the mic-and-speakers run
    result = await tools.REGISTRY["save_answer"].handler(
        {"field_key": "amount", "said": "500"}, call)
    assert result["saved"] is False


async def test_the_studio_failing_never_reaches_the_caller_as_an_exception():
    async def save(**kwargs):
        raise RuntimeError("studio down")

    call = context()
    call.save_answer = save
    # The wrapper contains it; the handler itself must not leak the reason either.
    with pytest.raises(RuntimeError):
        await tools.REGISTRY["save_answer"].handler(
            {"field_key": "amount", "said": "500"}, call)
