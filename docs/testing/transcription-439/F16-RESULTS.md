# Unquantized FP16 Turbo comparison

This follows the same-BIN Q8 [reference comparison](REFERENCE-RESULTS.md).
It tests whether Q8 quantization alone explains the observed Turbo noise
behavior. “Unquantized” here means the reference GGML FP16 format, **not** an
original FP32 PyTorch checkpoint. No application model, backend, threshold or
UI changed as part of this comparison.

## Artifact and method

[reference-f16-models.json](reference-f16-models.json) pins the MIT-licensed
`ggerganov/whisper.cpp` file `ggml-large-v3-turbo.bin` at revision
`5359861c739e955e79d9a303bcbc70fb988958b1`. Expected size is 1,624,555,275 bytes;
SHA-256 is `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`.
The complete resumed file matched both before inference. Its GGML header has
file type 1 (the reference format's mostly-F16 weights, with some F32 tensors).

The earlier partial download and bounded failed URL probes were never used for
inference. Their logs remain in `/tmp/tx439-kmesvcjt/reference-f16` alongside
`PAUSED.txt`. The resumed pinned-URL transfer completed in about 62 seconds;
`download-resume-2.log` and `download-verification.json` retain its evidence.
No private models were overwritten. Only this public model file was downloaded.

The probes and runtimes are byte-for-byte the ones in REFERENCE-RESULTS.md:
whisper.cpp v1.9.5 commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` and
transcribe-cpp 0.2.3, both using CPU. Probe hashes remain
`0974eb04b9de18ea60df3bd89f73dbe0380c4e6e1ca2b26754fa44fa8668e0ee` (reference)
and `c4f5b5087c7620ae2e69f897fd3ccbc993706592abc5f45b11a04eda10fddc3c`
(transcribe). No library sources were patched or private APIs accessed.

Both decode the identical verified FP16 file and the same five inputs used by
the Q8 comparison: generated silence, white noise, tone, invented offline
Daniel speech, and the same speech at gain 0.001. Each runs with the previous
empty OFF prompt and vocabulary ON prompt, for 20 runs total. Decoding settings
and the documented cross-runtime differences are unchanged. This is a fixed
hypothesis test; no input was removed and no threshold was tuned after results.
The earlier Q8 results are reused, not rerun or cherry-picked.

The diagnostic runner now permits a nonempty selected model manifest with unique
explicit IDs. This allows the single FP16 variant without repeating the completed
two-model Q8 matrix. Existing Q8 manifests retain their prior derived IDs.
Application dependencies and catalog weights remain unchanged.

## Results

[reference-f16-results.csv](reference-f16-results.csv) retains all 20 successful
runs, raw transcripts, WER, exact-case term accuracy and public telemetry. The
scoring rules are unchanged from REFERENCE-RESULTS.md. The two runtimes each
produce nonempty raw output for all six non-speech conditions (three inputs,
OFF/ON). Both retain both speech controls in both conditions. No cleanup or
learning stage runs in this probe; these are raw runtime results.

The reference emits “you” on unprompted silence and a period on white noise and
tone. Its prompted non-speech outputs echo “Engine, Zephyr, fix/offline-dictation”.
Transcribe emits “Thank you.” on unprompted silence, periods on unprompted noise
and tone, and other invented text with the prompt. All failures remain in the
CSV. No-speech probabilities stay near 1e-10 on these inputs, similar to Q8.
The decoded speech controls have the same WER as their Q8 counterparts: reference
normal speech 0, reference quiet speech 0.25; transcribe normal/quiet speech 0.25.

**Q8 quantization is not the sole cause.** These examples fail with unquantized
FP16 weights in independent whisper.cpp as well as transcribe-cpp. Swapping
precision or exposing the same no-speech score cannot by itself provide the
requested safe guard. This does not prove the exact upstream cause or numerical
equivalence to an original FP32 PyTorch checkpoint.

A separate [Silero detector experiment](SILERO-RESULTS.md) then tests a possible
audio-based gate without changing the application. Its quiet-speech failures
prevent adopting that candidate. No threshold or phrase blacklist was added.

## Reproduction

Use the existing probes built as in REFERENCE-RESULTS.md. Put the pinned FP16
manifest in a new private reference directory as `models.json`, with the verified
model file and a copy of the reference probe as `reference-trace`. Then run:

```sh
CARGO_BUILD_JOBS=2 SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" \
  python3 docs/testing/transcription-439/run-reference-comparison.py \
  /tmp/tx439-kmesvcjt/evaluation \
  /tmp/tx439-kmesvcjt/trace-stress/manifest.json \
  /absolute/new/private/output \
  /tmp/tx439-kmesvcjt/reference-f16 \
  /tmp/tx439-kmesvcjt/whisper-backend-trace
```

The measured output directory is `/tmp/tx439-kmesvcjt/reference-f16/paired`;
`paired.log` records invocation status and elapsed time. The runner verifies
model/input hashes and creates a new output directory. The manifest and raw
stdout/stderr are retained. Invocation time includes loading and multiple clips,
not warmed microphone stop-to-final latency. No audio/context was uploaded,
no microphone was opened and no host or guest UI was operated.

Source checkpoint: `334bf358`, merging origin/main `5f2c9a38` while preserving
all changelog entries and #624's chat-control tests. Native probe builds remain
those recorded above; this is not a new native app build or native UI validation.

## Checks

All four checks passed on the merged source: TypeScript; Vitest 288 files /
3,368 tests; Clippy all targets with warnings denied; Rust 2,236 unit tests plus
6 CLI and 2 integration tests (18 ignored). Logs are
`/tmp/tx439-kmesvcjt/reference-f16/resumed-{tsc,vitest,clippy,cargo}.log`.
Rust ran after the FP16 inference workload finished. The earlier interrupted
check and failed transfers are retained; they are not counted as passing.
No microphone, Apple recognition, native UI or general human-accuracy acceptance
is established by these file-based results.

The subsequent [normalization experiment](SILERO-NORMALIZED-RESULTS.md) retains
quiet controls, but is not yet a production runtime integration or native acceptance.
