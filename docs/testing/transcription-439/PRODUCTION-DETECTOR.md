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
suite exited successfully, observed by 14:18:47 UTC. Paired matrix results are
still pending and will be recorded only after those processes finish.

The assigned guest remains stopped during host-only work. #232's conditional
quiet reservations are honored before starting any new model/build batch; an
existing required check is allowed to finish and its actual exit is reported.

The follow-up loader repair opens cache files without following symlinks or
blocking on FIFOs. Its disposable FIFO/symlink regression passes; all four
checks passed again (2,243 Rust unit tests), as did all three native detector
tests including recovery after cancellation. Exact log hashes are retained.
