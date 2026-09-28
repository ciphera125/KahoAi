"""Per-call transcripts, written to disk with sensitive numbers already masked.

One JSON line per finalized turn in logs/calls/<call_id>.jsonl, and a
`call_start` and `call_end` line around them. The masking happens inside
`write`, the only place that touches the file, so there is no path by which an
unmasked turn can be stored; callers cannot forget to do it.

Callers read long numbers out in pieces and STT ends a turn at every pause, so
"2 3 4", "5 6 7", "8 9 1", "2 3 4" arrives as four turns and no single one holds
twelve digits. Turns that look like number fragments are therefore held back
and checked together, as one run, before anything is written. If the run holds a
sensitive number the fragments are stored as one masked turn.

Nothing is recorded as audio. Storing a caller's voice needs a consent decision
that has not been made yet (see CLAUDE.md), and a transcript carries what the
summary and the tools need without it.
"""

import json
import re
import time
from datetime import UTC, datetime
from pathlib import Path

from masking import contains_sensitive, mask_sensitive

_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]")

# A turn is a possible piece of a spoken number if it has a digit in it, or if
# it is nothing but single characters (a PAN spelled out letter by letter).
_HAS_DIGIT = re.compile(r"\d|[०-९]")
_MAX_HELD = 30


class CallTranscript:
    def __init__(self, call_id: str, directory: Path):
        # The id comes from the network on a phone call, so it is not trusted to
        # be a safe filename.
        safe_id = _UNSAFE.sub("_", call_id)[:100] or "unknown"
        directory.mkdir(parents=True, exist_ok=True)
        self.call_id = call_id
        self.path = directory / f"{safe_id}.jsonl"
        self._ended = False
        self._held: list[dict] = []
        self.write({"event": "call_start"})

    def write(self, record: dict) -> None:
        record = {"at": datetime.now(UTC).isoformat(), "call_id": self.call_id, **record}
        if "text" in record:
            record["text"] = mask_sensitive(record["text"])
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    @staticmethod
    def _looks_like_fragment(text: str) -> bool:
        return bool(_HAS_DIGIT.search(text)) or all(len(t) == 1 for t in text.split())

    def user(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        if self._looks_like_fragment(text):
            self._held.append({"event": "turn", "role": "user", "text": text})
            if sum(r.get("role") == "user" for r in self._held) >= _MAX_HELD:
                self._flush()
            return
        self._flush()
        self.write({"event": "turn", "role": "user", "text": text})

    def assistant(self, text: str, interrupted: bool = False) -> None:
        text = (text or "").strip()
        if not text:
            return
        record = {"event": "turn", "role": "assistant", "text": text, "interrupted": interrupted}
        # Held behind any pending fragments so the transcript stays in order.
        if self._held:
            self._held.append(record)
        else:
            self.write(record)

    def event(self, name: str, **fields) -> None:
        """A marker line (a failover, a failure). Fields are ours, never call content."""
        record = {"event": name, **fields}
        if self._held:
            self._held.append(record)
        else:
            self.write(record)

    def tool(self, name: str, args: dict, result: dict, seconds: float) -> None:
        """Audit a tool call. Args and result are masked like any other text."""
        record = {
            "event": "tool",
            "role": "tool",
            "name": name,
            "text": json.dumps({"args": args, "result": result}, ensure_ascii=False, default=str),
            "seconds": round(seconds, 3),
        }
        if self._held:
            self._held.append(record)
        else:
            self.write(record)

    def _flush(self) -> None:
        """Decide what the held fragments are, then write them."""
        held, self._held = self._held, []
        if not held:
            return
        # Trailing punctuation would stop "5 6 7," and "8 9 1" reading as one run.
        joined = " ".join(
            re.sub(r"[.,;]+$", "", r["text"]) for r in held if r.get("role") == "user"
        )
        if contains_sensitive(joined):
            self.write({"event": "turn", "role": "user", "text": joined})
            for r in held:
                if r.get("role") != "user":
                    # An echo of a partial number is as sensitive as the number.
                    # Markers (a failover, a failure) carry no text to mask.
                    if "text" in r:
                        r = {**r, "text": re.sub(r"\d", "X", r["text"])}
                    self.write(r)
        else:
            for r in held:
                self.write(r)

    def end(self) -> None:
        if not self._ended:
            self._ended = True
            self._flush()
            self.write({"event": "call_end", "unix": time.time()})

    def attach(self, user_aggregator, assistant_aggregator) -> None:
        """Record each finalized turn. The caller decides when the call has ended."""

        @user_aggregator.event_handler("on_user_turn_stopped")
        async def _user(aggregator, strategy, message):
            self.user(message.content or "")

        @assistant_aggregator.event_handler("on_assistant_turn_stopped")
        async def _assistant(aggregator, message):
            self.assistant(message.content or "", message.interrupted)
