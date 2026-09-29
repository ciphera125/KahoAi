"""Talk to the agent through your microphone and speakers.

    python scripts/talk.py

The same as `python apps/voice/main.py`, under the name the build plan uses.
"""

import runpy
import sys
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent / "apps" / "voice"
sys.path.insert(0, str(VOICE))
runpy.run_path(str(VOICE / "main.py"), run_name="__main__")
