"""Kaho AI Studio: the web app a business uses to run its calling agents.

Dashboard, Calls (with the live transcript), Contacts, Agents, Prompts and
Numbers, behind a sign-in. It runs as its own small server bound to 127.0.0.1,
apart from the phone server, because the phone server is exposed to the
internet through ngrok. It also refuses any request that looks forwarded (a
tunnel or proxy), names another host (DNS rebinding), or comes from another
website's page in your browser (cross-site). Every /api/ route except signing in
needs a session (auth_store.py).

Run: python apps/voice/admin.py, then open http://127.0.0.1:8001
"""

import asyncio
import importlib.util
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

import agents_store
import analytics
import call_history
import call_outcomes
import uvicorn
from activity import default_log as activity_log
from auth_store import AuthError
from auth_store import default_store as auth_store
from contacts_store import default_store as contact_store
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from numbers_store import PROVIDERS, plivo_credentials
from numbers_store import default_store as number_store
from prompt_store import MAX_PROMPT_CHARS, normalize_number, our_number

HERE = Path(__file__).resolve().parent
PAGE = HERE / "admin_page.html"
HOST = "127.0.0.1"
PORT = int(os.getenv("ADMIN_PORT") or 8001)
LOCAL_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
SESSION_COOKIE = "kaho_session"
OPEN_PATHS = {"/api/auth/state", "/api/auth/login", "/api/auth/signup", "/api/auth/logout"}

# The terminal dialler, loaded whole: calls placed from this page go through the
# same checks and the same single, never-retried request as scripts/call.py.
_spec = importlib.util.spec_from_file_location(
    "kaho_dialler", HERE.parent.parent / "scripts" / "call.py"
)
dialler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dialler)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def this_machine_and_signed_in(request: Request, call_next):
    origin = request.headers.get("origin")
    if (
        request.headers.get("host") not in LOCAL_HOSTS
        or request.headers.get("x-forwarded-for")
        or request.headers.get("forwarded")
        or (origin and origin not in {f"http://{h}" for h in LOCAL_HOSTS})
    ):
        return JSONResponse({"error": "this page only answers to this machine"}, status_code=403)
    path = request.url.path
    if path.startswith("/api/") and path not in OPEN_PATHS:
        user = auth_store().user_for(request.cookies.get(SESSION_COOKIE))
        if user is None:
            return JSONResponse({"error": "sign in first"}, status_code=401)
        request.state.user = user
    return await call_next(request)


def not_owner(request: Request) -> JSONResponse | None:
    """403 unless the signed-in user owns the workspace. Members do the daily
    work (calls, contacts, agents, prompts); the owner alone changes phone
    numbers and their credentials, deletes agents and prompts, deletes in bulk
    and syncs from Plivo."""
    if (getattr(request.state, "user", None) or {}).get("role") != "owner":
        return JSONResponse({"error": "only the workspace owner can do this"}, status_code=403)
    return None


def bad_request(message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=400)


def _missing(what: str = "contact") -> JSONResponse:
    return JSONResponse({"error": f"no such {what}"}, status_code=404)


def note(request: Request, kind: str, text: str, view: str, ref: str | None = None) -> None:
    """A notification for everyone in the workspace. Never fails the change itself."""
    user = getattr(request.state, "user", None) or {}
    try:
        activity_log().add(kind, text, view=view, ref=ref, actor=user.get("name"))
    except OSError:
        pass


