"""Summarise the per-turn timing log the agent writes.

`main.py` appends one JSON object per metric to logs/turns.jsonl. This reads
them back and prints, per pipeline stage, the average and the worst case.

Worst case is the number to watch. An average hides the one turn in twenty
where the caller sat through two seconds of silence, and that turn is the one
they remember.

Usage:
    python scripts/latency_summary.py                  # every run in the log
    python scripts/latency_summary.py --last 5         # the 5 most recent runs
    python scripts/latency_summary.py --run 20260927T091500
    python scripts/latency_summary.py --path other.jsonl
"""

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = ROOT / "logs" / "turns.jsonl"

# The stages worth reporting, in the order the caller experiences them, with
# the metric/processor each is recorded under.
STAGE_ORDER = ["STT", "LLM", "TTS", "TTS first audio"]

# Measured from frames, not services, so they cover the wait Pipecat's own
# metrics cannot see (the VAD's stop_secs, then the smart-turn classifier).
# "caller wait" is the silence the caller actually sits through and is the sum
# of the two above it.
TURN_PHASES = {
    "turn_detection": "turn detection",
    "reply_after_turn": "reply after turn",
    "caller_wait": "CALLER WAIT (total)",
}


def classify(record: dict) -> str | None:
    """Map a raw metric record onto a pipeline stage, or None to ignore it."""
    processor = (record.get("processor") or "").lower()
    metric = record.get("metric", "")
    if metric in TURN_PHASES:
        return TURN_PHASES[metric]
    if metric == "ttfa":
        return "TTS first audio"
    if metric != "ttfb":
        return None
    if "stt" in processor:
        return "STT"
    if "llm" in processor:
        return "LLM"
    if "tts" in processor:
        return "TTS"
    return None


def load(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(
            f"No timing log at {path}.\nRun the agent first — it writes one as it talks."
        )
    records = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            print(f"  (skipping malformed line {n})", file=sys.stderr)
    return records


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--path", type=Path, default=DEFAULT_LOG)
    ap.add_argument("--last", type=int, metavar="N", help="only the N most recent runs")
    ap.add_argument("--run", metavar="ID", help="only this run id")
    args = ap.parse_args()

    records = load(args.path)
    runs = sorted({r.get("run", "?") for r in records})
    if args.run:
        runs = [r for r in runs if r == args.run] or sys.exit(f"No run {args.run!r}.")
    elif args.last:
        runs = runs[-args.last :]
    records = [r for r in records if r.get("run", "?") in runs]
    if not records:
        sys.exit("Nothing to summarise for that selection.")

    by_stage: dict[str, list[float]] = defaultdict(list)
    for record in records:
        stage = classify(record)
        seconds = record.get("seconds")
        # Processors emit a zeroed metric when they reset between turns; those
        # are not measurements and would drag every average toward zero.
        if stage and isinstance(seconds, int | float) and seconds > 0:
            by_stage[stage].append(float(seconds))

    if not by_stage:
        sys.exit("The log has no stage timings in it yet.")

    print(f"{len(runs)} run(s), {sum(len(v) for v in by_stage.values())} measurements")
    print(f"{'stage':<21}{'n':>4}{'avg':>9}{'p50':>9}{'worst':>9}")
    print("-" * 52)

    def row(stage: str) -> None:
        values = by_stage.get(stage)
        if not values:
            return
        print(
            f"{stage:<21}{len(values):>4}"
            f"{statistics.mean(values):>8.3f}s"
            f"{statistics.median(values):>8.3f}s"
            f"{max(values):>8.3f}s"
        )

    for stage in STAGE_ORDER:
        row(stage)
    if any(by_stage.get(name) for name in TURN_PHASES.values()):
        print("-" * 52)
        for name in TURN_PHASES.values():
            row(name)

    # What the caller actually waits through once they stop speaking: the model
    # has to think, then the voice has to start. STT overlaps with their speech,
    # so it is reported above but not added in here.
    llm, first_audio = by_stage.get("LLM"), by_stage.get("TTS first audio") or by_stage.get("TTS")
    if llm and first_audio:
        print(
            f"\ntime to first audio (LLM + TTS): "
            f"avg {statistics.mean(llm) + statistics.mean(first_audio):.3f}s, "
            f"worst {max(llm) + max(first_audio):.3f}s"
        )
    caller_wait = by_stage.get(TURN_PHASES["caller_wait"])
    if caller_wait:
        print(
            f"measured caller wait:            avg {statistics.mean(caller_wait):.3f}s, "
            f"worst {max(caller_wait):.3f}s"
        )
        print("Judge a call by the measured wait: the stage sums leave out turn detection.")
    else:
        print("VAD stop_secs is added on top of this; see VAD_STOP_SECS in .env.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
