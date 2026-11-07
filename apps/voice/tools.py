"""Tools the agent can call mid-conversation.

Adding one is a single decorated function:

    @tool(
        "check_slot",
        "Check whether an appointment slot is free.",
        properties={"day": {"type": "string", "description": "e.g. 'Monday'"}},
        required=["day"],
    )
    async def check_slot(args: dict, call: "CallContext") -> dict:
        return {"free": True}

It is then switched on per deployment by naming it in TOOLS_ENABLED. What a tool
does is code; when the agent should use it belongs in the persona file, which
also keeps VOICE_RULES short.

Every call goes through one wrapper, so each tool gets the same guarantees
without having to remember them:
- a deadline (TOOL_TIMEOUT_SECS): the caller is on the line in silence while a
  tool runs, so a slow one is cut off and reported to the model as an error
  rather than left to hang the call;
- errors are contained: an exception becomes an {"error": ...} result the model
  can explain to the caller, never a crash inside the LLM service;
- both the arguments and the result are written to the call transcript, which
  masks Aadhaar and PAN, so tool traffic obeys the same storage rule as speech.

A tool that ends the call (`ends_call=True`, only `end_call` today) skips the
follow-up LLM reply Pipecat would otherwise request after a successful result:
that reply is a second request on the same hung-prone LLM, with no one left to
hear it, so the persona says the goodbye before the call and the tool itself
asks for nothing further.
"""

import asyncio
import ipaddress
import json
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiohttp
from loguru import logger
from masking import mask_sensitive
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.services.llm_service import FunctionCallParams

DEFAULT_TIMEOUT_SECS = 8.0

ToolHandler = Callable[[dict, "CallContext"], Awaitable[dict]]


@dataclass
class CallContext:
    """What a tool can see of the call it is running in."""

    call_id: str
    transcript: Any = None
    # The caller's own number from the telephony webhook; None on a local run.
    caller_number: str | None = None
    # Set by whoever builds the pipeline: ends the call once queued speech is done.
    hang_up: Callable[[], Awaitable[None]] | None = None
    # Set by the phone server: hands the live call to a human. None on a local run.
    transfer: Callable[[], Awaitable[None]] | None = None
    # Set by the phone server: mirrors a captured lead to the Studio
    # (studio_link.report_lead). None on a local run, where the lead stays
    # only in leads/*.jsonl, as before.
    report_lead: Callable[[dict], Awaitable[None]] | None = None
    # The questions this agent asks and saves, from the Studio's agent settings:
    # {key, label, kind, choices, required, ask}. Empty on a local run.
    capture_fields: list = field(default_factory=list)
    # Set by the phone server: saves one answer through the Studio
    # (studio_link.save_answer). None on a local run, where there is nowhere to put it.
    save_answer: Callable[..., Awaitable[dict]] | None = None
    # Set by the phone server: runs one of the Studio's own tools for this call
    # (studio_link.run_tool). None on a local run, where there is no task list.
    run_tool: Callable[..., Awaitable[dict]] | None = None
    # Which caller turn we are on, for the Studio's idempotency key: the same answer
    # sent twice on one turn is one answer, a correction on a later turn is a new one.
    turn_number: Callable[[], int] | None = None
    # Room for per-call state a deployment's tools want to share (a looked-up
    # customer, a chosen slot) without reaching for globals.
    state: dict = field(default_factory=dict)


@dataclass
class Tool:
    name: str
    description: str
    properties: dict
    required: list[str]
    handler: ToolHandler
    # Some tools only make sense with what this particular agent was set up with: the
    # capture tool's fields come from the Studio, so its schema is built per call and
    # the tool is left out entirely when there is nothing for it to do.
    schema_for: Callable[["CallContext"], tuple | None] | None = None
    # True for a tool that leaves no one to talk to next (end_call). Its result
    # is not handed back to the model for a follow-up reply: that reply is a
    # second LLM request, and one that hangs blocks the hang-up behind it
    # (seen live, 2026-10-02 persists into end_call's own path). The persona
    # says the goodbye before calling the tool, so no reply is lost by skipping it.
    ends_call: bool = False


REGISTRY: dict[str, Tool] = {}


