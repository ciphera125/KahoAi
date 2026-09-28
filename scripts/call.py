"""Dial out through Plivo and connect the call to the same voice pipeline as inbound.

    python scripts/call.py --number +91XXXXXXXXXX --agent sales

This script only *places* the call. The agent itself runs in the server
(`apps/voice/server.py`), exactly as for an inbound call: when the person
answers, Plivo fetches our answer URL, and the reply connects the call to
`/ws`, which builds the same pipeline through `build_worker()`. So the server
must be running and reachable at PUBLIC_HOST first; the script checks that
before it dials, because dialling a person and then not being there to answer
is the worst way to find out.

Safety, in the order it matters:
- Nothing is dialled without a confirmation (or --yes), since a typo rings a
  stranger and costs money.
- It never retries. Placing a call is not idempotent, so after a timeout the
  outcome is unknown and a retry could ring the same person twice. It says so
  and leaves the decision to you.
- Every call has a hard maximum duration, enforced by the server whatever the
  pipeline is doing. --max-duration can only lower the server's own ceiling
  (MAX_CALL_DURATION_SECS). Plivo is also given a time limit as a backstop.
- Every network call has an explicit timeout.

Exit codes: 0 call placed, 2 bad input or configuration, 3 the server is not
ready (nothing dialled), 4 the dial failed or its outcome is unknown.
"""

import argparse
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "apps" / "voice"))

import personas  # noqa: E402

E164 = re.compile(r"^\+[1-9]\d{7,14}$")
PLIVO_CALL_URL = "https://api.plivo.com/v1/Account/{auth_id}/Call/"

# (connect, read). Connecting fast or not at all keeps a bad network from stalling
# the terminal; the read side is longer because Plivo does real work before it answers.
DIAL_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
PREFLIGHT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

DEFAULT_MAX_SECS = 600.0
FLOOR_SECS = 10.0
# Plivo's own limit is only a backstop, so ours fires first and leaves a log.
PLIVO_LIMIT_GRACE_SECS = 15
DEFAULT_RING_TIMEOUT_SECS = 45


class CallError(Exception):
    """Something stopped the call. `code` is the process exit code."""

    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def check_number(raw: str, label: str) -> str:
    number = re.sub(r"[ \-()]", "", raw or "")
    if not E164.match(number):
        raise CallError(
            f"{label} {raw!r} is not an international number. Use E.164, for example "
            "+919876543210 (a + and the country code, no spaces).",
            2,
        )
    return number


def settings() -> dict:
    """Everything the dialler needs from the environment, or a clear list of what is missing."""
    keys = (
        "PLIVO_AUTH_ID",
        "PLIVO_AUTH_TOKEN",
        "PLIVO_FROM_NUMBER",
        "PUBLIC_HOST",
        "WEBHOOK_SECRET",
    )
    missing = [k for k in keys if not os.getenv(k)]
    if missing:
        raise CallError(
            f"Missing in .env: {', '.join(missing)}. See .env.example (Telephony section).", 2
        )
    return {k: os.environ[k].strip() for k in keys}


def resolve_max_duration(cli_value: float | None) -> float:
    """--max-duration, else MAX_CALL_DURATION_SECS, else the default; never below the floor."""
    raw = os.getenv("MAX_CALL_DURATION_SECS", "").strip()
    try:
        ceiling = float(raw) if raw else DEFAULT_MAX_SECS
    except ValueError:
        raise CallError(f"MAX_CALL_DURATION_SECS={raw!r} is not a number.", 2) from None
    value = ceiling if cli_value is None else cli_value
    if value < FLOOR_SECS:
        raise CallError(f"--max-duration must be at least {FLOOR_SECS:g} seconds.", 2)
    if value > ceiling:
        # The server would clamp it anyway; say so rather than let it look honoured.
        print(f"Note: capped to the server ceiling of {ceiling:g}s (MAX_CALL_DURATION_SECS).")
        value = ceiling
    return value


def build_answer_url(cfg: dict, agent: str, number: str, max_secs: float) -> str:
    """The URL Plivo fetches when the callee answers. The token is the server's shared secret."""
    return (
        f"https://{cfg['PUBLIC_HOST']}/answer?token={quote(cfg['WEBHOOK_SECRET'])}"
        f"&agent={quote(agent)}&peer={quote(number)}&max={max_secs:g}"
    )


def redact(url: str, cfg: dict) -> str:
    return url.replace(quote(cfg["WEBHOOK_SECRET"]), "***")


def _get(url: str) -> httpx.Response:
    return httpx.get(url, timeout=PREFLIGHT_TIMEOUT, follow_redirects=False)


def _post(url: str, **kwargs) -> httpx.Response:
    return httpx.post(url, timeout=DIAL_TIMEOUT, **kwargs)


def preflight(answer_url: str, cfg: dict) -> None:
    """Fetch the answer URL as Plivo will. If that works, an answered call will be handled."""
    shown = f"https://{cfg['PUBLIC_HOST']}"
    try:
        resp = _get(answer_url)
    except httpx.HTTPError as e:
        raise CallError(
            f"Cannot reach {shown} ({type(e).__name__}). Start the server "
            "(apps/voice/server.py) and your tunnel, and check PUBLIC_HOST. Nothing was dialled.",
            3,
        ) from e
    if resp.status_code == 403:
        raise CallError(
            "The server rejected the token: WEBHOOK_SECRET here does not match the one the "
            "server was started with. Restart the server after editing .env. Nothing was dialled.",
            3,
        )
    if resp.status_code == 400:
        raise CallError(f"The server refused the call: {resp.text.strip()[:200]}", 3)
    if resp.status_code != 200 or "<Stream" not in resp.text:
        raise CallError(
            f"The server answered {resp.status_code} and not the expected stream XML. "
            "Nothing was dialled.",
            3,
        )


