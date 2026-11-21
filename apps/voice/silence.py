"""What the agent does when the caller goes quiet.

Pipecat's user aggregator reports the caller idle `timeout` seconds after the agent stops speaking
(on_user_turn_idle); this decides what happens then. The agent asks whether they are there, up to
`times` times, then says goodbye and hangs up, or keeps waiting when the agent is set
not to hang up.
Anything the caller says starts the count again. Settings come from the agent (the Studio's Call
settings); off or missing means no timer at all.
"""

ASK = {"en": "Are you still there?", "hi": "क्या आप लाइन पर हैं?"}
GOODBYE = {
    "en": "I can't hear you, so I'll end the call now. Thank you, goodbye!",
    "hi": "मुझे आपकी आवाज़ नहीं आ रही, इसलिए मैं कॉल समाप्त कर रही हूँ। धन्यवाद, नमस्ते!",
}


def _whole(value, default: int, low: int, high: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return min(high, max(low, n))


class SilenceFollowUp:
    def __init__(self, timeout: float, times: int, message: str, hang_up: bool):
        self.timeout = timeout
        self.times = times
        self.message = message
        self.hang_up = hang_up
        self._asked = 0
        self._ended = False

    @classmethod
    def from_config(cls, config: dict | None) -> "SilenceFollowUp":
        c = config if isinstance(config, dict) else {}
        if not c.get("enabled"):
            return cls(0, 0, "", False)
        return cls(
            timeout=_whole(c.get("after_secs"), 10, 5, 60),
            times=_whole(c.get("times"), 2, 1, 5),
            message=" ".join(str(c.get("message") or "").split())[:200],
            hang_up=c.get("hang_up", True) is not False,
        )

    def caller_spoke(self) -> None:
        self._asked = 0

    def next_step(self, language_mode: str) -> tuple[str, str] | None:
        """("ask", words) or ("end", goodbye), or None when there is nothing more to do."""
        if self.timeout <= 0 or self._ended:
            return None
        lang = "hi" if language_mode in ("hindi", "mix") else "en"
        if self._asked < self.times:
            self._asked += 1
            return "ask", self.message or ASK[lang]
        if self.hang_up:
            self._ended = True
            return "end", GOODBYE[lang]
        return None