def tool(
    name: str,
    description: str,
    properties: dict | None = None,
    required=None,
    ends_call: bool = False,
    schema_for=None,
):
    """Register an async function as a tool the model may call."""

    def decorate(fn: ToolHandler) -> ToolHandler:
        if name in REGISTRY:
            raise ValueError(f"tool {name!r} is already registered")
        REGISTRY[name] = Tool(
            name, description, properties or {}, list(required or []), fn,
            schema_for=schema_for, ends_call=ends_call
        )
        return fn

    return decorate


def _log(call: CallContext, name: str, args: dict, result: dict, seconds: float) -> None:
    if call.transcript is not None:
        call.transcript.tool(name, args, result, seconds)


def _wrap(t: Tool, call: CallContext, timeout: float):
    async def run(params: FunctionCallParams) -> None:
        args = dict(params.arguments or {})
        started = time.monotonic()
        try:
            result = await asyncio.wait_for(t.handler(args, call), timeout)
        except TimeoutError:
            logger.error(f"Tool {t.name} timed out after {timeout}s")
            result = {"error": "the lookup took too long; tell the caller and offer to try again"}
        except Exception as e:
            logger.error(f"Tool {t.name} failed: {e!r}")
            result = {"error": "the tool failed; tell the caller you could not do that"}
        _log(call, t.name, args, result, time.monotonic() - started)
        if t.ends_call and "error" not in result:
            # No one is left to reply to: skip the follow-up completion Pipecat
            # would otherwise request, rather than let a hang in that request
            # block the hang-up behind it.
            await params.result_callback(
                result, properties=FunctionCallResultProperties(run_llm=False)
            )
        else:
            await params.result_callback(result)

    return run


def enabled_names(raw: str | None) -> list[str]:
    return [n.strip() for n in (raw or "end_call,capture_lead").split(",") if n.strip()]


def build_tool_schemas(
    call: CallContext, names: list[str], timeout: float = DEFAULT_TIMEOUT_SECS
) -> list[FunctionSchema]:
    """Schemas for the named tools, each carrying its wrapped handler."""
    unknown = [n for n in names if n not in REGISTRY]
    if unknown:
        raise ValueError(
            f"TOOLS_ENABLED names unknown tool(s): {', '.join(unknown)}. "
            f"Known: {', '.join(sorted(REGISTRY)) or 'none'}."
        )
    schemas = []
    for t in (REGISTRY[n] for n in names):
        properties, required = t.properties, t.required
        if t.schema_for is not None:
            built = t.schema_for(call)
            if built is None:
                continue  # nothing for it to do on this call: do not offer it at all
            properties, required = built
        schemas.append(
            FunctionSchema(
                name=t.name,
                description=t.description,
                properties=properties,
                required=required,
                handler=_wrap(t, call, timeout),
            )
        )
    return schemas


# Words that end a call outright. "That's all" is not one: nova-3 has written it
# for a caller who said "अच्छा" ("okay"), and the call was hung up on them.
_GOODBYE = re.compile(
    r"\b(?:bye|goodbye|good bye|hang up|cut the call|end the call|disconnect)\b"
    r"|अलविदा|बाय|फ़ोन रख|फोन रख|कॉल काट|phone rakh|call kaat",
    re.IGNORECASE,
)
# A short no, which ends the call only as the answer to "anything else?".
_DECLINE = re.compile(
    r"^\W*(?:(?:no|nope|nothing|nah|nahi|nahin|that'?s (?:it|all))\b|नहीं|बस|कुछ नहीं)",
    re.IGNORECASE,
)
_ASKED_ANYTHING_ELSE = re.compile(r"anything else|something else|any other|कुछ और|और कुछ", re.I)


def caller_said_goodbye(turns: list[tuple[str, str]]) -> bool:
    """Whether the caller's words since the agent last spoke end the call.

    Either a goodbye in so many words, or a short no to the agent asking whether
    there is anything else. On real calls the model hung up on "Sorry to
    interrupt you.", "1 more time." and a misheard "अच्छा"; none of those pass.
    """
    last_agent, caller_since = "", []
    for role, text in turns:
        if role == "agent":
            last_agent, caller_since = text, []
        else:
            caller_since.append(text)
    said = " ".join(caller_since)
    if _GOODBYE.search(said):
        return True
    return bool(caller_since and _ASKED_ANYTHING_ELSE.search(last_agent) and _DECLINE.search(said))


