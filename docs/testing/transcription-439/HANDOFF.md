# Native validation handoff

A five-model synthetic evaluation and isolated native settings pass are now
recorded in [NATIVE-RESULTS.md](NATIVE-RESULTS.md). The post-merge guest UI pass,
public runtime telemetry and precise remaining gaps are in
[GUEST-RESULTS.md](GUEST-RESULTS.md). These are not human microphone
accuracy evidence. The independent detector experiment and rejected candidate
are recorded in [VAD-RESULTS.md](VAD-RESULTS.md). The follow-up
[CPU/Metal comparison](BACKEND-RESULTS.md) rules out switching to CPU as a
remedy for the tested failures. Do not close #439 until
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
3. Coordinator preparation (not a user task): generate manifests and options
   from donated files. For a context-only ON run, use:

   ```json
   {"options":{"context":true},"entries":[]}
   ```

   The coordinator creates each manifest using the complete example in [README.md](README.md).
   Point `modelPath` at explicitly selected existing weights, `audioPath` at
   one donated PCM file, `terms` at that sentence's terms, `reference` at the
   intended text, and `outputPath` at a **new** private result file. All five
   catalog weights are now verified in the private evaluation cache
   documented in NATIVE-RESULTS.md; reuse those rather than downloading again.
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

## Minimum user action

No manifests or audio conversion are requested from the user. Make **one new
recording** following [RECORDING-SCRIPT.txt](RECORDING-SCRIPT.txt): seven
spoken lines, three takes each with pauses, plus five seconds each of
quiet room, ambient noise and typing. Keep the microphone/distance unchanged.
Share only these newly recorded samples with the coordinator; WAV is preferred,
but the coordinator can convert the recorder's native format to the required
16 kHz mono f32le and generate manifests. Do not share existing recordings.

For the first Apple check, use the disposable bundle described in
[NATIVE-BUILD.md](NATIVE-BUILD.md). No account or agent login is needed:

1. Launch with the provided command; open Settings → Transcription, choose
   Apple and the microphone. Keep the same language for both conditions.
2. Import the supplied `OFF.json`. Leave Test project at “Global dictionary
   only”. Click Start test, speak one script line, then Stop test. Preserve the
   raw/final result and bias terms (copy or screenshot), marked OFF and line ID.
3. Import `ON.json` and repeat that line, marked ON. Alternate which condition
   goes first for successive lines; collect three takes per condition. ON uses
   dictionary hints plus retakes/number/code formatting; the **raw** text is
   the recognition comparison and final text includes deterministic cleanup.
4. Repeat OFF/ON with five seconds of quiet, ambient noise and typing. Report
   any text, permission/error message, missing first word or delay after Stop.
   Note macOS version, microphone and language. Quit only the disposable app.

OFF and ON contain identical invented dictionary terms; OFF disables every
feature. This shortest first pass tests Apple contextual strings from the
global dictionary. It does **not** replace project-context, correction-learning,
partial-deletion or full model-matrix rows above. The coordinator records those
remaining rows explicitly and arranges follow-up only after this first pass.
