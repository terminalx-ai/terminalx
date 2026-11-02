# Public native detector integration checkpoint

Historical pre-inference plan. Execution results and the rejected full runtime
upgrade are now recorded in [NATIVE-VAD-RESULTS.md](NATIVE-VAD-RESULTS.md). The
original selection rules below are retained so results cannot redefine the plan.
The detector-only adapter uses the unchanged 0.2.3 runtime; the guest remains stopped.

## Supported API found

The shipped application uses transcribe-cpp 0.2.3, source
`63a44d9239d610b3908e8a66b384924cd4a77217`. That version has no VAD role.
Its Whisper implementation is its own architecture, not a linked whisper.cpp
library exposing `whisper_vad_*`. Do not reach into private structs or patch the
Cargo registry to pretend otherwise.

An upstream audit on 2026-10-24 found released **0.4.1**, tag object
`1ea3e87f2f50ca913c09da661701744a9d654674`, peeled commit
`4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b`. It already provides:

- Public C `include/transcribe/vad.h`, opaque sessions, error-returning runs,
  per-frame probabilities, explicit reset and CPU selection.
- Safe Rust `Model::vad_info`, `vad_session_with`, `VadSession::run`,
  `VadResult::probs`, with owned results and per-model compute locking.
- An in-process Silero graph using the existing GGML dependency. No Python,
  ONNX runtime, extra process, new recognition backend or private layout needed.