@tool(
    "end_call",
    "Hang up. Use only when the caller says goodbye ('bye', 'alvida', 'hang up') "
    "or answers no when you have just asked whether there is anything else. "
    "Anything short of that, including 'that's all' or 'okay' on their own, is "
    "not a goodbye: ask whether there is anything else instead. "
    "Never use it for a question, including one about the call itself, "
    "recording, or privacy ('are you recording this?', 'is this legal?', 'who "
    "am I talking to?') -- answer the question and keep talking. Never use it "
    "just because the conversation stalled, a reply was delayed, or the caller "
    "repeated themselves ('I wanted to tell you something.') -- that is "
    "impatience, not a goodbye; let them speak. If it is unclear whether they "
    "want to end the call, ask them; do not guess by ending it. The text you "
    "speak in this same turn must itself be that goodbye -- never call this "
    "tool alongside text that invites the caller to continue or answers a "
    "question ('sure, go ahead', 'what did you want to tell me?'): if your own "
    "words are not a goodbye, do not call this tool.",
    ends_call=True,
)
async def end_call(args: dict, call: CallContext) -> dict:
    # Queued after the goodbye has been spoken, not cut across it.
    if call.hang_up is None:
        return {"error": "this call cannot be ended from here"}
    if call.transcript is not None and not caller_said_goodbye(call.transcript.turns):
        return {"error": "the caller has not said goodbye, so do not hang up; keep helping, "
                "or ask if there is anything else you can do for them"}
    await call.hang_up()
    return {"status": "ending"}


def leads_dir() -> Path:
    return Path(os.getenv("LEADS_DIR") or Path(__file__).resolve().parent.parent.parent / "leads")


def clean_phone(raw: str | None) -> str | None:
    """Digits with an optional leading +, or None if nothing phone-like is there."""
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 7:
        return None
    return ("+" if raw.startswith("+") else "") + digits


_PLACEHOLDERS = {"unknown", "n/a", "na", "none", "null", "caller", "name", "not given"}
_DEVANAGARI = re.compile(r"[\u0900-\u097F]")


# A reason that says there is none: gpt-oss-20b saved "No request specified" for a
# caller who had asked for nothing (892bf848, 2026-10-25).
_NO_REASON = re.compile(
    r"^\W*(?:no(?:thing)?|not|none)\b.*\b(?:specified|given|stated|mentioned|provided|"
    r"request|reason)\W*$|^\W*(?:nothing|not specified|unspecified)\W*$",
    re.IGNORECASE,
)


def _is_placeholder(value: str) -> bool:
    """A stand-in for a value the model does not have: "?", "unknown", no letters."""
    text = value.strip().lower().strip(" .")
    return "?" in text or text in _PLACEHOLDERS or not re.search(r"[^\W\d_]", text)


def _caller_said(name: str, heard: list[str]) -> bool:
    """Whether some part of the name occurs in what the caller said.

    A name the STT wrote in Devanagari cannot be matched against the model's Latin
    spelling, so any Devanagari speech lets it through rather than refuse a real lead.
    """
    said = " ".join(heard).lower()
    if _DEVANAGARI.search(said):
        return True
    # Whole words of two letters or more ("Om" is a name; "b" is not), each matched
    # as a word: "Ram" inside "program" is not the caller saying it. A name with no
    # such part was once let through unchecked, and "b" nearly became a lead.
    words = set(re.findall(r"[^\W\d_]+", said))
    parts = re.findall(r"[^\W\d_]{2,}", name.lower())
    return any(p in words for p in parts)


