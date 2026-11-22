"""The two booking tools (2026-11-22): check_availability and book_meeting.

Thin on purpose, like the task tools: the Studio owns the calendar connection, reads the day
the caller said, checks the time is really open, and books it. This side names the tool,
passes on what the model asked for, and turns the reply into something the agent can say.
"""
import agents_store
import tools
from tools import CallContext, build_tool_schemas

BOTH = ["check_availability", "book_meeting"]
START = "2026-11-23T04:30:00.000Z"
WHEN = "Monday 23 November at 10:00 am"


def context(reply=None, log=None):
    call = CallContext(call_id="c1")

    async def run_tool(name, **args):
        if log is not None:
            log.append((name, args))
        return reply if reply is not None else {"ok": True}

    call.run_tool = run_tool
    call.turn_number = lambda: 7
    return call


def test_both_tools_are_known_to_the_registry_and_to_the_studio_list():
    assert set(BOTH) <= set(tools.REGISTRY)
    assert set(BOTH) <= set(agents_store.KNOWN_TOOLS)


def test_the_model_must_say_a_time_a_name_an_email_and_that_it_was_read_back():
    schemas = {s.name: s for s in build_tool_schemas(context(), BOTH)}
    assert schemas["book_meeting"].required == ["start", "name", "email", "email_confirmed"]
    assert schemas["book_meeting"].properties["email_confirmed"]["type"] == "boolean"
    assert schemas["check_availability"].required == []
    assert set(schemas["check_availability"].properties) == {"day", "after", "before"}


def test_the_description_tells_the_model_to_read_the_email_back_first():
    text = tools.REGISTRY["book_meeting"].description.lower()
    assert "read" in text and "back" in text


async def test_free_times_are_handed_back_as_the_studio_gave_them():
    reply = {"ok": True, "count": 2, "meeting": "30 minute call, 30 minutes",
             "note": "Offer at most three.",
             "slots": [{"start": START, "when": WHEN},
                       {"start": "2026-11-23T05:00:00.000Z",
                        "when": "Monday 23 November at 10:30 am"}]}
    log = []
    handler = tools.REGISTRY["check_availability"].handler
    out = await handler({"day": "tomorrow", "after": "10 am"}, context(reply, log))
    assert log == [("check_availability",
                    {"day": "tomorrow", "after": "10 am", "before": "", "turn": 7})]
    assert out["found"] is True and out["count"] == 2
    assert out["slots"][0]["when"] == WHEN


async def test_no_free_time_is_a_lookup_that_ran_with_advice():
    reply = {"ok": True, "slots": [], "count": 0,
             "message": "There is no free time in that window. Offer another day."}
    out = await tools.REGISTRY["check_availability"].handler({"day": "tomorrow"}, context(reply))
    assert out["found"] is False and out["slots"] == []
    assert "another day" in out["advice"]


async def test_a_calendar_that_cannot_be_read_is_said_plainly():
    reply = {"ok": False,
             "message": "Booking is not set up yet, so I cannot book a meeting. Say someone."}
    handler = tools.REGISTRY["check_availability"].handler
    out = await handler({}, context(reply))
    assert "not set up" in out["what_to_do"]
    out = await handler({}, CallContext(call_id="c1"))
    assert "what_to_do" in out and "calendar" in out["what_to_do"]


async def test_booking_passes_the_turn_so_a_retry_cannot_book_twice():
    log = []
    reply = {"ok": True, "booked": True, "when": WHEN, "email": "ravi@example.com"}
    args = {"start": START, "name": "Ravi", "email": "ravi@example.com",
            "email_confirmed": True}
    out = await tools.REGISTRY["book_meeting"].handler(args, context(reply, log))
    assert log == [("book_meeting", {"start": START, "invitee_name": "Ravi",
                                     "email": "ravi@example.com", "email_confirmed": True,
                                     "turn": 7})]
    assert out["booked"] is True and out["when"] == WHEN


async def test_confirmation_is_only_ever_true_when_the_model_said_exactly_true():
    log = []
    for said in (False, None, "yes", 1, "true"):
        await tools.REGISTRY["book_meeting"].handler(
            {"start": "x", "name": "n", "email": "e", "email_confirmed": said},
            context({"ok": False, "message": "m"}, log))
    assert [a["email_confirmed"] for _, a in log] == [False, False, False, False, False]


async def test_a_booking_that_did_not_happen_says_why_in_words_the_agent_can_use():
    reply = {"ok": False, "message": "That time is no longer free. Check the free times again."}
    out = await tools.REGISTRY["book_meeting"].handler(
        {"start": "x", "name": "n", "email": "e", "email_confirmed": True}, context(reply))
    assert out["booked"] is False and "no longer free" in out["what_to_do"]


def test_the_studios_copy_of_the_schemas_includes_them():
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "backend/src/models/toolSchemas.json"
    assert set(BOTH) <= set(json.loads(path.read_text()))
