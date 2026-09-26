"""Report which variables from .env.example are unset in the current environment/.env."""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
OPTIONAL = {"AWS_SESSION_TOKEN"}


def main() -> int:
    load_dotenv(ROOT / ".env")
    names = [
        line.split("=", 1)[0]
        for line in (ROOT / ".env.example").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    ]
    missing = [n for n in names if n not in OPTIONAL and not os.getenv(n)]
    for n in missing:
        print(f"missing: {n}")
    print("all set" if not missing else f"{len(missing)} missing")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