@tool(
    "capture_lead",
    "Save a caller's details so a person can follow up. Use it whenever the caller "
    "wants to leave contact information, asks for a callback, or shows interest in "
    "something, as soon as you have their name and what they want, not only at the "
    "end of the call. Read the details back and save only after the caller confirms.",
    properties={
        # Nothing is required and null is allowed: Groq fails the whole turn on
        # a missing or null argument ("missing properties: 'reason'", 892bf848,
        # 2026-10-25), and the caller hears silence. The handler asks instead.
        "name": {"type": ["string", "null"], "description": "The caller's name."},
        "reason": {
            "type": ["string", "null"],
            "description": "One line on what they want, in their own terms.",
        },
        "phone": {
            # Null allowed: the model sends null when it has no other number, and
            # Groq rejects the whole reply when an argument breaks the schema
            # (seen live, 2026-10-24: it cost the call its greeting).
            "type": ["string", "null"],
            "description": "Number to reach them on, only if they gave one different "
            "from the one they are calling from.",
        },
    },
    required=[],
)
async def capture_lead(args: dict, call: CallContext) -> dict:
    name = " ".join(str(args.get("name") or "").split())
    reason = " ".join(str(args.get("reason") or "").split())
    if not name or not reason:
        return {"error": "a name and a reason are both needed; ask the caller for the missing one"}

    # On real calls the model saved leads during its own greeting, with "?" for
    # every field, and with its own name. The prompt already said not to; the
    # code now refuses, so nothing it guesses reaches the leads file.
    heard = call.transcript.caller_text if call.transcript is not None else None
    if heard is not None and not heard:
        return {"error": "the caller has not said anything yet; never save a lead before "
                "they ask for a callback and give their details"}
    for field_name, value in (("name", name), ("reason", reason)):
        if _is_placeholder(value):
            return {"error": f"do not guess; ask the caller for their real {field_name}"}
    if _NO_REASON.search(reason):
        return {"error": "the caller has not asked for anything; save a lead only for a "
                "real request, and ask what they want if you need to (reason)"}
    raw_phone = str(args.get("phone") or "")
    if raw_phone and ("?" in raw_phone or not re.search(r"\d", raw_phone)):
        return {"error": "do not guess; ask the caller for their real phone number"}
    if heard is not None and not _caller_said(name, heard):
        return {"error": "the caller has not told you that name; ask them for their name"}

    stated = clean_phone(args.get("phone"))
    phone = stated or clean_phone(call.caller_number)
    if not phone:
        return {"error": "there is no number to reach them on; ask the caller for one"}

    # Free text can hold anything a caller said, including a full Aadhaar or PAN,
    # which must never reach disk. Same rule as the transcript, same function.
    now = datetime.now(UTC)
    lead = {
        "at": now.isoformat(),
        "call_id": call.call_id,
        "name": mask_sensitive(name),
        "phone": phone,
        "phone_source": "caller_stated" if stated else "call_metadata",
        "reason": mask_sensitive(reason),
    }
    directory = leads_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # One file per day; a single small write per lead keeps concurrent calls from
    # interleaving lines.
    with (directory / f"{now:%Y-%m-%d}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(lead, ensure_ascii=False) + "\n")
    logger.info(f"Lead captured for call {call.call_id}")
    if call.report_lead is not None:
        try:
            await call.report_lead(lead)
        except Exception as e:  # noqa: BLE001 - the local file is the record; the Studio copy is extra
            logger.warning(f"Could not report lead for call {call.call_id} to the Studio: {e!r}")
    return {"status": "saved", "phone_saved": phone}



@tool(
    "transfer_to_human",
    "Hand the call to a person. Use it when the caller asks for a human, or has a "
    "need you cannot meet. Say one short line that you are connecting them, in the "
    "same turn.",
)
async def transfer_to_human(args: dict, call: CallContext) -> dict:
    # The destination is server configuration (TRANSFER_NUMBER), never something the
    # model or the caller can choose.
    if call.transfer is None:
        return {"error": "this call cannot be transferred from here; offer to take a message"}
    await call.transfer()
    return {"status": "transferring"}


WEBHOOK_TIMEOUT_SECS = 6.0
WEBHOOK_MAX_REPLY_CHARS = 500


def webhook_url_problem(url: str | None) -> str | None:
    """Why this URL may not be used, or None. https only; plain http for loopback dev."""
    if not url:
        return "TOOL_WEBHOOK_URL is not set"
    parsed = re.match(r"^(https?)://([^/:?#]+)", url)
    if not parsed:
        return "TOOL_WEBHOOK_URL is not an http(s) URL"
    scheme, host = parsed.groups()
    if scheme == "https":
        return None
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    return None if loopback else "TOOL_WEBHOOK_URL must be https (http only for localhost)"


@tool(
    "call_webhook",
    "Save or look something up in the business's own system. Use it only for what the "
    "persona says it is for. The answer comes back as text for you to use.",
    properties={
        "action": {
            "type": "string",
            "description": "What to do, as the persona names it, e.g. 'check_order'.",
        },
        "details": {
            "type": "string",
            "description": "The facts the action needs, in one short line.",
        },
    },
    required=["action"],
)
async def call_webhook(args: dict, call: CallContext) -> dict:
    """POST to one fixed URL from the environment, never one the model supplies.

    The URL is configuration so a caller cannot steer the server at an internal
    address; redirects are not followed for the same reason. The body is masked like
    everything else that leaves our process about a caller.
    """
    url = os.getenv("TOOL_WEBHOOK_URL")
    if problem := webhook_url_problem(url):
        return {"error": f"{problem}; tell the caller you cannot do that right now"}
    body = {
        "call_id": call.call_id,
        "caller": call.caller_number,
        "action": mask_sensitive(" ".join(str(args.get("action") or "").split())),
        "details": mask_sensitive(" ".join(str(args.get("details") or "").split())),
    }
    if not body["action"]:
        return {"error": "an action is needed"}
    headers = {}
    if secret := os.getenv("TOOL_WEBHOOK_SECRET"):
        headers["Authorization"] = f"Bearer {secret}"
    timeout = aiohttp.ClientTimeout(total=WEBHOOK_TIMEOUT_SECS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body, headers=headers, allow_redirects=False) as r:
                text = (await r.text())[:WEBHOOK_MAX_REPLY_CHARS]
                status = r.status
    except (TimeoutError, aiohttp.ClientError) as e:
        logger.error(f"Webhook for call {call.call_id} failed: {type(e).__name__}")
        return {"error": "the business system did not answer; tell the caller you could not"}
    if not 200 <= status < 300:
        logger.error(f"Webhook for call {call.call_id} returned HTTP {status}")
        return {"error": f"the business system refused (HTTP {status}); tell the caller"}
    return {"status": "ok", "reply": mask_sensitive(text)}


# --- saving what the caller says ---------------------------------------------


def _capture_schema(call: CallContext):
    """The fields this agent was given, as an enum the model must choose from. None when
    the agent has no questions, so the tool is not offered at all."""
    fields = list(getattr(call, "capture_fields", None) or [])
    if not fields:
        return None
    described = "; ".join(
        f"{f['key']} = {f['label']}" + (f" ({f['ask']})" if f.get("ask") else "") for f in fields
    )
    return (
        {
            "field_key": {
                "type": "string",
                "enum": [f["key"] for f in fields],
                "description": f"Which answer this is. One of: {described}",
            },
            "said": {
                "type": "string",
                "description": ("Exactly what the caller said, in their own words. "
                                "Do not tidy it up."),
            },
            "confirmed": {
                "type": "boolean",
                "description": ("True only after you read the value back to the caller "
                                "and they agreed."),
            },
        },
        ["field_key", "said"],
    )


@tool(
    name="save_answer",
    description=(
        "Save an answer the caller has just given to one of the questions this call is "
        "for. Call it once per answer, with what they actually said. If the reply says "
        "it was not saved, do what it tells you and try again."
    ),
    schema_for=_capture_schema,
)
async def save_answer(args: dict, call: CallContext) -> dict:
    """The Studio decides what the words mean and whether they can be saved: it owns the
    field definitions, and a date or an amount is too easy to get wrong to leave to the
    model. Everything about who the answer belongs to is worked out there too, from the
    call itself, so nothing here can point it at another organization's contact."""
    key = str(args.get("field_key") or "")
    fields = {f["key"]: f for f in (getattr(call, "capture_fields", None) or [])}
    if key not in fields:
        return {"saved": False,
                "what_to_do": "That is not one of this call's questions. Carry on."}
    if call.save_answer is None:
        return {"saved": False,
                "what_to_do": "There is nowhere to save answers on this call. Carry on."}

    turn = call.turn_number() if callable(call.turn_number) else 0
    reply = await call.save_answer(
        field_key=key,
        said=str(args.get("said") or ""),
        turn=turn,
        confirmed=bool(args.get("confirmed")),
    )
    if reply.get("ok"):
        return {"saved": True, "value": reply.get("value")}
    out = {"saved": False, "what_to_do": reply.get("message") or "Please ask again."}
    if reply.get("value"):
        out["value_heard"] = reply["value"]
    return out


# --- the caller's own task list ----------------------------------------------
#
# The Studio owns the list: it decides whose tasks these are from the call itself, reads
# the dates the caller said, and refuses a task id that is not theirs. These four only
# carry the question over and turn the answer into something the agent can say.

_NO_LIST = {"what_to_do": "I cannot reach the task list on this call. Carry on."}
_RANGES = ["today", "yesterday", "this_week", "overdue", "all"]


async def _ask_studio(call: CallContext, name: str, **args) -> dict | None:
    if call.run_tool is None:
        return None
    turn = call.turn_number() if callable(call.turn_number) else 0
    return await call.run_tool(name, turn=turn, **args)


@tool(
    name="get_tasks",
    description=(
        "Read the person's own task list. Use it before saying anything about what they "
        "have to do, and never answer from memory."
    ),
    properties={
        "range": {"type": "string", "enum": _RANGES,
                  "description": "Which days to look at. Leave out for all of them."},
        "status": {"type": "string", "enum": ["pending", "done", "all"],
                   "description": "Still to do, finished, or both. Defaults to still to do."},
    },
)
async def get_tasks(args: dict, call: CallContext) -> dict:
    reply = await _ask_studio(
        call, "get_tasks",
        range=args.get("range") or "all",
        status=args.get("status") or "pending",
    )
    if reply is None:
        return dict(_NO_LIST)
    if not reply.get("ok"):
        return {"what_to_do": reply.get("message") or "I could not read the list just now."}
    return {"tasks": reply.get("tasks") or [], "count": reply.get("count", 0)}


@tool(
    name="add_task",
    description="Add a task to the person's list, but only when they ask you to.",
    properties={
        "title": {"type": "string", "description": "The task, in the caller's own words."},
        "due": {"type": "string",
                "description": "When it is due, as they said it: \"next Friday\", \"the 15th\"."},
    },
    required=["title"],
)
async def add_task(args: dict, call: CallContext) -> dict:
    reply = await _ask_studio(call, "add_task", title=str(args.get("title") or ""),
                              due=str(args.get("due") or ""))
    if reply is None:
        return dict(_NO_LIST)
    if not reply.get("ok"):
        return {"added": False, "what_to_do": reply.get("message") or "I could not add it."}
    return {"added": True, "task_id": reply.get("task_id"), "due": reply.get("due")}


@tool(
    name="reschedule_task",
    description=(
        "Move one of the person's tasks to a new date, when they ask. Read the list first "
        "so you have the right task."
    ),
    properties={
        "task_id": {"type": "string", "description": "The id from the task list."},
        "due": {"type": "string", "description": "The new date, as they said it."},
    },
    required=["task_id", "due"],
)
async def reschedule_task(args: dict, call: CallContext) -> dict:
    reply = await _ask_studio(call, "reschedule_task", task_id=str(args.get("task_id") or ""),
                              due=str(args.get("due") or ""))
    if reply is None:
        return dict(_NO_LIST)
    if not reply.get("ok"):
        return {"moved": False, "what_to_do": reply.get("message") or "I could not move it."}
    return {"moved": True, "due": reply.get("due")}


@tool(
    name="mark_task_done",
    description="Tick a task off the person's list when they say it is finished.",
    properties={"task_id": {"type": "string", "description": "The id from the task list."}},
    required=["task_id"],
)
async def mark_task_done(args: dict, call: CallContext) -> dict:
    reply = await _ask_studio(call, "mark_task_done", task_id=str(args.get("task_id") or ""))
    if reply is None:
        return dict(_NO_LIST)
    if not reply.get("ok"):
        return {"done": False, "what_to_do": reply.get("message") or "I could not tick it off."}
    return {"done": True, "title": reply.get("title")}
