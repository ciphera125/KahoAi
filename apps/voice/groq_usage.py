"""An append-only trail of every Groq API call made, so unexpected usage is visible.

Deliberately dumb: one plain-text line per call, no JSON, nothing to parse
with anything fancier than `tail` or `grep`. Not a substitute for the structured
logs (`logs/turns.jsonl`, `logs/calls/`) — this exists only so a scan of
`logs/groq_usage.log` answers "did anything call Groq, and from where" without
reading code.

Every call site passes its own name as `caller` (the function, not a guess at
"the feature"), so a log line points straight at the responsible code.
"""

import os
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger

DEFAULT_LOG_PATH = Path(__file__).resolve().parent.parent.parent / "logs" / "groq_usage.log"


def log_groq_call(caller: str, model: str, path: Path | str | None = None) -> None:
    """Append one line. Never raises: a logging failure must not break the call it logs."""
    target = Path(path or os.getenv("GROQ_USAGE_LOG_PATH") or DEFAULT_LOG_PATH)
    line = f"{datetime.now(UTC).isoformat()} | {caller} | {model}\n"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError as e:
        logger.error(f"Could not write to {target}: {e}")
