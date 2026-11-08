"""The owner does not want em dashes anywhere in the system: not in the Studio's words, not in
what the agent is told or says, not in the notes. They read as written by a machine, and a
voice has no way to say one."""
import subprocess
from pathlib import Path

DASH = chr(0x2014)
ROOT = Path(__file__).resolve().parents[3]
SKIP = ("package-lock.json", "node_modules/", "venv/")
BINARY = {".wav", ".opus", ".png", ".svg", ".ico", ".woff", ".woff2", ".onnx", ".pyc", ".jpg",
          ".gif", ".mp3"}


def test_no_tracked_file_contains_an_em_dash():
    files = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
    found = []
    for name in files:
        if any(part in name for part in SKIP) or Path(name).suffix in BINARY:
            continue
        try:
            text = (ROOT / name).read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        if DASH in text:
            found.append(f"{name} ({text.count(DASH)})")
    assert not found, "em dashes in: " + ", ".join(found)


async def test_what_the_agent_says_never_has_one():
    import main

    said = f"Your EMI {DASH} due on the fifteenth {DASH} is five hundred."
    out = await main.SpokenPunctuationFilter().filter(said)
    assert DASH not in out


def test_an_em_dash_still_separates_words_for_the_interruption_filter():
    # The sweep that removed em dashes from the source also rewrote this character class once;
    # a dash is how a caller's transcript can join two words, so it must still split them.
    import interruptions

    assert interruptions._SPLIT.split(f"okay{DASH}haan") == ["okay", "haan"]
