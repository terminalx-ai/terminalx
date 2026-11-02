# #439 native and synthetic recognition results — 2026-10-24

**Acceptance remains open.** These are actual local recognizer outputs on
invented, synthesized speech, not the user's voice or microphone accuracy.
The complete unfiltered rows are in [synthetic-results.csv](synthetic-results.csv)
and [learned-results.csv](learned-results.csv). No failing sample was removed.

## Provenance and scope

- macOS 27.0 (26A428), installed offline `say` voices Samantha and Daniel,
  165 words/minute. Eight invented sentences per voice (the seven checked-in
  lines plus “Open the paraquet files”), generated directly to WAV with no
  playback or microphone capture. Three deterministic five-second non-speech
  files: digital zero, uniform noise ±0.02 (seed 439), and a 440 Hz tone at 0.05.
- Inputs: 16 kHz mono f32le; speech padded with 250 ms zeroes at each end.
  [synthetic-provenance.json](synthetic-provenance.json) records all input hashes
  and the exact pinned model URLs, sizes, SHA-256 and licenses from `catalog.rs`.
  Every model passed size/hash verification. The private cache is
  `/tmp/tx439-kmesvcjt/evaluation/models`: 2,857,032,256 bytes total. Parakeet was
  copied from the existing public weight file and reverified; the other four
  were fetched from the pinned catalog URLs. No user model was overwritten.
- Native UI: prepared source `ec423d66bf96bd072516a7ba23e20b21aa31c40e`, bundle
  `com.terminalx.next.dev.dictation439`, binary SHA-256
  `ab0461e233a01807d2e462a004b76937ad4e89aefadd9a2cf704fe6ed0020f8d`.
  Private launcher/environment and signature were reverified before launch.
  Only PID 25542 was targeted. It was verified by executable path, stopped,
  and confirmed absent afterward. **Desktop slot released for #232.**
- The native UI binary predates the learning fix below. The post-fix Rust test
  executable hash is `aec3c727fdca65d57975bec298b4e29390425e8acc81a7dc7c77e049c9d0910e`.
  No later source revision is falsely attributed to the old app bundle.

## Paired recognition

The existing real-model harness now supports a bounded matrix, an untimed
warmup on each identical input, raw/final scores, and context compilation time.
285 pairs cover every combination of five engines, 19 inputs and three modes:
context-only, dictionary-only, and combined hints/cleanup. OFF always uses the
original default run options. Dictionary-only includes the predetermined
`paraquet`/`parquet` pronunciation aliases for Parakeet; it is not solely model
biasing. Every row retains actual bias terms and raw versus final output.

Macro term accuracy averages the eight term-bearing speech rows, case-sensitive:

| Engine | OFF | Context-only raw | Dictionary final | Combined final | Combined warm total median |
|---|---:|---:|---:|---:|---:|
| Parakeet | 25% | 25% | 25% | 25% | 67 ms |
| Nemotron | 12.5% | 12.5% | 25% | 25% | 72 ms |
| Canary | 12.5% | 12.5% | 25% | 25% | 68 ms |
| Whisper Small | 12.5% | 25% | 75% | 75% | 299 ms |
| Whisper Turbo | 25% | 56.25% | 75% | 75% | 1,063 ms |

These are small synthetic-corpus measurements, not statistical proof of general
improvement. The unsupported hint engines correctly retained identical raw text
in context-only mode. Combined cleanup median cost was 0.8–1.45 ms. “Warm total”
is inference plus deterministic cleanup on a file, **not microphone stop-to-final**;
it excludes capture, IPC, UI insertion and hardware buffering. No latency
claim is made for those paths.

CSV WER is against the desired **written** reference. Long spoken code grammar
and retakes intentionally collapse to short written forms, so OFF target WER
can exceed 1.0. It is not presented as conventional verbatim speech WER.
Raw and final columns permit rescoring against either reference; the original
spoken scripts are retained in the provenance file.

### Failures retained

- Whisper Small context-on emitted `TranscriptionTab.tsx, refreshDictationEngine`
  on digital zeroes; dictionary/combined emitted a near-prompt list on noise.
- Whisper Turbo emitted `Transcription by CastingWords` on zeroes and some
  noise runs. A combined tone run emitted `. probability subscribe CT but constance`.
- Parakeet, Nemotron and Canary returned empty text for all three non-speech
  inputs in all modes. Whisper fallback output varied across repeated identical
  non-speech inputs; every baseline remains in the CSV rather than being selected.
- Digital zeroes are already refused by the application's capture guard; these
  direct-engine tests deliberately bypass it. Nonzero noise/tone hallucinations
  remain a real unresolved quality gap. No phrase blacklist or unvalidated
  acoustic cutoff was added to hide the failure or delete legitimate speech.
- Several recognizers rendered “scratch that” as “scratched at”; conservative
  cleanup left that uncertain text unchanged. Both legitimate “thank you”
  samples were retained rather than blacklisted.

The high-level `transcribe-cpp 0.2.3` Transcript exposes no no-speech probability.
Its C backend has chunk traces, but the Rust session pointer/accessors are
private. The existing Whisper skip gate combines no-speech probability with
average log probability; changing that threshold also changes fallback decoding.
A validated noise guard / safe trace exposure remains required, rather than
unsafe private-layout access or tuning a phrase filter to these 19 inputs.

## Learned corrections and demonstrated repair

