# Native detector comparison — 2026-10-24

This report records the detector-only **prototype**. Subsequent production
integration and check results are in [PRODUCTION-DETECTOR.md](PRODUCTION-DETECTOR.md);
the issue is not acceptance-complete. Keep the application on transcribe-cpp 0.2.3. No microphone,
Apple recognition, guest UI or user-voice acceptance is established here.

## Runtime compatibility decision

The public transcribe-cpp 0.4.1 API supports Silero, but upgrading recognition
changes existing all-off output. Both comparisons used the same 19 saved inputs
and all five catalog weights, strict CPU selection and no personalization hints.
All calls completed; no failed input was dropped.

| Candidate | Inputs | Trimmed transcript differences |
| --- | ---: | ---: |
| 0.4.1 portable default | 95 | 4 |
| 0.4.1 with GGML_NATIVE=ON, matching 0.2.3 build posture | 95 | 2 |

The second comparison reused the unchanged baseline rather than rerunning it.
Its remaining changes were Parakeet's case formatting for `samantha-code` and
Whisper Small's generated-tone hallucination (`tax` versus `Oh`). The first also
changed Nemotron's `daniel-retake` and Canary's `daniel-learning`. All raw outputs
are retained in `runtime-compatibility.csv` and `runtime-compatibility-native.csv`.
No candidate is accepted as all-off compatible. No app dependency was upgraded.

## Model and inputs

The pinned F32 model is 1,241,056 bytes, SHA-256
`0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6`.
`native-vad-model.json` records its immutable public URL; `native-vad-lineage.json`
records its shared ONNX source lineage. Model and all twenty ESC-10 downloads
were verified before inference. They total 10,061,936 bytes. The 22 FLEURS source
files already present in the tagged upstream checkout total 11,346,888 bytes.
The source manifests contain licenses, attribution, input identifiers and hashes.

The preselected 161 inputs are the 51 previous controls, 24 generated noises,
22 public FLEURS speech recordings at gains 1, .03 and .001, and 20 ESC-10 fold-5
clips (first two lexical filenames per class). Every input was evaluated both
raw and peak-normalized, yielding 322 conditions. Normalization affects only the
detector copy. The ASR samples are unchanged. Threshold .5 and the rule to retain
an utterance if any frame crosses it were fixed before these runs.

ESC-10 resampling uses SciPy 1.13.1 resample_poly, 160/441, Kaiser beta 5, constant
padding, after a fixed .5 gain on every ESC input. The first preparer rejected
resampling overshoot before inference; its partial files/log remain. Speech
files are decoded without resampling. FLEURS is public human file speech, not
microphone evidence; eight clips were selected upstream for language-ID success.
This is a broadened control set, not an unbiased accuracy estimate.

## Measured detector results

| Normalized input group | Retained as speech | Rejected |
| --- | ---: | ---: |
| Existing synthetic/stress speech | 48 | 0 |
| Public multilingual speech and quiet variants | 66 | 0 |
| Generated noise controls | 0 | 27 |
| Public environmental clips | 2 | 18 |

The environmental false positives remain visible: `esc10-5-203128-A-0` (dog)
and `esc10-5-187979-A-21` (sneezing). Environmental labels do not establish that
no incidental speech occurs. There was no threshold adjustment, phrase blacklist
or removal of either failure. This experiment measures detector retention,
not recognition WER on the new human corpus.

The supported 0.4.1 native API matched the ONNX reference across all 322 conditions:
max frame difference 0.000018865, no threshold disagreements. Raw speech retention
was 46/48 synthetic and 41/66 public variants, documenting why detector-only
normalization matters. Native per-clip median was about 3.04 ms, p95 16.46 ms,
max 19.57 ms. Native and ONNX processes overlapped, so these are diagnostic
compute observations, not warmed microphone stop-to-final latency.

The detector-only adapter in `ggml-vad-prototype/` compiles against **public
GGML/GGUF headers and libraries from the unchanged 0.2.3 runtime**. It uses no
private transcribe structures, registry patches, alternate ASR backend, Python
runtime or ONNX dependency. Its complete 322-condition comparison also passed:
max difference 0.000023485, no classification disagreement. Full comparison is
`ggml-vad-parity.csv`; full per-frame results remain in the evidence directory.
The C++ graph is MIT-attributed to upstream; the prospective Rust wrapper
validates the exact model bytes before entering the native parser and copies
weights in memory, avoiding a path verification/read race.

An initial adapter bug used the row stride instead of element size for an
imaginary-spectrum view offset. It aborted on a short final batch of a long
clip. The failed binary, partial 156-row output and crash log are preserved;
this was an adapter defect, not an upstream/runtime result. The corrected run
completed all 322 conditions. A real-model C++ test built with address and
undefined-behavior sanitizers then passed 14 lengths across frame and batch
boundaries, output sentinels, intervening-utterance reset and invalid inputs.
The linked upstream GGML archives were not sanitizer-instrumented. The test
caller verifies the pinned model hash before executing it.

## Reproduction and limits

See `NATIVE-VAD-PLAN.md` for pinned sources and preparation commands. The new
`ggml-vad-prototype` Rust crate exercises supported `DEP_TRANSCRIBE_CPP_INCLUDE_DIR`
metadata and static linking to the application's exact 0.2.3 dependency. Its
checksum checks precede FFI; it rejects invalid/nonfinite input and incomplete
output. Neither loader nor computation errors are silence decisions. It is
standalone and is not a production dependency yet. The static Rust path also
completed all 322 conditions with no threshold disagreement and maximum frame
difference below 1e-4; `ggml-vad-rust-parity.csv` preserves every condition.
The checksum-rejection test and explicit real-model Rust boundary/reset test
both passed. Adapter Clippy passed with `--all-targets -- -D warnings` after
replacing a flagged byte-chunk iteration; the initial lint failure is retained.
Debug-profile execution is not a latency measurement.

Evidence is retained under `/tmp/tx439-kmesvcjt`; hashes are recorded in
`native-vad-evidence.json`. Earlier rejected Earshot, raw Silero, Whisper
no-speech thresholds and full-precision experiments are retained separately.
The guest remains stopped to avoid idle WindowServer load; no host GUI was used.

Next: wire the bounded detector into the application with explicit verified model
provisioning, disabled-path equivalence, unavailable/error diagnostics and
cancellation; then run current-head application checks and paired recognition
through the integrated path. Apple permission/input provenance, actual microphone
accuracy and remaining UI/send-learning paths are still open. The four application
checks last passed on `334bf358`; these new diagnostic tests do not replace them.
