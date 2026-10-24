"""The persona saved for a phone number, edited on the local admin page.

A plain JSON file is enough while this is a testing tool: one machine, one
editor, a handful of numbers. Everything goes through PromptStore, so moving it
to a database later changes this file only.

A call reads the store when it starts, so a saved prompt takes effect on the
next call without a restart. Reading never raises into a call: a missing or
broken file means the default persona, never a failed call.
"""

import json
import os
import re
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger

# Every character is re-sent to the LLM on every turn, so a long prompt costs
# time and tokens on all of them.
MAX_PROMPT_CHARS = 8000
# Every save is kept as a version to restore; the oldest go past this many.
MAX_VERSIONS = 50

DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "number_prompts.json"


def normalize_number(raw: str) -> str:
    """E.164 for an Indian number given any common way ("8065520552", "+91 80655 20552")."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        digits = "91" + digits
    if not 8 <= len(digits) <= 15:
        raise ValueError(f"{raw!r} is not a phone number")
    return "+" + digits


def append_private(path: Path, text: str) -> None:
    """Append to a file only its owner can read (it holds names and numbers),
    making an existing file private too. One write per call, so a line from
    another process is never interleaved with it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)


def write_json_atomic(path: Path, data) -> None:
    """Write beside the target, then swap it in, so a crash or a full disk leaves
    the old file whole rather than half a new one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class PromptStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _read(self) -> dict:
        """The whole file. Raises ValueError if it exists but is not valid JSON."""
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"{self.path} is not valid JSON: {e}") from e
        if not isinstance(data, dict):
            raise ValueError(f"{self.path} does not hold an object")
        return data

    def _write(self, data: dict) -> None:
        write_json_atomic(self.path, data)

    def get(self, number: str) -> dict | None:
        """The current prompt for a number, or None for the default persona."""
        try:
            entry = self._read().get(normalize_number(number))
        except ValueError as e:
            logger.error(f"Prompt store unreadable, using the default persona: {e}")
            return None
        if not entry or not entry.get("prompt"):
            return None
        return {"prompt": entry["prompt"], "updated_at": entry.get("updated_at")}

    def all(self) -> dict:
        """Numbers with a current prompt (a reverted number keeps only its history)."""
        return {n: v for n, v in self._read().items() if v.get("prompt")}

    @staticmethod
    def _history(entry: dict) -> list[dict]:
        if "versions" not in entry:
            # Saved before versions existed: its prompt is the first version.
            entry["versions"] = ([{"id": uuid.uuid4().hex[:12], "prompt": entry["prompt"],
                                   "saved_at": entry.get("updated_at")}]
                                 if entry.get("prompt") else [])
        return entry["versions"]

    def versions(self, number: str) -> list[dict]:
        """Every saved version, newest first."""
        entry = self._read().get(normalize_number(number)) or {}
        return list(reversed(self._history(dict(entry))))

    def restore_version(self, number: str, version_id: str) -> dict:
        version = next((v for v in self.versions(number) if v["id"] == version_id), None)
        if version is None:
            raise KeyError(version_id)
        return self.set(number, version["prompt"])

    def delete_version(self, number: str, version_id: str) -> None:
        number = normalize_number(number)
        data = self._read()
        entry = data.get(number) or {}
        history = self._history(entry)
        keep = [v for v in history if v["id"] != version_id]
        if len(keep) == len(history):
            raise KeyError(version_id)
        entry["versions"] = keep
        data[number] = entry
        self._write(data)

    def set(self, number: str, prompt: str) -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("the prompt is empty")
        if len(prompt) > MAX_PROMPT_CHARS:
            raise ValueError(f"the prompt is over {MAX_PROMPT_CHARS} characters")
        number = normalize_number(number)
        data = self._read()  # a corrupt file raises here instead of being overwritten
        entry = data.get(number) or {}
        history = self._history(entry)
        now = datetime.now(UTC).isoformat()
        history.append({"id": uuid.uuid4().hex[:12], "prompt": prompt, "saved_at": now})
        entry.update(prompt=prompt, updated_at=now, versions=history[-MAX_VERSIONS:])
        data[number] = entry
        self._write(data)
        return {"prompt": prompt, "updated_at": now}

    def delete(self, number: str) -> None:
        number = normalize_number(number)
        data = self._read()
        entry = data.get(number)
        if entry and entry.get("prompt"):
            self._history(entry)  # keep what was there as history
            entry.pop("prompt")
            entry["updated_at"] = datetime.now(UTC).isoformat()
            self._write(data)


def default_store() -> PromptStore:
    return PromptStore(Path(os.getenv("PROMPT_STORE_PATH") or DEFAULT_PATH))


def our_number() -> str | None:
    """Our Plivo number, which saved prompts are keyed by."""
    try:
        return normalize_number(os.getenv("PLIVO_FROM_NUMBER") or "")
    except ValueError:
        return None


def prompt_for_our_number() -> str | None:
    """The saved persona for our number, or None for the default. Never raises."""
    number = our_number()
    if number is None:
        return None
    try:
        saved = default_store().get(number)
    except Exception as e:  # a call must never fail over its persona
        logger.error(f"Prompt store failed, using the default persona: {e!r}")
        return None
    return saved["prompt"] if saved else None