def dial(cfg: dict, number: str, answer_url: str, max_secs: float, ring_timeout: int) -> dict:
    """Ask Plivo to place the call. Never retried; see the module docstring."""
    payload = {
        "from": cfg["PLIVO_FROM_NUMBER"],
        "to": number,
        "answer_url": answer_url,
        "answer_method": "POST",
        # Plivo's own ceiling, a backstop behind the server's.
        "time_limit": int(max_secs) + PLIVO_LIMIT_GRACE_SECS,
        "ring_timeout": ring_timeout,
    }
    url = PLIVO_CALL_URL.format(auth_id=cfg["PLIVO_AUTH_ID"])
    unknown = (
        "The call MAY OR MAY NOT have been placed. Check the Plivo console (Logs, Calls) "
        "before running this again, or you may ring the same person twice."
    )
    try:
        resp = _post(url, json=payload, auth=(cfg["PLIVO_AUTH_ID"], cfg["PLIVO_AUTH_TOKEN"]))
    except httpx.ConnectError as e:
        # Never reached Plivo, so nothing was sent.
        raise CallError(
            f"Could not connect to Plivo ({type(e).__name__}). Nothing was dialled.", 4
        ) from e
    except httpx.HTTPError as e:
        raise CallError(f"{type(e).__name__} talking to Plivo. {unknown}", 4) from e

    if resp.status_code in (200, 201, 202):
        try:
            return resp.json()
        except ValueError:
            return {}
    detail = resp.text.strip()[:200]
    if resp.status_code in (401, 403):
        raise CallError("Plivo rejected PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN. Nothing was dialled.", 4)
    if resp.status_code == 400:
        raise CallError(f"Plivo refused the request: {detail}. Nothing was dialled.", 4)
    if resp.status_code == 429:
        raise CallError(
            "Plivo is rate limiting this account. Nothing was dialled; wait and retry.", 4
        )
    raise CallError(f"Plivo answered HTTP {resp.status_code}: {detail}. {unknown}", 4)


def confirm(number: str, agent: str, max_secs: float, assume_yes: bool) -> None:
    print(f"About to call {number} as agent '{agent}', for at most {max_secs:g}s.")
    print("Only call people who have agreed to be called (India's TRAI/DND rules apply).")
    if assume_yes:
        return
    if not sys.stdin.isatty():
        raise CallError("Not a terminal: pass --yes to dial without asking.", 2)
    if input("Place this call? [y/N] ").strip().lower() not in ("y", "yes"):
        raise CallError("Cancelled. Nothing was dialled.", 2)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Dial out through Plivo and connect the call to the voice agent.",
        epilog="The server (apps/voice/server.py) and your tunnel must be running.",
    )
    p.add_argument("--number", required=True, help="who to call, in E.164: +91XXXXXXXXXX")
    p.add_argument("--agent", required=True, help=f"persona: {', '.join(personas.available())}")
    p.add_argument("--max-duration", type=float, help="seconds; can only lower the server ceiling")
    p.add_argument(
        "--ring-timeout",
        type=int,
        default=DEFAULT_RING_TIMEOUT_SECS,
        help="seconds to let it ring before giving up (default %(default)s)",
    )
    p.add_argument("--yes", action="store_true", help="dial without asking for confirmation")
    p.add_argument("--dry-run", action="store_true", help="show the call; send nothing")
    return p.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    number = check_number(args.number, "--number")
    try:
        personas.resolve(args.agent)
    except ValueError as e:
        raise CallError(str(e), 2) from e
    cfg = settings()
    cfg["PLIVO_FROM_NUMBER"] = check_number(cfg["PLIVO_FROM_NUMBER"], "PLIVO_FROM_NUMBER")
    if not 5 <= args.ring_timeout <= 120:
        raise CallError("--ring-timeout must be between 5 and 120 seconds.", 2)
    max_secs = resolve_max_duration(args.max_duration)
    answer_url = build_answer_url(cfg, args.agent, number, max_secs)

    if args.dry_run:
        print(f"[dry run] from {cfg['PLIVO_FROM_NUMBER']} to {number}, agent {args.agent}")
        print(f"[dry run] answer URL: {redact(answer_url, cfg)}")
        backstop = int(max_secs) + PLIVO_LIMIT_GRACE_SECS
        print(f"[dry run] max {max_secs:g}s (Plivo backstop {backstop}s)")
        print("[dry run] nothing was sent.")
        return 0

    confirm(number, args.agent, max_secs, args.yes)
    preflight(answer_url, cfg)
    result = dial(cfg, number, answer_url, max_secs, args.ring_timeout)
    print(f"Call placed to {number}. Plivo request: {result.get('request_uuid', 'unknown')}")
    print("Watch the server terminal for the call. The transcript will be under logs/calls/.")
    return 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv(ROOT / ".env")
    args = parse_args(argv)
    try:
        return run(args)
    except CallError as e:
        print(f"Error: {e}", file=sys.stderr)
        return e.code


if __name__ == "__main__":
    sys.exit(main())
