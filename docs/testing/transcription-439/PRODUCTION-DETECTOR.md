# Production detector integration

Implementation checkpoint: **9d60f18c**. This is not an acceptance-complete
release. Apple/microphone evidence remains open. The detector prototype and its
complete negative controls remain in [NATIVE-VAD-RESULTS.md](NATIVE-VAD-RESULTS.md).

## Runtime and behavior

The app still uses transcribe-cpp **0.2.3**, with no recognition dependency
version change. A dedicated static crate compiles the attributed detector against
that runtime's public GGML headers/libraries. The only shared Cargo additions are
the optional macOS dependency and desktop feature; these were sent to #467 before
editing. Shared `src-tauri/build.rs`, runtime gating and pipeline contracts are
unchanged. The dedicated crate has its own build script. Fresh main was already
an ancestor when fetched before validation.

`noiseGuard` defaults off, including when reading older personalization exports.
The disabled branch precedes detector I/O, locking, allocation and inference.
Recognition receives exactly the existing PCM and run options. The detector runs
after recognition on a peak-normalized copy, using the fixed .5 threshold and
retaining the entire utterance if any frame crosses it. It neither segments nor
rewrites recognition audio. Only successful `noSpeech` suppresses final text.
Missing weights, invalid hashes, computation failure and unsupported paths keep
recognized text. The raw transcript remains visible in Test dictation.

The auxiliary 1,241,056-byte model is excluded from the recognizer chooser. Its
immutable revision, size and SHA-256 are compiled into the download catalog.
Settings offers explicit download, cancellation and deletion; recording never
downloads weights. Download bytes are bounded before writes, checked for exact
size/hash before rename, and cancellation is checked before committing. Network
connect/read timeouts bound stalled requests. No audio or context is uploaded.
Each enabled recording revalidates bounded model bytes before using cached weights;
native parsing uses the same verified in-memory bytes, not a second path read.

A recording owns a cancellation token. Finishing/clearing its state cancels that
token; workers check it before publishing final results. The detector checks cancellation
between CPU batches and recurrent frames and discards incomplete probabilities.
The existing recognizer itself is unchanged and is not claimed to have gained
inference cancellation. Detector state resets between utterances, including after
an interrupted call. Apple retains its native speech detection and reports the
auxiliary detector as unsupported; its partial text/insertion behavior is unchanged.

The Settings diagnostic adds detector status and elapsed microseconds. `noAudio`
means the pre-existing capture guard handled empty/short input, not that the
native detector ran. No new composer controls or shortcuts were added.

## Validation plan and preserved limits

`prepare-production-detector.py` verifies all source/model checksums and writes
explicit matrices without accessing the user model cache or discovering recordings.
The first production matrix contains every original sample on all five engines
(19 × 5), plus every preserved quiet control on both Whisper models (32 × 2):
**159 OFF/ON pairs**. ON enables only the noise guard. Each pair follows an untimed
ASR warm-up. This isolates detection from context, dictionary and learned repair,
whose separate evidence remains in the earlier reports.

The real application harness calls the production `Engine`, `NoiseGuard` and
`RunContext::finalize`. It uses explicit detector paths and never falls back to a
user store. Reports retain raw/final text, WER, term accuracy, statuses and timing.
`summarize-production-detector.py` includes missing/failed rows and checks raw
recognition equivalence, zero detector work when off, quiet-speech retention and
non-speech suppression. No test changes the threshold based on its results.

The broader detector comparison still has **two environmental false positives**:
dog and sneezing. Keep them visible; the guard is not a general noise guarantee.
The public multilingual corpus has selection limitations and the synthetic
utterances are not the user's voice or hardware-microphone acceptance. File
latency is only a stop-to-final proxy. All four required application checks passed on the production source: TypeScript,
289 Vitest files / 3,370 tests, Clippy with all targets and warnings denied, and
2,242 Rust unit tests plus six CLI and two integration tests (18 opt-in tests
ignored). Logs and hashes are in `production-detector-checks.json`. The native
suite exited successfully, observed by 14:18:47 UTC. Paired matrix results
were pending at that checkpoint; the replacement-worker measurements follow below.

The assigned guest remains stopped during host-only work. #232's conditional
quiet reservations are honored before starting any new model/build batch; an
existing required check is allowed to finish and its actual exit is reported.

The follow-up loader repair opens cache files without following symlinks or
blocking on FIFOs. Its disposable FIFO/symlink regression passes; all four
checks passed again (2,243 Rust unit tests), as did all three native detector
tests including recovery after cancellation. Exact log hashes are retained.

## Paired production results after recovery

Measured production source remains **4c85ecd6**, with documentation recovery head
**61eb29a6**. The existing candidate Rust test executable SHA-256 is
`4dc4364a152c045460cf34ba37a84fa4d988cae32c5d6023e2d30827b65ad8c4`.
No production source, recognition options, detector threshold or weights changed.

