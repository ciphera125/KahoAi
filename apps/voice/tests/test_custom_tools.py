"""Tools a customer defined themselves.

The voice service never sees the address or the key: the Studio holds those and makes
the request. This side is told the name, what it is for and what to collect, offers that
to the model, and says back whatever the Studio replies.
"""
from types import SimpleNamespace

from tools import CallContext, build_tool_schemas

DEFINITION = {
    "name": "check_order_status",
    "label": "Check order status",
    "description": "Use when the caller asks where their order is.",
    "inputs": [
        {"key": "order_number", "label": "Order number", "type": "text",
         "required": True, "description": "Their order number", "example": "A1"},
        {"key": "urgent", "label": "Urgent", "type": "yes_no", "required": False,
         "description": "", "example": ""},
    ],
    "say_while_waiting": "One moment, let me check.",
}


def context(reply=None, log=None, definitions=None):
    call = CallContext(call_id="c1")
    call.custom_tools = definitions if definitions is not None else [DEFINITION]

    async def run_custom_tool(name, values):
        if log is not None:
            log.append((name, values))
        return reply if reply is not None else {"ok": True, "values": {}}

    call.run_custom_tool = run_custom_tool
    return call


async def run(call, args):
    """Drive the real per-call handler the way Pipecat does."""
    out = {}

    async def result_callback(result, **kwargs):
        out.update(result)

    schema = next(s for s in build_tool_schemas(call, ["check_order_status"]))
    await schema.handler(SimpleNamespace(arguments=args, result_callback=result_callback))
    return out


def test_the_customers_own_tool_is_offered_under_its_own_name():
    schema = next(s for s in build_tool_schemas(context(), ["check_order_status"]))
    assert schema.name == "check_order_status"
    assert schema.description.startswith("Use when the caller asks")
    assert set(schema.properties) == {"order_number", "urgent"}
    assert schema.required == ["order_number"]
    assert schema.properties["urgent"]["type"] == "boolean"


def test_a_tool_this_call_was_not_given_is_left_out_rather_than_stopping_the_call():
    # The Studio decides the list, and a tool deleted while it was still attached to an
    # agent must not stop the call being answered.
    assert build_tool_schemas(context(definitions=[]), ["check_order_status"], strict=False) == []


def test_nothing_about_the_address_or_the_key_is_anywhere_in_the_schema():
    schema = next(s for s in build_tool_schemas(context(), ["check_order_status"]))
    text = f"{schema.name}{schema.description}{schema.properties}"
    for secret in ("http", "Authorization", "Bearer", "api.", "token"):
        assert secret not in text


async def test_what_the_agent_collected_goes_to_the_studio_under_the_tools_name():
    log = []
    call = context({"ok": True, "values": {"order_status": "shipped"}}, log)
    out = await run(call, {"order_number": "A1", "urgent": True})
    assert log == [("check_order_status", {"order_number": "A1", "urgent": True})]
    assert out == {"ok": True, "order_status": "shipped"}


async def test_a_refusal_comes_back_as_something_to_say_and_never_a_reason():
    call = context({"ok": False, "message": "I could not get that just now."})
    out = await run(call, {"order_number": "A1"})
    assert out == {"ok": False, "what_to_do": "I could not get that just now."}


async def test_a_local_run_with_no_studio_says_so_rather_than_inventing_an_answer():
    call = CallContext(call_id="c1")
    call.custom_tools = [DEFINITION]
    out = await run(call, {"order_number": "A1"})
    assert out["ok"] is False