Sources: [tagged VAD documentation](https://github.com/handy-computer/transcribe.cpp/blob/4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b/docs/vad.md),
[tagged Rust wrapper](https://github.com/handy-computer/transcribe.cpp/blob/4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b/bindings/rust/transcribe-cpp/src/vad.rs).
The isolated source checkout is `/tmp/tx439-kmesvcjt/transcribe-vad-upstream`.

## Reviewable prototype

`native-vad-probe/` is a standalone diagnostic crate pinned to that commit,
with no GPU features. It is not a workspace member or production dependency.
Its JSON manifest names a SHA-256-pinned model and explicit f32le inputs. Before
inference it validates all hashes, unique IDs, rates, sample limits and finite
range. It uses one CPU thread, records all per-frame probabilities and timing,
and compares raw versus detector-only peak normalization without changing ASR
samples. Retain the whole clip if any frame is >= 0.5; do not apply the default
250 ms minimum segment rule. Invalid/incomplete results are errors, not silence.
Output is create-new JSONL; failures remain visible with preceding results.

Model provisioning is pinned in `native-vad-model.json`: upstream published
Silero v6.2 F32 GGUF, 1,241,056 bytes, MIT. This is a prospective artifact, not
claimed downloaded/verified/inferred by this checkpoint. The future fetch must
verify both size and SHA-256 before running. The source lineage audit is retained in `native-vad-lineage.json`: the exact
ONNX Git blob is identical at the diagnostic pin and the native converter
source pin `5cd7945676eb32225748052e2e6a0580e4686a08`. Both declare version
6.2.3. This supports comparing the exports, but GGUF/JIT conversion still needs
numeric parity checks; a model family name alone does not prove identical math. No unpinned `main` model URL may enter the app catalog.

Example manifest (paths and real checksums supplied by the fixture preparer):

```json
{"modelPath":"/private/model.gguf","modelSha256":"...","inputs":[
  {"id":"speech","audioPath":"/private/speech.f32","sha256":"...","sampleRate":16000}
]}
```

After resource release, copy the crate to a private disposable directory, retain
its resolved lockfile, and build/run with `CARGO_BUILD_JOBS=2`, correct `SDKROOT`,
private `TERMINALX_HOME`/`CLAUDE_CONFIG_DIR` and a private target directory. Use
release optimization for latency observations; include a separately labelled
cold load and warmed iterations. Do not infer success from a syntax check.

## Fixed evaluation plan before native results

1. Preserve all earlier failed detector/Whisper evidence. Run identical raw and
   normalized 16 kHz samples through the diagnostic ONNX model and native API;
   retain every probability, input hash, threshold crossing and discrepancy.
   Report max/mean absolute frame difference; provisional parity tolerance is
   1e-4 absolute, and no threshold-decision mismatch is acceptable for adoption.
   A different model lineage must be labelled a comparison, not numeric parity.
2. Include all 51 existing synthetic/stress controls and all 24 generated noise
   controls from the normalization experiment. Do not tune their thresholds.
3. Broaden speech to **all 22** attributed FLEURS samples in the tagged runtime's
   `samples/README.md`: fourteen short/long clips and eight language-ID clips,
   at gains 1, 0.03, 0.001. They are 16 kHz PCM16: decode by division by 32768,
   record resulting PCM hashes, do not resample. The latter eight were previously
   selected by upstream language-ID correctness, so are not unbiased corpus
   samples. All are public human file audio, not live microphone evidence.
   Record author/source attribution, CC-BY-4.0, original utterance IDs, pinned
   Git blob/SHA-256 and the declared gain modifications. Exclude unrelated
   upstream clips whose README explicitly leaves provenance unresolved.
4. Retain the complete FSDD evidence separately. Its 8 kHz inputs cannot be fed
   directly to this 16 kHz native API. Any resampled comparison needs identical
   declared resampling for both arms and separate results, not replacement of
   the earlier native-8 kHz ONNX observations.
5. Select ESC-10 fold 5, first two filenames in lexical order in each of its
   ten classes: 20 environmental clips, 8,820,880 bytes before resampling. The
   selection and individual attribution are pinned in
   `native-vad-esc10-sources.json` at ESC-50 commit
   `33c8ce9eb2cf0b1c2f8bcf322eb349b6be34dbb6`. ESC-10 is CC-BY-3.0;
   the larger ESC-50 dataset has different licensing and is not selected.
   Audio has not been fetched or scored at this checkpoint. Use fixed
   band-limited 44.1-to-16 kHz resampling, identical bytes in both arms, and
   declare the conversion. Retain all 20, including human non-speech sounds;
   labels are environmental categories, not proof of no background speech.
   Real environmental controls broaden the test but do not prove robustness. Do not silently label
   speech-bearing music/TV as noise: false speech detection differs from rejection
   of intentional speech. Record all failures; no phrase blacklist or revised
   threshold selected from this test corpus.

## Application integration sequence

First prove the native API candidate in isolation. Then upgrade the existing
transcribe-cpp dependency only if all-off compatibility is established on the
complete saved five-model corpus. Existing Whisper encoder/decoder source files
are byte-identical between 0.2.3 and 0.4.1, but loader/model code changed; Parakeet
and shared runtime code also changed. Source similarity does NOT prove output
identity. Compare raw outputs, errors and language behavior with identical weights
and CPU/Metal selection; retain mismatches and repair or choose a narrow upstream
backport if a full update breaks the issue's all-off requirement. Do not claim
new-version defaults preserve behavior without measuring them.

The production detector should be lazy-loaded separately from the ASR model,
serialized, and invoked only when the existing guard option is enabled. Disabled
guards must bypass loading, inference and audio changes entirely. The original
PCM goes to ASR; only a temporary in-memory detector copy is normalized. Missing
weights/backend failure yields an unavailable diagnostic and the unmodified ASR
path, never discards speech as a failed detector result. The verified detector
model needs the existing trusted downloader/cache lifecycle and license display
in Settings; no auto-download on microphone start. Test raw/final diagnostics must
expose a successful suppression versus an unavailable detector, without retaining
audio/context on disk. Preserve cancellation and do not delay recording startup.

The initial integration targets catalog file recognition. Apple's partial/final
path needs separate lifecycle work and native consent-dependent testing; do not
change composer insertion/partials as a shortcut. Existing microphone and Apple
acceptance gaps remain explicit. No new user product decision is required for this
engineering investigation, and no production change is claimed in this checkpoint.

## Resource checkpoint

Guest-only process snapshots on 2026-10-24 identified WindowServer PID 190 at
99.7–100% CPU; no owned TerminalX/model/Python/Node/Cargo test process appeared.
Both snapshot commands exited. The coordinator subsequently suspended
`local:terminalx-cua-macos` with the supported CUA operation, preserving disk
state and ending host VM PID 67333. No system service was killed by this issue.
Do not resume the guest or start builds/inference until #232 explicitly releases
its pending reservation. Source checkout/prototype preparation uses no guest UI.

The probe source and manifest preparation are not passing native evidence. The
four application checks last passed on `334bf358`; evidence commit `c722b499`
changed only diagnostics/docs. New prototype compilation, model verification,
all-off compatibility and measured parity are still pending.

## Prepared commands (run only after the reservation is released)

The fetcher requests only the pinned 1.24 MB detector and the selected 8.82 MB
ESC-10 files. It verifies size plus SHA-256 or Git blob identity before writing,
records resulting SHA-256, refuses existing directories and preserves partial
verified download evidence. It never accesses the app cache.

```sh
python3 docs/testing/transcription-439/fetch-native-vad-assets.py /absolute/new/private/assets
# In the disposable diagnostic venv only, for the fixed resampling step:
/absolute/private/venv/bin/python -m pip --isolated install --only-binary=:all: scipy==1.13.1
/absolute/private/venv/bin/python docs/testing/transcription-439/prepare-native-vad-inputs.py \
  /tmp/tx439-kmesvcjt/transcribe-vad-upstream \
  /tmp/tx439-kmesvcjt/evaluation \
  /tmp/tx439-kmesvcjt/trace-stress/manifest.json \
  /absolute/new/private/assets \
  /absolute/new/private/assets/silero-vad-v6.2-F32.gguf \
  /absolute/new/private/inputs
```

That preparer creates the complete 161-input selection (51 existing + 24
generated + 66 multilingual speech variants + 20 environmental clips), plus
labels/provenance. It performs no inference. ONNX scoring uses
`probe-onnx-parity.py MANIFEST ONNX_MODEL ONNX_SHA256 NEW_OUTPUT`; native scoring
uses the built `tx439-native-vad-probe MANIFEST NEW_OUTPUT`.
`compare-vad-parity.py NATIVE_JSONL ONNX_JSONL NEW_SUMMARY_JSON` reports all
conditions and returns failure on missing/error rows, mismatched PCM/frame
counts, >1e-4 probability differences or differing threshold decisions.
Neither script turns a failed inference into a silent success.

Preparation observation after release: the first preparation stopped on ESC
resampling overshoot outside [-1,1], before any model inference. Its partial
files and log remain in `native-vad-inputs` and `native-vad-prepare.log`. The
revised preparer applies fixed gain 0.5 to **every** ESC file before the same
resampler, retains this modification in provenance, and still rejects invalid
output rather than clipping it. Neither speech controls nor detector thresholds
change. Revised output uses a new directory; the failed evidence is preserved.
