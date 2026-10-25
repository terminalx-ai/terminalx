# Current isolated microphone candidate

Source: `4c85ecd6f8971af8b167260a5134bb99800dfce0`. Build completed successfully; ad-hoc hardened-runtime
signature passed deep/strict verification, with audio-input entitlement and
microphone/speech usage descriptions. Bundle ID is
`com.terminalx.next.dev.dictation439`, with no URL schemes.

App: `/tmp/tx439-kmesvcjt/presence-4c85ecd6/TerminalX Dictation 439.app`

Binary SHA-256: `d113dcb5ac068a09f2f086fae474fa338b1d99ae412922ea4cf60439667b7741`

Launch only through the isolated environment:

```sh
/tmp/tx439-kmesvcjt/presence-4c85ecd6/launch.sh
```

The launcher clears inherited environment and assigns private HOME, app/config
stores, temporary files and debug keychain namespace. Agent CLIs are disabled.
No app was launched and no microphone was recorded during preparation.
The older bundle at the parent directory is not this candidate.

1. Open Settings → Transcription. Select **Built in** (Apple), the intended
   microphone, and leave Test project at **Global dictionary only**.
2. Import `/tmp/tx439-kmesvcjt/presence-4c85ecd6/OFF.json`. Press **Start test**; respond to native consent
   yourself if offered. If necessary press Start test again after consent.
   Say **“Open TranscriptionTab dot tsx and refreshDictationEngine.”**
   Press **Stop test** and retain raw/final text or the exact error.
3. Import `/tmp/tx439-kmesvcjt/presence-4c85ecd6/ON.json`; repeat the same phrase. Retain raw/final and bias
   terms. ON enables dictionary and conservative formatting; compare raw text
   separately from final cleanup.
4. Explicitly start a five-second quiet control, then Stop test. Retain output
   or error. Note microphone, language and macOS version. Quit only this app.

If Apple reports unavailable on-device recognition, retain that error and
repeat the phrase with **Whisper Small**, already checksum-verified in this
private store (269,751,136 bytes, provenance beside launcher). This separates
microphone input from Apple availability; it is not Apple success. No account,
agent prompt or model download is required. Do not bypass native consent.

The 2026-10-25 manual round now has bounded Apple and Whisper Small recognition
and diagnostic observations, including failed trials; see
[HUMAN-OBSERVATIONS.md](HUMAN-OBSERVATIONS.md). It is paused and is not full
acceptance. Silence/noise-guard acceptance is explicitly deferred to #631, not passed.
The full recording matrix remains in HANDOFF.md; the subsequently completed
synthetic production detector matrix is recorded in PRODUCTION-DETECTOR.md and
does not establish this microphone presence check. All four checks passed before
packaging (2,243 Rust unit, six CLI, two integration; 3,370 frontend tests), plus
three detector tests. Logs/hashes are in production-detector-checks.json.