Actual Samantha recognition supplied three lexical errors: Nemotron `paraquet`,
Canary `Parraquet`, Whisper Small `Parake`. Correcting each to `Parakeet` while
removing the final period was previously rejected as two edits. The repair
compares normalized lexical tokens first, so surrounding case/punctuation
changes do not count as extra word changes. It still requires one real bounded
word substitution, at least three words, and rejects case/punctuation-only,
multiword and secret-like edits. A regression assertion covers the observed case.

The native persistence/learning function accepted each of those three pairs
exactly once. Parakeet and Turbo already produced Parakeet and correctly learned
nothing. Forty held-out Daniel rows were evaluated both before and after the
repair; both sets are retained. Whisper Small's `Periket` became `Parakeet` via
its learned vocabulary hint. Canary's `Pericay`, Nemotron's `periquet`, and
Parakeet's `Peroquet` were not exact learned pairs and stayed unchanged. Whisper
Small also regressed a file-name row to `transcription tab.tsxandictationtext.ts`;
that row is included. This is backend learning from observed ASR plus file
recognition, **not** a claim that a user's successful-send edit was exercised.

## Context privacy and native UI

[context-measurements.json](context-measurements.json) records a real disposable
100-file walk (3,132 µs), local prepare (3,246 µs), remote-off (84 µs), and
sensitive prepare (23 µs). No ignored-file name or unlabelled pasted draft word
reached the prompt. Both suppressed requests had empty bias lists. Per-row
compiler time in the model matrix was at most 100 µs. These are backend gates,
not fabricated native diagnostic screenshots.

Using the installed computer-use/terminalx-cli skills and supported PID targeting:

- Opened Settings → Transcription; observed all personalization switches off.
- Imported ON.json through the native picker; verified terms and enabled switches.
- Edited a dictionary pronunciation through focused text input and Save; verified
  the native persisted JSON. AXSetValue was unverified/value_mismatch, so a
  supported focused text-input action was used and then independently checked.
- Opened an invented disposable project (no agent started), enabled project
  context, and verified the Settings test selected that project. Remote context
  stayed off. No real prompt was submitted and no agent powers were changed.
- Attempted to import a genuinely learned entry for learned-list/removal testing.
  The picker failed with `window_not_focused`; the one restored retry returned:
  `--restore-window was requested but the target is still not focused; bring it
  forward manually or check Accessibility permissions`. No workaround was used.
  Thus learned-list removal was **not** established by this native pass.

Apple's genuine SFSpeechURLRecognitionRequest was attempted with on-device-only
recognition on the synthesized file. Authorization status was 3, recognizer
available=true and supportsOnDeviceRecognition=true, but the request returned:

```
kLSRErrorDomain Code=201 "Siri and Dictation are disabled"
```

The reproducible [file probe](apple-file-probe.swift) uses the platform URL
recognition request with on-device recognition required; it never opens a mic
or asks for authorization. Compile it with `xcrun swiftc`, then pass a newly
generated WAV path and optional bias terms. Its error exit is nonzero.
No system setting was changed or permission dialog answered. See Apple's
[request documentation](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest)
for the on-device requirement and
[authorization status](https://developer.apple.com/documentation/speech/sfspeechrecognizer/authorizationstatus()).
Audio inventory listed only LG display output and Mac mini speakers: **no
microphone or loopback input**. No driver was installed and no ambient audio or
existing recording was accessed. Apple microphone, partial deletion, native
raw/final diagnostic capture, and successful-send learning remain untested.
Cloud-off/sensitive diagnostics are backend-only evidence, with no cloud context.

## Reproduction, logs and remaining acceptance

Private inputs, manifests, raw per-pair JSON and logs are under
`/tmp/tx439-kmesvcjt/evaluation/`. Main logs: `matrix.log`, `learn.log`,
`learned-matrix.log`, `learn-fixed.log`, `learned-matrix-fixed.log`, `context.log`,
`apple-file-probe.log`, `cargo-test-repaired.log`, `clippy-repaired.log`, `tsc.log`
and `vitest.log`. `ui-*.json` records each native action and its verification.
Do not publish unrelated filenames that macOS pickers included in their trees.

The generator downloads nothing and verifies each supplied model inventory:

```sh
python3 docs/testing/transcription-439/generate-synthetic.py \
  /absolute/new/private/corpus /tmp/tx439-kmesvcjt/evaluation/models.json
```

It was actually rerun: 18/19 fixtures were byte-identical; Daniel's project line
varied in the platform synthesizer. The original canonical PCM files and their
hashes are retained so comparisons can reuse exactly the tested inputs rather
than assuming the installed voice is bit-deterministic.

Run the matrix from `src-tauri` with fresh private state and `TX_DICTATION_EVAL_MANIFEST`
pointing to the generated `matrix.json`, using `CARGO_BUILD_JOBS=2` and SDKROOT
from xcrun, as in HANDOFF.md. Select
`transcription::evaluation::real_model_matrix -- --ignored --exact`.
The `observed_corrections` ignored test takes before/after/outputPath rows; the
`context_measurement` ignored test takes `TX_CONTEXT_REPORT`. None discovers
recordings or reads user history. Output paths must be new.

All four required checks passed after the learning repair: TypeScript; Vitest
287 files / 3,353 tests; Clippy with warnings denied; Rust 2,214 unit tests plus
8 integration tests. The real-model and learning measurements ran explicitly;
they are ignored in ordinary tests. Green execution means valid measurements,
not a pass for recognition quality. Further UI validation must use a coordinator-assigned guest; no more host GUI
work is planned and neither existing guest lane was touched. Auto-merge remains off, nothing was pushed,
and no acceptance-complete PR or issue closure is justified yet.
