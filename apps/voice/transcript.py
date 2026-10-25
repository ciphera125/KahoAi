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

Call audio is recorded separately by recording.py and cannot be masked; this
file stays the only store of call content as text, and the summary and the
tools read only this.
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
_ANY_DIGIT = re.compile(r"\d")


class CallTranscript:
    def __init__(self, call_id: str, directory: Path, sink=None):
        # The id comes from the network on a phone call, so it is not trusted to
        # be a safe filename.
        safe_id = _UNSAFE.sub("_", call_id)[:100] or "unknown"
        directory.mkdir(parents=True, exist_ok=True)
        self.call_id = call_id
        self.path = directory / f"{safe_id}.jsonl"
        # Also handed every line as written, masked (studio_link.EventSink).
        self.sink = sink
        self._ended = False
        self._held: list[dict] = []
        # What the caller has said so far, masked, for tools that must only act
        # on what the caller actually said (capture_lead). Memory only.
        self.caller_text: list[str] = []
        # Both sides in order, masked, for end_call's goodbye check. Memory only.
        self.turns: list[tuple[str, str]] = []
        self.write({"event": "call_start"})

    def write(self, record: dict) -> None:
        record = {"at": datetime.now(UTC).isoformat(), "call_id": self.call_id, **record}
        if "text" in record:
            record["text"] = mask_sensitive(record["text"])
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        if self.sink is not None:
            try:
                self.sink(record)
            except Exception:  # noqa: BLE001 - the file is the record; the sink is extra
                pass

    @staticmethod
    def _looks_like_fragment(text: str) -> bool:
        return bool(_HAS_DIGIT.search(text)) or all(len(t) == 1 for t in text.split())

    def user(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        self.caller_text.append(mask_sensitive(text))
        self.turns.append(("caller", self.caller_text[-1]))
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
        self.turns.append(("agent", mask_sensitive(text)))
        record = {"event": "turn", "role": "assistant", "text": text, "interrupted": interrupted}
        # Held behind any pending fragments so the transcript stays in order.
        if self._held:
            self._held.append(record)
        else:
            self.write(record)

    def live(self, role: str, text: str) -> None:
        """A live caption ("agent" or "caller") for the Studio's live transcript.

        Captions are fragments, and a number read out across several of them
        cannot be recognised by per-line masking, so every digit is blanked here.
        The turn's own line, masked properly, follows when the turn ends.
        """
        text = " ".join((text or "").split())
        if text:
            self.write({"event": "live", "role": role, "text": _ANY_DIGIT.sub("•", text)})

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
