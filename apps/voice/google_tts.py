"""Google Chirp 3 HD voices, authenticated with an API key.

Pipecat's GoogleTTSService streams Chirp 3 HD but only authenticates with a
service account. This builds the same client from an API key instead, and keeps
the voice in step with the language.

Google rejects a request whose language does not match the voice's own locale
("Requested language code 'en-IN' doesn't match that of voice
'hi-IN-Chirp3-HD-Aoede'"), and each Chirp 3 HD voice exists once per locale. So
when the caller switches language, the voice has to switch with it, to the same
voice in the other locale. FollowCallerLanguage sends only a language, and
Pipecat maps plain English to en-US, which no en-IN voice accepts either.
"""

from typing import AsyncGenerator

from google.api_core.client_options import ClientOptions
from google.cloud import texttospeech_v1
from pipecat.frames.frames import Frame
from pipecat.services.google.tts import GoogleTTSService

# Our callers speak Hindi or Indian English; each maps to one locale.
LOCALES = {"hi": "hi-IN", "en": "en-IN"}


def locale_for(language: object) -> str | None:
    """The voice locale for a language setting, or None if we have no voice for it."""
    return LOCALES.get(str(language or "").split("-")[0].lower())


class GoogleChirpTTSService(GoogleTTSService):
    def __init__(self, *, api_key: str, voice: str, language: str, **kwargs):
        """voice is the bare Chirp 3 HD name ("Aoede"); language is "hi" or "en"."""
        self._api_key = api_key
        self._voice_name = voice
        self._locale = LOCALES[language]
        super().__init__(
            settings=GoogleTTSService.Settings(
                voice=self._full_voice(), language=self._locale
            ),
            **kwargs,
        )

    def _full_voice(self) -> str:
        return f"{self._locale}-Chirp3-HD-{self._voice_name}"

    def _create_client(self, credentials, credentials_path):
        return texttospeech_v1.TextToSpeechAsyncClient(
            client_options=ClientOptions(api_key=self._api_key)
        )

    def _settle(self) -> None:
        # Take the locale from whatever language was last set, keeping the
        # current one for a language we have no voice for, then name the voice
        # in that same locale so the request cannot mismatch.
        self._locale = locale_for(self._settings.language) or self._locale
        self._settings.language = self._locale
        self._settings.voice = self._full_voice()

    async def _update_settings(self, delta):
        # Settled on every change, not only when speaking: a caller's turn can
        # arrive in pieces, so two changes can land before the next sentence.
        changed = await super()._update_settings(delta)
        self._settle()
        return changed

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        self._settle()
        async for frame in super().run_tts(text, context_id):
            yield frame
