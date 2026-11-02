# Independent Whisper reference comparison

This is diagnostic evidence, not a new application engine or a microphone
acceptance result. Production code remains unchanged. The comparison uses
whisper.cpp v1.9.5, commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`, and
TerminalX's existing transcribe-cpp 0.2.3. Both decode the **same BIN model
files** and identical checksum-verified audio. This avoids treating two
independent quantizations as an exact same-weights comparison.

## Provenance and setup

The [official reference downloader](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/models/download-ggml-model.sh)
points to `ggerganov/whisper.cpp`. [reference-models.json](reference-models.json)
pins that public model repository to revision
`5359861c739e955e79d9a303bcbc70fb988958b1`, with LFS SHA-256 and file size
obtained from the repository's public metadata before download. The two files
are MIT-licensed Q8_0 Small (264,464,607 bytes) and Turbo (874,188,075 bytes),
1,138,652,682 bytes total. Each download's size and SHA-256 were verified.
They remain in `/tmp/tx439-kmesvcjt/reference`, separate from user models.
No token, account, paid service, private recording or audio upload was used.

The reference runtime is a disposable static CPU-only build, with Metal and
BLAS disabled, built with jobs 2 and the macOS SDK. It is not shipped or added
to application dependencies. The original diagnostic code in
[reference-trace.cpp](reference-trace.cpp) uses public model/state lifecycle
and segment accessors only. It creates fresh state per explicit f32le input.
No private object layouts, model edits or patched library sources are used.

Reference probe SHA-256:
`0974eb04b9de18ea60df3bd89f73dbe0380c4e6e1ca2b26754fa44fa8668e0ee`.
Reference libwhisper.a SHA-256:
`a94145e51bd10f02a6a5d7e6fffad8409c68912f242b23fca095105c43de5124`.
Existing transcribe probe SHA-256:
`c4f5b5087c7620ae2e69f897fd3ccbc993706592abc5f45b11a04eda10fddc3c`.
The app's source checkpoint for this experiment is `07da8f33` (its production
code remains the earlier post-merge source recorded in GUEST-RESULTS.md).

## Controls and interpretation

The selected inputs are the same generated silence, white noise and tone,
Daniel's invented “Open the Parakeet files”, and that sentence at gain 0.001
used in the backend comparison. OFF has an empty prompt. ON uses the same
five vocabulary terms as earlier probes. Two models × two runtimes × two
prompt conditions × five inputs gives 40 runs. No input was selected or removed
after seeing the reference output.

Both runtimes use CPU, automatic language, fresh per-file state, no timestamp
requests, no previous-transcript conditioning, and the same initial prompt.
The reference uses two inference threads, greedy best-of-one, and its default
fallback schedule (temperature 0, increment 0.2), log probability threshold -1
and no-speech threshold 0.6. Neither runtime's thresholds were tuned. Decoding
implementations and fallback criteria are not identical: reference entropy and
transcribe compression-ratio handling differ. This is not a byte-equivalence
claim. These differences limit attribution of individual words; the unprompted
no-speech probability comparison is particularly useful because it precedes
output filtering.

Reference public telemetry exposes probabilities for retained segments only;
a skipped clip has no segment score to report. Unlike the transcribe probe,
it cannot expose skipped chunk probabilities through this public accessor.
Reference segment timestamps may be invalid when timestamp generation is
disabled; they are retained as reported and must not be used for latency or
alignment conclusions. Wall times include model load and multiple inputs under
concurrent test load, not warmed stop-to-final measurements.

## Measured result and next dependency

[reference-results.csv](reference-results.csv) retains every raw transcript,
per-input word error rate, exact-case term accuracy and public telemetry from
all 40 successful runs. Whitespace is preserved. WER uses the application's
normalization (whitespace words, outer punctuation removed, lowercase) and
Levenshtein distance divided by reference word count; empty references use
insertion count. The relevant speech term is `Parakeet`, case-sensitive as in
the application harness. Thus lowercase “parakeet” can have zero WER but zero
exact-case term accuracy. No application cleanup or learned replacement is
applied here; there is no separate final text to score in this runtime probe.

| Model | Reference nonempty noise results | transcribe nonempty noise results | Speech retained |
| --- | ---: | ---: | ---: |
| Turbo | 6/6 | 6/6 | 4/4 per runtime |
| Small | 4/6 | 5/6 | 4/4 per runtime |

The six noise rows per runtime combine silence/white noise/tone with OFF/ON.
Punctuation-only output counts as nonempty even when normalized WER is zero.
Reference Small skipped prompted silence and tone; its white-noise outputs
remained nonempty. No failed example is removed from the CSV.

Turbo's unprompted no-speech scores on the three noise inputs are approximately
7e-11 to 2e-10 in the independent reference and 5e-11 to 2e-10 in transcribe.
Both emit text: reference silence is “you”, transcribe silence is “Thank you.”;
both emit a period for white noise and tone. Prompted reference noise echoes a
suffix of the prompt, while transcribe emits other text. The near-zero scores
and noise output are therefore **not unique to the app's GGUF conversion,
personalization, or transcribe-cpp**. This comparison does not prove a bug in
a specific component: both runtimes use quantized weights and GGML-family
compute, so quantization, model calibration and shared algorithmic behavior
remain possible causes. No original float-checkpoint measurement was made.

Reference Turbo spells Parakeet correctly in the normal speech control in both
conditions (WER 0), while transcribe produces Pericay (WER 0.25). Both produce
Paracate for the quiet control (WER 0.25). Reference Small's quiet ON control
has WER 0 but lowercase parakeet; its other speech rows and all transcribe Small
speech rows have WER 0.25. These are two versions of one synthetic utterance,
not evidence to switch models/runtimes or claim representative human accuracy.

Reference Small assigns no-speech probability 0.69129 to the quiet speech
control in both conditions, while still retaining it. This independently
reinforces the danger of filtering on probability >0.6 alone. The prior VAD
counterexamples remain valid; no threshold was tuned to these five inputs.

**Next dependency:** separating quantization from model calibration requires a
pinned original/unquantized checkpoint comparison, not a backend switch or
wrapper patch. Any proposed rejection rule additionally needs a held-out corpus
of representative quiet human speech and real non-speech conditions before
shipping. This turn supplies no evidence-backed production filter, so none was
added. Exposing public chunk telemetry remains useful for diagnosis but is not
itself a remedy. The original microphone/TCC and native acceptance gaps remain;
these synthetic file tests do not address them.

## Reproduction

Use a new private directory for the reference sources, model files and outputs.
Fetch the pinned reference commit from the public ggml-org/whisper.cpp repository
(the measured checkout used `git clone --depth 1 --branch v1.9.5`), verify
`git rev-parse HEAD` against the commit above, then build:

```sh
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" cmake \
  -S /tmp/tx439-kmesvcjt/reference/whisper.cpp \
  -B /tmp/tx439-kmesvcjt/reference/build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=OFF \
  -DGGML_METAL=OFF -DGGML_BLAS=OFF
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" cmake \
  --build /tmp/tx439-kmesvcjt/reference/build -j2
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" xcrun clang++ \
  -std=c++17 -Wall -Wextra -Werror \
  docs/testing/transcription-439/reference-trace.cpp \
  -I /tmp/tx439-kmesvcjt/reference/whisper.cpp/include \
  -I /tmp/tx439-kmesvcjt/reference/whisper.cpp/ggml/include \
  -L /tmp/tx439-kmesvcjt/reference/build/src \
  -L /tmp/tx439-kmesvcjt/reference/build/ggml/src \
  -lwhisper -lggml -lggml-cpu -lggml-base -framework Accelerate \
  -o /tmp/tx439-kmesvcjt/reference/reference-trace
