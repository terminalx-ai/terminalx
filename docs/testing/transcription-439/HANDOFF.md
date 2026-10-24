# Native validation handoff

Automated checks do not establish recognition accuracy. Do not close #439 until
the paired measurements and Apple observations below are collected.

1. Recording script: `docs/testing/transcription-439/sentences.json`. Ask for
   three takes of each spoken sentence, plus five seconds each of quiet room,
   ambient noise and typing. Use invented terms only. Keep audio in a private
   folder outside this checkout; do not search existing recordings.
2. Record/archive WAV at **16000 Hz, mono**. The native harness input is
   **headerless IEEE-754 float32 little-endian PCM, mono, 16000 Hz**, normalized
   to [-1,1], between one sample and 60 seconds per file. A WAV header is not
   valid harness input. Retain the original WAV for Apple playback if the
   person has a loopback microphone setup.
3. Make `options.json` in that private folder. For a context-only ON run:

   ```json
   {"options":{"context":true},"entries":[]}
   ```

   Create a manifest using the complete example in [README.md](README.md).
   Point `modelPath` at explicitly selected existing weights, `audioPath` at
   one donated PCM file, `terms` at that sentence's terms, `reference` at the
   intended text, and `outputPath` at a **new** private result file. Do not
   download models without a separate decision. Only Parakeet weights were
   found during read-only inventory; both Whisper models still need weights.
4. From `src-tauri`, the following command executes **OFF then ON against the
   same PCM**. OFF always uses default options and no terms; ON uses
   `options.json` and manifest terms. No separate invocation is needed:

   ```sh
   TX_EVAL_STATE=$(mktemp -d)
   CARGO_BUILD_JOBS=2 SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" \
     TERMINALX_HOME="$TX_EVAL_STATE/terminalx" \
     CLAUDE_CONFIG_DIR="$TX_EVAL_STATE/claude" \
     TX_DICTATION_EVAL_MANIFEST=/absolute/private/path/manifest.json \
     cargo test transcription::evaluation::real_model_pair -- --ignored --exact
   ```

   The result has `baseline` (OFF) and `personalized` (ON), raw/final text,
   case-sensitive term accuracy, WER, actual bias terms and processing time.
   Repeat with dictionary/replacement/cleanup options individually and combined.
   The first run includes loading; compare warmed runs for inference latency.
5. Apple requires a person to run an explicitly prepared disposable build;
   do not change or automate the installed app. In Settings → Transcription,
   use **Test dictation**, select Apple, and record raw/final/terms for the same
   sentences in randomized OFF/ON order. Note locale, microphone, OS, whether
   on-device recognition was available, and whether the first words were missed.
   For all engines, collect silence false positives separately from WER.

Minimum remaining evidence: per-sentence OFF/ON term accuracy and WER for both
Whisper models and Apple; silence results for every catalog engine and Apple;
context preparation and stop-to-final latency; one native correction learned
after a successful send, then removed; no resurrected text after deleting an
Apple partial; sensitive/cloud-off diagnostics containing no context. The
checked-in protocol describes the full matrix. Record missing rows explicitly;
do not substitute mocked recognition or Parakeet results for Whisper/Apple.
