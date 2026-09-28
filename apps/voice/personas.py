"""Which persona files exist, and safe lookup of one by name.

An agent name can arrive from the network (the outbound answer URL), so it is
matched against a strict pattern and then against the files actually present.
Nothing is ever built from it as a path, so `../../.env` is just an unknown name.
"""

import re
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")


def available() -> list[str]:
    return sorted(p.stem for p in PROMPTS_DIR.glob("*.md"))


def resolve(name: str | None) -> Path:
    """The prompt file for `name`. Raises ValueError, listing what exists, if there is none."""
    if not name or not _NAME.match(name) or name not in available():
        raise ValueError(f"unknown agent {name!r}; available: {', '.join(available())}")
    return PROMPTS_DIR / f"{name}.md"