```

Download only the two explicit URLs in reference-models.json into that private
directory, with the listed filenames; keep a copy of the manifest there as
`models.json`. The runner independently verifies their hashes before inference.
Build the transcribe probe as in GUEST-RESULTS.md, then run:

```sh
python3 docs/testing/transcription-439/run-reference-comparison.py \
  /tmp/tx439-kmesvcjt/evaluation \
  /tmp/tx439-kmesvcjt/trace-stress/manifest.json \
  /absolute/new/private/output \
  /tmp/tx439-kmesvcjt/reference \
  /tmp/tx439-kmesvcjt/whisper-backend-trace
```

The first measured output directory is `/tmp/tx439-kmesvcjt/reference/paired`;
`paired.log` retains status and elapsed time for each invocation. Build logs,
model manifest and the pinned source checkout remain alongside it. The probe
compiled with warnings denied. No guest or host GUI was needed.

## Check results and limits

All four required checks passed: TypeScript `tsc --noEmit`; Vitest 288 files /
3,368 tests; Clippy all targets with warnings denied; the final full Rust run
passed 2,236 unit tests plus 6 CLI and 2 integration tests (18 ignored).
The first Rust run failed one fake-native-helper socket startup test:
`computer::macos_native::tests::every_start_resolves_the_helper_again_so_a_restart_is_checked_too`
returned `action_timeout` while inference was also running. That isolated test
then passed, followed by a successful complete Rust rerun with inference
finished. This is an observed retry recovery, not proof of the timeout's root
cause. No test, timeout or assertion was altered. All logs remain under the
reference evidence directory: `tsc.log`, `vitest.log`, `clippy.log`, `cargo.log`
(the failure), `cargo-timeout-rerun.log` and `cargo-full-rerun.log`.

The checked-in C++ probe matches the compiled source byte-for-byte; compilation
used `-Wall -Wextra -Werror`. The reusable runner's syntax and all 40 unique
CSV rows/telemetry counts were checked. The measured invocation used the same
runner logic before its documentation and preflight path check were added;
there was no second full inference pass. No audio or context left the machine.
No guest/host app was launched, no TCC setting was changed, and no shared
integration or store paths were edited. The guest lane can be released.
Acceptance remains open; this evidence does not justify issue closure.

Follow-up: [FP16 comparison](F16-RESULTS.md) reproduces the failures without Q8.
[Detector-only normalization](SILERO-NORMALIZED-RESULTS.md) records a promising
controlled candidate, its full negative controls and the runtime integration gap.
Neither is microphone acceptance.
