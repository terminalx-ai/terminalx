# Whisper CPU/Metal comparison

This headless experiment isolates compute backend selection. It does not repair
the failure or provide microphone acceptance. Production source is unchanged
from `b48618e1901ecefb43f7e2cc9039396bb5c74da5`; the diagnostic probe adds an
explicit backend override using public transcribe-cpp 0.2.3 load parameters.
No new weights, inference runtime or application dependency were downloaded.

## Method and complete results

The same checksum-verified catalog Small and Turbo Q8_0 weights, five explicit
fixtures and OFF/ON prompts were used on strict CPU and strict Metal: 40 runs.
Inputs are generated silence, white noise, tone, offline Daniel saying “Open
the Parakeet files”, and that speech at gain 0.001. These are existing synthetic
fixtures, not human or microphone recordings. Provenance and hashes remain in
the manifests described in [GUEST-RESULTS.md](GUEST-RESULTS.md).

[backend-results.csv](backend-results.csv) retains all 40 raw transcripts and
every chunk's no-speech probability, average log probability and skip flag.
All runs returned success. Runtime introspection reported `CPU` for every CPU
load and `MTL0` for every Metal load; the strict requests cannot silently fall
back. Parameters other than backend selection are identical.

| Model | CPU non-speech outputs | Metal non-speech outputs | Speech controls retained |
| --- | ---: | ---: | ---: |
| Small | 5/6 | 5/6 | 4/4 on each backend |
| Turbo | 6/6 | 6/6 | 4/4 on each backend |

“Output” means any nonempty **raw** text, including punctuation. The app's
existing digital-silence and deterministic cleanup stages are not run by this
probe. These numbers therefore do not assert that every raw result reaches the
composer. OFF/ON here changes only the model prompt, not the application
settings. Term accuracy and WER remain in the original paired evaluation;
this experiment isolates a backend hypothesis rather than retuning those scores.

Small produced “you” on silence on both backends. With the prompt enabled,
both echoed the prompt on silence and produced text on white noise and tone.
Turbo produced “Thank you.” on silence without the prompt and “Transcription
by CastingWords” with it on both backends. Turbo's non-speech probabilities
remained approximately 5e-11 to 3e-10 on both backends. Some decoded wording
varied, particularly prompted white noise; the CSV retains those differences.

This rules out switching to CPU as a remedy for these examples. It does not
rule out a bug shared by both backends, model conversion or poor calibration.
The two retained speech controls are a narrow negative control, not general
proof of speech preservation. No probability threshold was adjusted.

A read-only inspection of the pinned Turbo GGUF found `no_timestamps_token_id`
50364 and vocabulary token 50363 equal to `<|nospeech|>`. The runtime derives
no-speech as `no_timestamps_token_id - 1`, so a simple Turbo token-offset
mismatch does not explain these results. The runtime reads the raw SOT-position
logits before filtering, the same conceptual position used by the
[OpenAI reference decoder](https://github.com/openai/whisper/blob/main/whisper/decoding.py).
This source comparison does not establish numerical equivalence to that runtime.

## Reproduction and evidence

Build `whisper-trace.cpp` using GUEST-RESULTS.md's existing static-library
command, optionally adding `-Wall -Wextra -Werror`. Then run:

```sh
python3 docs/testing/transcription-439/run-backend-comparison.py \
  /tmp/tx439-kmesvcjt/evaluation \
  /tmp/tx439-kmesvcjt/trace-stress/manifest.json \
  /absolute/new/private/output \
  /tmp/tx439-kmesvcjt/whisper-backend-trace
```

The runner verifies every model/input checksum, requires a new output directory
and retains stdout/stderr for each invocation. `TX439_TRACE_BACKEND=cpu` or
`metal` selects a strict backend in the probe; any other value returns exit 8.
Unset preserves default selection. The probe prints the actual backend to
stderr. The invalid-value negative check passed, and the probe compiled with
warnings denied.

Measured files: `/tmp/tx439-kmesvcjt/backend-parity/*.{out,err}` and
`manifest.json`; invocation timings are in `backend-parity.log`. Those timings
include model loading and five sequential transcriptions under concurrent test
load, so they are **not** warmed stop-to-final latency measurements. Earlier
setup errors (an incorrect fixture ID and use of a Python API unavailable in
system Python) were fixed before inference; their logs remain in the evidence
root. No recognition result was omitted because it failed.

The supported public-API comparison still leaves a cross-runtime/model
comparison outstanding. A reference run needs compatible, pinned reference
weights and a separately isolated reference implementation. Repackaging the
existing GGUF without validating tensor mappings would introduce another
uncontrolled conversion. Neither a wrapper telemetry extension nor forcing CPU
is a demonstrated fix. Apple/TCC and real microphone gaps are unchanged.

## Reproduction pass and checks

The checked-in runner completed another 40 runs with zero runtime failures.
[backend-reproduction-results.csv](backend-reproduction-results.csv) retains
that complete second pass. The table's nonempty-output counts and all speech
control transcripts were unchanged. Six noise/tone transcripts changed wording,
so this is not a claim of byte-deterministic decoding; the default runtime's
fallback sampling remains enabled. Both passes are kept without selecting the
more favorable output. Full second-pass files are in
`/tmp/tx439-kmesvcjt/backend-reproduction`, with `backend-reproduction.log`
in its parent directory.

All four required checks passed again: TypeScript `tsc --noEmit`; Vitest 288
files / 3,368 tests; Clippy all targets with warnings denied; Rust 2,236 unit
plus 6 CLI and 2 integration tests (18 ignored). Logs are
`/tmp/tx439-kmesvcjt/backend-{tsc,vitest,clippy,cargo}.log`. These results do not
close recognition or native microphone acceptance. No guest or host GUI was
launched; the previously released desktop and guest lanes remain released.
