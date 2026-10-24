"""The Studio's notifications: what changed, who changed it, and where to see it.

Append-only JSON lines (data/activity.jsonl, gitignored), trimmed to the newest
MAX_ITEMS. Texts are written by the Studio itself, never by a caller.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path

from prompt_store import append_private

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "activity.jsonl"
MAX_ITEMS = 200
MAX_TEXT = 160
VIEWS = {"dashboard", "calls", "contacts", "agents", "prompts", "numbers"}
_lock = threading.Lock()


class ActivityLog:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        rows = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows

    def add(self, kind: str, text: str, view: str | None = None, ref: str | None = None,
            actor: str | None = None) -> None:
        row = {"id": secrets.token_hex(6), "at": datetime.now(UTC).isoformat(),
               "kind": str(kind)[:20], "text": " ".join(str(text).split())[:MAX_TEXT],
               "view": view if view in VIEWS else None,
               "ref": str(ref)[:80] if ref else None, "actor": str(actor)[:80] if actor else None}
        with _lock:
            append_private(self.path, json.dumps(row, ensure_ascii=False) + "\n")
            rows = self._rows()
            if len(rows) > MAX_ITEMS + 50:  # trim now and then, not on every write
                tmp = self.path.with_suffix(".tmp")
                tmp.unlink(missing_ok=True)
                append_private(tmp, "".join(json.dumps(r, ensure_ascii=False) + "\n"
                                            for r in rows[-MAX_ITEMS:]))
                os.replace(tmp, self.path)

    def recent(self, limit: int = 30) -> list[dict]:
        return list(reversed(self._rows()[-MAX_ITEMS:]))[:limit]

    def unread(self, since: str | None) -> int:
        rows = self._rows()[-MAX_ITEMS:]
        return sum(1 for r in rows if not since or (r.get("at") or "") > since)


def default_log() -> ActivityLog:
    return ActivityLog(Path(os.getenv("ACTIVITY_PATH") or DEFAULT_PATH))