async def body_of(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


@app.get("/", response_class=HTMLResponse)
async def page() -> Response:
    return HTMLResponse(PAGE.read_text(encoding="utf-8"), headers={
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
        "frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
        "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"})


# --- accounts -------------------------------------------------------------------


def _signed_in(user: dict) -> JSONResponse:
    token = auth_store().start_session(user["id"])
    r = JSONResponse(user)
    r.set_cookie(SESSION_COOKIE, token, max_age=7 * 24 * 3600, httponly=True,
                 samesite="strict", path="/")
    return r


@app.get("/api/auth/state")
async def auth_state() -> dict:
    return {"has_accounts": auth_store().has_accounts()}


@app.post("/api/auth/signup")
def sign_up(body: dict):
    try:
        user = auth_store().sign_up(body.get("name"), body.get("email"), body.get("password"),
                                    body.get("company") or "", invite=body.get("invite"))
    except AuthError as e:
        return JSONResponse({"error": str(e)}, status_code=403)
    except ValueError as e:
        return bad_request(str(e))
    activity_log().add("account", f"{user['name']} joined the workspace", view="dashboard",
                       actor=user["name"])
    return _signed_in(user)


@app.post("/api/auth/login")
def sign_in(body: dict):
    try:
        user = auth_store().check_password(body.get("email"), body.get("password"))
    except AuthError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    return _signed_in(user)


@app.post("/api/auth/logout")
async def sign_out(request: Request):
    auth_store().end_session(request.cookies.get(SESSION_COOKIE))
    r = JSONResponse({"signed_out": True})
    r.delete_cookie(SESSION_COOKIE, path="/")
    return r


@app.get("/api/me")
async def me(request: Request) -> dict:
    user = request.state.user
    agents = agents_store.default_store()
    try:
        agent_count, prompt_count = len(agents.list_agents()), len(agents.list_prompts())
    except ValueError:
        agent_count = prompt_count = 0
    calls = _calls()
    out = {**user, "counts": {
        "numbers": len(number_store().list_public()), "agents": agent_count,
        "prompts": prompt_count, "contacts": len(contact_store().list()),
        "calls": len(calls), "members": len(auth_store().members())},
        "members": [{"name": m["name"], "email": m["email"], "role": m["role"]}
                    for m in auth_store().members()]}
    if user["role"] == "owner":
        out["invite_code"] = auth_store().invite_code()
    return out


def _ceiling_minutes() -> int:
    """The longest call worth offering: the phone server cuts every call at its
    own MAX_CALL_DURATION_SECS, whatever an agent asks for."""
    try:
        return max(1, min(agents_store.MAX_MINUTES, int(dialler.resolve_max_duration(None) // 60)))
    except dialler.CallError:
        return agents_store.MAX_MINUTES


@app.get("/api/config")
async def config() -> dict:
    return {"our_number": our_number(), "max_chars": MAX_PROMPT_CHARS,
            "tools": TOOL_CATALOG, "limits": {"max_minutes": _ceiling_minutes(),
                                              "ring_secs": list(agents_store.RING_SECS)}}


# --- notifications ----------------------------------------------------------------


@app.get("/api/notifications")
async def notifications(request: Request) -> dict:
    seen = auth_store().public(request.state.user["id"]).get("seen_at")
    log = activity_log()
    return {"items": log.recent(30), "unread": log.unread(since=seen)}


@app.post("/api/notifications/seen")
async def notifications_seen(request: Request) -> dict:
    items = activity_log().recent(1)
    if items:
        auth_store().mark_seen(request.state.user["id"], items[0]["at"])
    return {"unread": 0}


# --- agents and prompts ------------------------------------------------------------

TOOL_CATALOG = [
    {"name": "end_call", "label": "End the call",
     "description": "Hangs up once the person says goodbye, or says no to “anything else?”.",
     "needs": None},
    {"name": "capture_lead", "label": "Save details",
     "description": "Saves the person's name, number and what they need, for a follow-up.",
     "needs": None},
    {"name": "transfer_to_human", "label": "Transfer to a person",
     "description": "Hands the call to your team's number when the person asks for a human.",
     "needs": "TRANSFER_NUMBER"},
    {"name": "call_webhook", "label": "Your system (webhook)",
     "description": "Looks something up or saves it in your own system, through a webhook.",
     "needs": "TOOL_WEBHOOK_URL"},
]


def _agents():
    return agents_store.default_store()


def _agent_names() -> dict:
    try:
        return {a["id"]: a["name"] for a in _agents().list_agents()}
    except ValueError:
        return {}


@app.get("/api/tools")
async def tool_catalog() -> list:
    return [{**t, "ready": not t["needs"] or bool(os.getenv(t["needs"]))} for t in TOOL_CATALOG]


@app.get("/api/agents")
async def list_agents():
    try:
        agents = _agents().list_agents()
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    counts: dict[str, int] = {}
    for c in _calls():
        if c.get("agent_id"):
            counts[c["agent_id"]] = counts.get(c["agent_id"], 0) + 1
    return [{**a, "call_count": counts.get(a["id"], 0)} for a in agents]


@app.post("/api/agents")
async def create_agent(request: Request):
    body = await body_of(request)
    try:
        agent = _agents().create_agent(body.get("name"), body.get("description") or "",
                                       body.get("prompt"))
    except ValueError as e:
        return bad_request(str(e))
    note(request, "agent", f"Created the agent {agent['name']}", "agents", agent["id"])
    return agent


@app.get("/api/agents/{agent_id}")
async def get_agent(agent_id: str):
    try:
        return _agents().get_agent(agent_id)
    except KeyError:
        return _missing("agent")


@app.patch("/api/agents/{agent_id}")
async def edit_agent(agent_id: str, request: Request):
    body = await body_of(request)
    settings = body.get("settings")
    if isinstance(settings, dict) and "max_minutes" in settings:
        try:
            too_long = int(settings["max_minutes"]) > _ceiling_minutes()
        except (TypeError, ValueError):
            too_long = False  # the store explains a bad number
        if too_long:
            return bad_request(f"Longest call can be at most {_ceiling_minutes()} minutes "
                               "on this server (MAX_CALL_DURATION_SECS)")
    try:
        agent = _agents().update_agent(
            agent_id, name=body.get("name"), description=body.get("description"),
            tools=body.get("tools"), settings=body.get("settings"),
            active_prompt_id=body.get("active_prompt_id"))
    except KeyError:
        return _missing("agent")
    except ValueError as e:
        return bad_request(str(e))
    what = ("tools" if "tools" in body else "call settings" if "settings" in body
            else "prompt in use" if "active_prompt_id" in body else "details")
    note(request, "agent", f"Changed the {what} of {agent['name']}", "agents", agent_id)
    return agent


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str, request: Request):
    if denied := not_owner(request):
        return denied
    try:
        name = _agents().get_agent(agent_id)["name"]
        _agents().delete_agent(agent_id)
    except KeyError:
        return _missing("agent")
    note(request, "agent", f"Deleted the agent {name}; its prompts are kept", "prompts")
    return {"deleted": agent_id}


def _prompt_ref(prompt: dict) -> tuple[str, str]:
    """Where a notification about this prompt should take you."""
    if prompt.get("agent_id"):
        return "agents", f"{prompt['agent_id']}/{prompt['id']}"
    return "prompts", prompt["id"]


@app.get("/api/prompts")
async def list_prompts():
    try:
        return _agents().list_prompts()
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)


@app.post("/api/prompts")
async def create_prompt(request: Request):
    body = await body_of(request)
    try:
        prompt = _agents().create_prompt(body.get("name"), body.get("prompt"),
                                         body.get("agent_id") or None)
    except KeyError:
        return _missing("agent")
    except ValueError as e:
        return bad_request(str(e))
    note(request, "prompt", f"Created the prompt {prompt['name']}", *_prompt_ref(prompt))
    return prompt


@app.get("/api/prompts/{prompt_id}")
async def get_prompt(prompt_id: str):
    try:
        return _agents().get_prompt(prompt_id)
    except KeyError:
        return _missing("prompt")


@app.patch("/api/prompts/{prompt_id}")
async def edit_prompt(prompt_id: str, request: Request):
    body = await body_of(request)
    try:
        before = _agents().get_prompt(prompt_id)
        prompt = _agents().update_prompt(prompt_id, name=body.get("name"), text=body.get("text"))
    except KeyError:
        return _missing("prompt")
    except ValueError as e:
        return bad_request(str(e))
    if prompt["version_count"] != before["version_count"]:
        note(request, "prompt", f"Saved a new version of {prompt['name']}", *_prompt_ref(prompt))
    elif prompt["name"] != before["name"]:
        note(request, "prompt", f"Renamed the prompt {before['name']} to {prompt['name']}",
             *_prompt_ref(prompt))
    return prompt


@app.post("/api/prompts/{prompt_id}/assign")
async def assign_prompt(prompt_id: str, request: Request):
    body = await body_of(request)
    try:
        prompt = _agents().assign_prompt(prompt_id, body.get("agent_id") or None)
    except KeyError:
        return _missing("prompt or agent")
    to = prompt["agent_name"] or "no agent"
    note(request, "prompt", f"Moved the prompt {prompt['name']} to {to}", *_prompt_ref(prompt))
    return prompt


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str, request: Request):
    if denied := not_owner(request):
        return denied
    try:
        name = _agents().get_prompt(prompt_id)["name"]
        _agents().delete_prompt(prompt_id)
    except KeyError:
        return _missing("prompt")
    note(request, "prompt", f"Deleted the prompt {name}", "prompts")
    return {"deleted": prompt_id}


@app.get("/api/prompts/{prompt_id}/versions")
async def prompt_versions(prompt_id: str):
    try:
        return _agents().versions(prompt_id)
    except KeyError:
        return _missing("prompt")


@app.post("/api/prompts/{prompt_id}/versions/{version_id}/restore")
async def restore_prompt_version(prompt_id: str, version_id: str, request: Request):
    try:
        prompt = _agents().restore_version(prompt_id, version_id)
    except KeyError:
        return _missing("version")
    note(request, "prompt", f"Restored an earlier version of {prompt['name']}",
         *_prompt_ref(prompt))
    return prompt


@app.delete("/api/prompts/{prompt_id}/versions/{version_id}")
async def delete_prompt_version(prompt_id: str, version_id: str):
    try:
        _agents().delete_version(prompt_id, version_id)
    except KeyError:
        return _missing("version")
    except ValueError as e:
        return bad_request(str(e))
    return {"deleted": version_id}


# --- our numbers ----------------------------------------------------------------


@app.get("/api/providers")
async def providers() -> list:
    return [{"id": pid, "label": p["label"], "connected": p["connected"],
             "fields": [{"name": f, "label": lbl, "secret": sec} for f, lbl, sec in p["fields"]]}
            for pid, p in PROVIDERS.items()]


def _routes() -> dict:
    try:
        return _agents().routes()
    except ValueError:
        return {}


@app.get("/api/numbers")
async def list_numbers() -> list:
    routes = _routes()
    return [{**r, "agent_id": routes.get(r["number"])} for r in number_store().list_public()]


def _public(number_id: str) -> dict:
    row = next(r for r in number_store().list_public() if r["id"] == number_id)
    return {**row, "agent_id": _routes().get(row["number"])}


@app.post("/api/numbers")
async def add_number(request: Request):
    if denied := not_owner(request):
        return denied
    body = await body_of(request)
    try:
        row = number_store().add(str(body.get("provider") or ""), str(body.get("number") or ""),
                                 str(body.get("label") or ""), body.get("credentials") or {})
    except ValueError as e:
        return bad_request(str(e))
    note(request, "number", f"Added the number {row['number']}", "numbers", row["id"])
    return _public(row["id"])


@app.patch("/api/numbers/{number_id}")
async def edit_number(number_id: str, request: Request):
    if denied := not_owner(request):
        return denied
    body = await body_of(request)
    try:
        number_store().update(number_id, label=body.get("label"),
                              credentials=body.get("credentials"))
    except KeyError:
        return _missing("number")
    row = _public(number_id)
    changed = "credentials" if any((body.get("credentials") or {}).values()) else "name"
    note(request, "number", f"Changed the {changed} of {row['number']}", "numbers", number_id)
    return row


@app.post("/api/numbers/{number_id}/agent")
async def route_number(number_id: str, request: Request):
    if denied := not_owner(request):
        return denied
    body = await body_of(request)
    try:
        row = _public(number_id)
        _agents().route_number(row["number"], body.get("agent_id") or None)
    except StopIteration:
        return _missing("number")
    except KeyError:
        return _missing("agent")
    except ValueError as e:
        return bad_request(str(e))
    row = _public(number_id)
    name = _agent_names().get(row["agent_id"]) or "the default persona"
    note(request, "number", f"{row['number']} now answers with {name}", "numbers", number_id)
    return row


@app.post("/api/numbers/{number_id}/default")
async def make_default(number_id: str, request: Request):
    if denied := not_owner(request):
        return denied
    try:
        number_store().set_default(number_id)
    except KeyError:
        return _missing("number")
    row = _public(number_id)
    note(request, "number", f"{row['number']} is now the default number", "numbers", number_id)
    return row


@app.delete("/api/numbers/{number_id}")
async def delete_number(number_id: str, request: Request):
    if denied := not_owner(request):
        return denied
    try:
        number = _public(number_id)["number"]
        number_store().delete(number_id)
    except (KeyError, StopIteration):
        return _missing("number")
    try:
        _agents().route_number(number, None)
    except ValueError:
        pass
    note(request, "number", f"Removed the number {number}", "numbers")
    return {"deleted": number_id}


# --- placing calls ------------------------------------------------------------


@app.post("/api/calls")
def place_call(request: Request, body: dict):
    """Dial `to` from one of our numbers, once. Sync, so FastAPI runs it off the loop."""
    if body.get("consent") is not True:
        return bad_request("confirm that this person has agreed to be called")
    store = number_store()
    rows = store.list_public()
    from_id = body.get("from_id")
    row = next((r for r in rows if r["id"] == from_id), None) if from_id else next(
        (r for r in rows if r["is_default"]), None)
    if row is None:
        return bad_request("choose a number to call from")
    if row["status"] == "not_connected":
        return bad_request(f"{row['provider_label']} numbers are not connected yet; "
                           "only Plivo can place calls today")
    if row["status"] != "active":
        return bad_request(f"{row['number']} is missing credentials; edit it on Numbers")
    try:
        to = dialler.check_number(normalize_number(str(body.get("to") or "")), "The number")
    except (ValueError, dialler.CallError) as e:
        return bad_request(str(e))
    if contact_store().is_dnc(to):
        return bad_request(f"{to} is marked Do not call in Contacts")
    agent = None
    if body.get("agent_id"):
        agent = _agents().call_config(body.get("agent_id"))
        if agent is None:
            return bad_request("choose an agent that exists")
    missing = [k for k in ("PUBLIC_HOST", "WEBHOOK_SECRET") if not os.getenv(k)]
    if missing:
        return bad_request(f"missing in .env: {', '.join(missing)}")
    creds = store.credentials(row["id"])
    cfg = {"PLIVO_AUTH_ID": creds["auth_id"], "PLIVO_AUTH_TOKEN": creds["auth_token"],
           "PLIVO_FROM_NUMBER": row["number"], "PUBLIC_HOST": os.environ["PUBLIC_HOST"].strip(),
           "WEBHOOK_SECRET": os.environ["WEBHOOK_SECRET"].strip()}
    try:
        max_secs = dialler.resolve_max_duration(agent["max_secs"] if agent else None)
        answer_url = dialler.build_answer_url(cfg, "default", to, max_secs)
        if agent:
            answer_url += f"&studio_agent={quote(agent['agent_id'])}"
        hangup_url = dialler.build_hangup_url(cfg, to, agent["agent_id"] if agent else None)
        ring = agent["ring_secs"] if agent else dialler.DEFAULT_RING_TIMEOUT_SECS
        dialler.preflight(answer_url, cfg)
        result = dialler.dial(cfg, to, answer_url, max_secs, ring, hangup_url=hangup_url)
    except dialler.CallError as e:
        # Never retried here either: after a failure the outcome can be unknown.
        return JSONResponse({"error": str(e)}, status_code=502)
    request_uuid = result.get("request_uuid")
    if isinstance(request_uuid, str) and call_outcomes.CALL_ID.match(request_uuid):
        call_outcomes.default_log().record(
            request_uuid, status="ringing", peer=to, ours=row["number"], direction="outbound",
            agent_id=agent["agent_id"] if agent else None, at=_now_iso(),
            request_uuid=request_uuid)
    who = _name_for(to)
    note(request, "call", f"Called {who}" + (f" with {agent['name']}" if agent else ""),
         "calls", request_uuid)
    return {"to": to, "from": row["number"], "request_uuid": request_uuid,
            "agent_name": agent["name"] if agent else None}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _name_for(number: str) -> str:
    for c in contact_store().list():
        if any(n["number"] == number for n in c["numbers"]):
            return c["name"]
    return number


# --- calls, the dashboard -------------------------------------------------------


def call_index() -> dict:
    """Older calls' other party, from Plivo's records (scripts/backfill_call_index.py)."""
    path = Path(os.getenv("CALL_INDEX_PATH") or HERE.parent.parent / "data" / "call_index.json")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _calls() -> list:
    return analytics.all_calls(calls_dir(), call_outcomes.default_log().all(), call_index())


def _named(call: dict, names: dict, people: dict) -> dict:
    return {**call, "agent_name": names.get(call.get("agent_id")),
            "contact_name": people.get(call.get("peer"))}


def _people() -> dict:
    return {n["number"]: c["name"] for c in contact_store().list() for n in c["numbers"]}


@app.get("/api/dashboard")
async def dashboard(days: int = 30):
    if not 1 <= days <= 365:
        return bad_request("days must be between 1 and 365")
    names, people = _agent_names(), _people()
    d = analytics.dashboard(_calls(), days=days, agent_names=names)
    d["recent"] = [_named(c, names, people) for c in d["recent"]]
    return d


@app.post("/api/dashboard/sync")
def sync_dashboard(request: Request):
    """Read how recent calls ended from Plivo's call records (read-only there)."""
    if denied := not_owner(request):
        return denied
    auth_id, auth_token = plivo_credentials()
    if not auth_id or not auth_token:
        return bad_request("Plivo is not connected; add its credentials on Numbers")
    try:
        ours = normalize_number(os.getenv("PLIVO_FROM_NUMBER") or "")
    except ValueError:
        ours = None
    try:
        n = call_outcomes.sync_from_plivo(call_outcomes.default_log(), auth_id, auth_token, ours)
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    return {"synced": n}


@app.get("/api/calls")
async def list_calls(page: int = 1, per_page: int = 10):
    """Every call, newest first, a page at a time."""
    if per_page not in call_history.PAGE_SIZES:
        return bad_request("per_page must be one of 10, 20, 25, 50")
    names, people = _agent_names(), _people()
    calls = _calls()
    start = (max(1, page) - 1) * per_page
    return {"total": len(calls), "page": max(1, page), "per_page": per_page,
            "calls": [_named(c, names, people) for c in calls[start:start + per_page]]}


# --- contacts and tags --------------------------------------------------------


@app.get("/api/contacts")
async def list_contacts() -> list:
    calls = _calls()
    last = analytics.last_calls(calls)
    counts: dict[str, int] = {}
    for c in calls:
        if c.get("peer"):
            counts[c["peer"]] = counts.get(c["peer"], 0) + 1
    out = []
    for contact in contact_store().list():
        numbers = [n["number"] for n in contact["numbers"]]
        mine = [last[n] for n in numbers if n in last]
        newest = max(mine, key=lambda c: c.get("started_at") or "", default=None)
        out.append({**contact, "dnc": bool(contact.get("dnc")),
                    "call_count": sum(counts.get(n, 0) for n in numbers),
                    "last_call": {k: newest.get(k) for k in (
                        "call_id", "started_at", "status", "duration_secs", "summary",
                        "successful")} if newest else None})
    return out


@app.post("/api/contacts")
async def create_contact(request: Request):
    body = await body_of(request)
    try:
        contact = contact_store().create(str(body.get("name") or ""),
                                         list(body.get("numbers") or []))
        if body.get("tags"):
            contact = contact_store().set_contact_tags(contact["id"], list(body["tags"]))
    except ValueError as e:
        return bad_request(str(e))
    note(request, "contact", f"Added the contact {contact['name']}", "contacts", contact["id"])
    return contact


@app.patch("/api/contacts/{contact_id}")
async def edit_contact(contact_id: str, request: Request):
    body = await body_of(request)
    store = contact_store()
    try:
        before = store.get(contact_id)
        contact = before
        if "name" in body:
            contact = store.rename(contact_id, str(body.get("name") or ""))
        if "tags" in body:
            contact = store.set_contact_tags(contact_id, list(body.get("tags") or []))
        if "dnc" in body:
            contact = store.set_dnc(contact_id, body.get("dnc") is True)
    except KeyError:
        return _missing()
    except ValueError as e:
        return bad_request(str(e))
    if "name" in body and contact["name"] != before["name"]:
        note(request, "contact", f"Renamed {before['name']} to {contact['name']}", "contacts",
             contact_id)
    if "dnc" in body:
        note(request, "contact", f"{contact['name']} is "
             + ("now Do not call" if contact["dnc"] else "callable again"), "contacts", contact_id)
    if "tags" in body and set(contact["tags"]) != set(before.get("tags") or []):
        note(request, "contact", f"Changed the tags on {contact['name']}", "contacts", contact_id)
    return contact


@app.delete("/api/contacts/{contact_id}")
async def delete_contact(contact_id: str, request: Request):
    try:
        name = contact_store().get(contact_id)["name"]
        contact_store().delete(contact_id)
    except KeyError:
        return _missing()
    note(request, "contact", f"Deleted the contact {name}", "contacts")
    return {"deleted": contact_id}


@app.post("/api/contacts/delete")
async def delete_contacts(request: Request):
    if denied := not_owner(request):
        return denied
    body = await body_of(request)
    n = contact_store().delete_many([str(i) for i in body.get("ids") or []])
    if n:
        note(request, "contact", f"Deleted {n} contact{'s' if n != 1 else ''}", "contacts")
    return {"deleted": n}


@app.post("/api/contacts/{contact_id}/numbers")
async def add_contact_number(contact_id: str, request: Request):
    body = await body_of(request)
    try:
        return contact_store().add_number(contact_id, str(body.get("number") or ""),
                                          list(body.get("tags") or []))
    except KeyError:
        return _missing()
    except ValueError as e:
        return bad_request(str(e))


@app.patch("/api/contacts/{contact_id}/numbers/{number_id}")
async def edit_contact_number(contact_id: str, number_id: str, request: Request):
    body = await body_of(request)
    try:
        entry = contact_store().update_number(contact_id, number_id, number=body.get("number"),
                                              tags=body.get("tags"))
    except KeyError:
        return _missing("number")
    except ValueError as e:
        return bad_request(str(e))
    if body.get("number"):
        name = contact_store().get(contact_id)["name"]
        note(request, "contact", f"Changed a number of {name}", "contacts", contact_id)
    return entry


@app.delete("/api/contacts/{contact_id}/numbers/{number_id}")
async def delete_contact_number(contact_id: str, number_id: str):
    try:
        contact_store().delete_number(contact_id, number_id)
    except KeyError:
        return _missing("number")
    return {"deleted": number_id}


@app.get("/api/contacts/{contact_id}/calls")
async def contact_calls(contact_id: str, page: int = 1, per_page: int = 10):
    try:
        contact = contact_store().get(contact_id)
        numbers = [n["number"] for n in contact["numbers"]]
        names = _agent_names()
        calls = [{**c, "agent_name": names.get(c.get("agent_id"))} for c in _calls()]
        return analytics.calls_for(numbers, calls, page, per_page)
    except KeyError:
        return _missing()
    except ValueError as e:
        return bad_request(str(e))


def _transcript_path(call_id: str) -> Path | None:
    path = calls_dir() / f"{call_id}.jsonl"
    return path if CALL_ID.match(call_id) and path.exists() else None


@app.get("/api/calls/{call_id}/transcript")
async def call_transcript(call_id: str):
    path = _transcript_path(call_id)
    return call_history.turns(path) if path else _missing("call")


@app.get("/api/calls/{call_id}/transcript.csv")
async def call_transcript_csv(call_id: str):
    path = _transcript_path(call_id)
    if not path:
        return _missing("call")
    return Response(call_history.transcript_csv(path), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="call-{call_id}.csv"'})


@app.get("/api/tags")
async def list_tags() -> list:
    return contact_store().tags()


@app.post("/api/tags")
async def create_tag(request: Request):
    body = await body_of(request)
    try:
        tag = contact_store().create_tag(str(body.get("name") or ""),
                                         str(body.get("color") or "marigold"))
    except ValueError as e:
        return bad_request(str(e))
    note(request, "tag", f"Created the tag {tag['name']}", "contacts")
    return tag


@app.patch("/api/tags/{tag_id}")
async def edit_tag(tag_id: str, request: Request):
    body = await body_of(request)
    try:
        return contact_store().update_tag(tag_id, name=body.get("name"), color=body.get("color"))
    except KeyError:
        return _missing("tag")
    except ValueError as e:
        return bad_request(str(e))


@app.delete("/api/tags/{tag_id}")
async def delete_tag(tag_id: str, request: Request):
    try:
        name = next(t["name"] for t in contact_store().tags() if t["id"] == tag_id)
        contact_store().delete_tag(tag_id)
    except (KeyError, StopIteration):
        return _missing("tag")
    note(request, "tag", f"Deleted the tag {name}", "contacts")
    return {"deleted": tag_id}


# --- live transcript ---------------------------------------------------------

CALL_ID = re.compile(r"^[A-Za-z0-9-]{6,64}$")
STREAM_POLL_SECS = 0.12
# Ringing can take most of a minute before the call (and its transcript) starts.
STREAM_WAIT_FOR_CALL_SECS = 90
SHOWN_EVENTS = {"call_start", "recording_notice_played", "live", "turn", "tool",
                "filler_spoken", "call_failed", "call_end"}


def calls_dir() -> Path:
    return Path(os.getenv("CALL_LOG_DIR") or HERE.parent.parent / "logs" / "calls")


def _shown(row: dict) -> dict | None:
    """The part of a transcript line the live view shows. Tool lines carry the
    caller's details in their arguments, so only the tool's name goes out."""
    event = row.get("event")
    if event not in SHOWN_EVENTS:
        return None
    if event == "tool":
        return {"event": "tool", "name": row.get("name")}
    out = {"event": event}
    if event in ("live", "turn"):
        out["role"] = "agent" if row.get("role") in ("assistant", "agent") else "caller"
        out["text"] = row.get("text", "")
    return out


@app.get("/api/calls/{call_id}/stream")
async def stream_call(call_id: str):
    """Server-sent events from one call's transcript, as they are written.

    The transcript is already masked on disk; this reads it, never the audio."""
    if not CALL_ID.match(call_id):
        return bad_request("not a call id")
    path = calls_dir() / f"{call_id}.jsonl"

    async def events():
        waited = 0.0
        while not path.exists():
            if waited >= STREAM_WAIT_FOR_CALL_SECS:
                yield f"data: {json.dumps({'event': 'no_answer'})}\n\n"
                return
            yield ": waiting\n\n"
            await asyncio.sleep(1.0)
            waited += 1.0
        position, buffer = 0, ""
        while True:
            with path.open(encoding="utf-8") as f:
                f.seek(position)
                chunk = f.read()
                position = f.tell()
            buffer += chunk
            *complete, buffer = buffer.split("\n")
            for line in complete:
                try:
                    shown = _shown(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if shown:
                    yield f"data: {json.dumps(shown, ensure_ascii=False)}\n\n"
                    if shown["event"] == "call_end":
                        return
            await asyncio.sleep(STREAM_POLL_SECS)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def main() -> None:
    load_dotenv(HERE.parent.parent / ".env")
    print(f"Kaho AI Studio: http://{HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
