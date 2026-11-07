"""The four task tools.

They are thin on purpose: the Studio owns the task list, reads the dates and decides
whose list may be touched. This side names the tool, passes on what the model asked for,
and turns the reply into something the agent can say. A task id the model made up, or
one belonging to somebody else, is refused there, not here.
"""
import tools
from tools import CallContext, build_tool_schemas

TASK_TOOLS = ["get_tasks", "add_task", "reschedule_task", "mark_task_done"]


def context(reply=None, log=None):
    call = CallContext(call_id="c1")

    async def run_tool(name, **args):
        if log is not None:
            log.append((name, args))
        return reply if reply is not None else {"ok": True}

    call.run_tool = run_tool
    call.turn_number = lambda: 5
    return call


def test_every_task_tool_is_offered_with_what_the_model_must_say():
    schemas = {s.name: s for s in build_tool_schemas(context(), TASK_TOOLS)}
    assert set(schemas) == set(TASK_TOOLS)
    assert schemas["add_task"].required == ["title"]
    assert schemas["reschedule_task"].required == ["task_id", "due"]
    assert schemas["mark_task_done"].required == ["task_id"]
    assert schemas["get_tasks"].required == []


def test_the_model_may_only_ask_for_stretches_of_time_we_understand():
    schemas = {s.name: s for s in build_tool_schemas(context(), TASK_TOOLS)}
    assert schemas["get_tasks"].properties["range"]["enum"] == [
        "today", "yesterday", "this_week", "overdue", "all"]
    assert schemas["get_tasks"].properties["status"]["enum"] == ["pending", "done", "all"]


async def test_reading_the_list_hands_back_what_the_studio_sent():
    reply = {"ok": True, "count": 1,
             "tasks": [{"id": "tk_1", "title": "Pay EMI", "due": "2026-11-20T03:30:00.000Z"}]}
    log = []
    call = context(reply, log)
    out = await tools.REGISTRY["get_tasks"].handler({"range": "this_week"}, call)
    assert log == [("get_tasks", {"range": "this_week", "status": "pending", "turn": 5})]
    assert out["tasks"][0]["title"] == "Pay EMI"
    assert out["count"] == 1


async def test_adding_a_task_passes_the_turn_so_a_retry_cannot_make_two():
    log = []
    call = context({"ok": True, "task_id": "tk_2", "title": "Pay", "due": None}, log)
    out = await tools.REGISTRY["add_task"].handler({"title": "Pay", "due": "next Friday"}, call)
    assert log == [("add_task", {"title": "Pay", "due": "next Friday", "turn": 5})]
    assert out["added"] is True


async def test_a_refusal_is_handed_to_the_agent_as_what_to_say_next():
    call = context({"ok": False, "message": "I could not find that task on their list."})
    out = await tools.REGISTRY["mark_task_done"].handler({"task_id": "tk_nope"}, call)
    assert out == {"done": False, "what_to_do": "I could not find that task on their list."}


async def test_moving_a_task_needs_both_the_task_and_the_new_date():
    log = []
    call = context({"ok": True, "task_id": "tk_1", "due": "2026-11-20T03:30:00.000Z"}, log)
    out = await tools.REGISTRY["reschedule_task"].handler(
        {"task_id": "tk_1", "due": "next Friday"}, call)
    assert log == [("reschedule_task", {"task_id": "tk_1", "due": "next Friday", "turn": 5})]
    assert out["moved"] is True


async def test_on_a_local_run_there_is_no_task_list_and_the_tools_say_so():
    call = CallContext(call_id="c1")  # no run_tool: the mic-and-speakers run
    for name in TASK_TOOLS:
        out = await tools.REGISTRY[name].handler(
            {"title": "x", "task_id": "tk_1", "due": "tomorrow"}, call)
        assert "what_to_do" in out


# --- looking the caller up ---------------------------------------------------


async def test_looking_up_the_caller_hands_back_what_the_studio_knows():
    log = []
    call = context({"ok": True, "name": "Ravi Kumar", "tags": ["emi"],
                    "details": {"loan_amount": 250000},
                    "answers": {"payment_date": "2026-12-15"}}, log)
    out = await tools.REGISTRY["look_up_contact"].handler({}, call)
    assert log == [("look_up_contact", {"turn": 5})]
    assert out["name"] == "Ravi Kumar"
    assert out["details"] == {"loan_amount": 250000}
    assert out["answers"] == {"payment_date": "2026-12-15"}


async def test_an_unknown_caller_is_said_plainly_so_the_agent_asks_instead():
    call = context({"ok": False, "message": "I do not have their details."})
    out = await tools.REGISTRY["look_up_contact"].handler({}, call)
    assert out == {"what_to_do": "I do not have their details."}


def test_looking_up_takes_nothing_from_the_model():
    # Who is on the call is decided by the call, never by an argument.
    schema = next(s for s in build_tool_schemas(context(), ["look_up_contact"]))
    assert schema.properties == {}
    assert schema.required == []