All **255 pairs completed without runtime errors**: the original 159 pairs plus
96 complementary quiet controls on Parakeet, Nemotron and Canary. Each engine
therefore sees the same 51 inputs: 16 base speech, 32 quiet speech, and three
non-speech controls. All weights, detector bytes and 51 PCM files were reverified
against their existing checksums. The 32 quiet files also exactly reproduce
their original PCM multiplied by the recorded gain and rounded to float32.
No recordings were discovered, captured or downloaded.

| Engine | Pairs | ON speech retained | ON non-speech suppressed | Raw OFF/ON mismatches | Speech with empty raw output in both arms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parakeet Unified EN | 51 | 48 | 3 | 0 | 0 |
| Nemotron Streaming | 51 | 48 | 3 | 0 | 5 |
| Canary 180M Flash | 51 | 48 | 3 | 0 | 0 |
| Whisper Small | 51 | 48 | 3 | 1 | 0 |
| Whisper Large v3 Turbo | 51 | 48 | 3 | 0 | 0 |

The unchanged strict summarizer reports **158/159** original pairs passing and
**96/96** additional quiet pairs passing: **254/255**, not a blanket pass. Every
OFF detector status is `disabled` with zero detector elapsed time. Every ON speech
result preserves its own raw recognition text, including empty recognition.
Five non-speech baseline outputs were nonempty; all 15 ON non-speech final outputs
were empty. These direct-engine tests bypass the existing capture silence guard.

The failing Small `tone` row has OFF raw “Please Remember To Subscribe My Channel”
and ON raw “It may be the pressure upon something toフ surplus”. ON correctly
reports `noSpeech` and returns empty final text, but raw equivalence fails.
The row is retained in [production-detector-results.csv](production-detector-results.csv).
The bounded same-condition follow-up is reported separately below; it does not
replace the original pair or relax the strict criterion.

Nemotron's five empty speech recognitions are all at gain .001:
`samantha-project`, `samantha-literal`, `daniel-identifier`, `daniel-retake`, and
`daniel-legitimate`. Detection retained them; it did not repair ASR accuracy.
These adverse rows and all other quiet results remain in
[production-detector-quiet-results.csv](production-detector-quiet-results.csv).
CSV WER still uses the desired written reference, including collapsed code and
retakes; it is not conventional verbatim-speech WER or proof of microphone quality.

The coordinator authorized serial host computation without a quiet reservation.
Each pair ran in a separate existing-binary test process, with the harness's
untimed identical-input warmup; model and detector handles are not reused across
pairs. `CARGO_BUILD_JOBS=2` and xcrun-derived `SDKROOT` were set per process, with
private TerminalX/Claude state directories. Timings include contention and first
enabled detector load and are **not performance acceptance**. The private runner
checks a pause sentinel between pairs so a coordinated pause loses no active pair.

Preparation is reproducible with the existing command for the 159-pair matrix and
`prepare-production-detector.py ROOT NEW_OUTPUT --quiet-only` for the disjoint
96-pair extension. Run each manifest through
`transcription::evaluation::real_model_pair --ignored --exact --test-threads=1`;
use new output paths and retain every exit/result. The audited runner, exact
manifests, stdout/stderr, original JSON reports and result hashes remain under
`/tmp/tx439-kmesvcjt/production-detector-*-execution` and the two matrix directories.

Scoped recovery checks passed on the existing candidate binary: five noise,
two engine, four context, one scorer and twelve personalization tests (**24**).
Actual preparation verified the original and extended selections; disjointness,
51 inputs per engine, unknown-option rejection and Python syntax also passed.
The four prior application suites were not rerun for evidence-only changes.
See [ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md) for remaining human/Apple/native
gaps and coordinator review gates. The broader dog/sneezing false positives remain
open; these 255 pairs do not turn the detector into a general noise guarantee.

### Bounded tone repetition control

After all 255 pairs finished, the coordinator authorized six additional pairs on
the exact Small tone input: alternate OFF/OFF and OFF/ON three times. Each pair
kept the original PCM, model, default recognition options and untimed warmup.
The only second-arm option difference was `noiseGuard`; OFF/OFF used empty
options and entries. No original matrix result was rerun or replaced.

All six calls succeeded. **3/3 OFF/OFF pairs differed in raw text**, with the
detector disabled and zero elapsed time in both arms. **3/3 OFF/ON pairs also
differed**, and every ON result was `noSpeech` with empty final text. Full text,
statuses and per-result hashes are in
[production-detector-tone-control.csv](production-detector-tone-control.csv).
For example, the first OFF/OFF pair emitted “Beeeeeeeee可 tai” then “BEEP”.

This demonstrates ASR variation even without detector execution, consistent with
the runtime's fallback sampling documented in GUEST-RESULTS.md. It does not prove
that all possible integration effects are absent or grant bit-identical raw
recognition. The original strict mismatch remains a failure. No detector tuning,
phrase filtering, dependency change or production fix was made from these rows.

[production-detector-recovery-evidence.json](production-detector-recovery-evidence.json)
records execution metadata, summaries, scoped checks and hashes of retained
private artifacts. The host compute slot was released after these controls;
the candidate host app and both guests were untouched.
