# Detector-only normalization follow-up

This is a diagnostic candidate, not a shipped filter or microphone acceptance.
The [raw detector experiment](SILERO-RESULTS.md) remains rejected. Its quiet-speech
loss motivated a new hypothesis: normalize only detector samples by their peak
absolute amplitude; leave all-zero input and ASR audio unchanged. Keep the same
Silero model, public state protocol, any-frame decision and 0.5 threshold.

## Protocol and complete evidence

[silero-normalization-plan.txt](silero-normalization-plan.txt) was written before
prediction. All 60 public FSDD index-1 recordings were selected, at gains 1, 0.03
and 0.001, without screening: 180 fresh human speech inputs. These are a fresh
recording split, not unseen speakers: the same six speakers appear in index 0.
All 51 earlier synthetic/stress inputs remain development regression controls,
explicitly not held-out evidence. Add 24 fresh generated non-speech controls:
seed 4391, five seconds each of white noise, impulses, hum, four single tones
and repeated chirps, at amplitudes 0.001, 0.02 and 0.5.

Each of 255 inputs runs both raw and peak-normalized, for 510 rows. State resets
between conditions. No threshold, segmentation or model is tuned. Every result,
including failures, input/detector hashes and elapsed time, is retained in
[silero-normalized-results.csv](silero-normalized-results.csv). The checked-in
probe reproduced all 510 predictions and hashes exactly; only elapsed time
changed. These timings are detector-only file processing, not stop-to-final latency.

| Group | Inputs | Raw retained | Normalized retained |
| --- | ---: | ---: | ---: |
| Synthetic speech, including quiet controls | 48 | 46 | 48 |
| Fresh public human digits, all three gains | 180 | 88 | 180 |
| Existing generated non-speech | 3 | 0 | 0 |
| Fresh generated non-speech | 24 | 0 | 0 |

Normalization retains all 228 speech controls and rejects all 27 non-speech
controls here. In particular it retains the two quiet synthetic sentences
previously recognized correctly by both Whisper models but rejected by the raw
detector. Existing ASR results establish that counterexample; ASR was not rerun
or modified in this experiment. Public digit retention measures detector recall,
not WER or guaranteed downstream recognition.

## Sources, isolation and reproduction

The same pinned Silero model, MIT attribution, CPU-only ONNX Runtime 1.19.2,
NumPy 1.26.4 and disposable venv as SILERO-RESULTS.md are used. No app dependency,
packaged process or runtime changes. The fresh manifest is
[silero-holdout-sources.json](silero-holdout-sources.json): every public file is
pinned by URL/revision, byte size, SHA-256 and Git blob hash. FSDD is by Jakobovski
and contributors, CC BY-SA 4.0, revision
`26eb9aaf76e81b692f806f9140c2d2777410d7a1`. Scaling and normalization are declared
modifications; no audio is committed. Attribution and license links remain in
SILERO-RESULTS.md; the Silero MIT notice is in silero-LICENSE.txt.

```sh
python3 docs/testing/transcription-439/fetch-silero-fixtures.py /absolute/new/private/holdout --holdout
/absolute/private/venv/bin/python docs/testing/transcription-439/probe-silero-normalized.py \
  /absolute/new/private/holdout \
  /tmp/tx439-kmesvcjt/evaluation \
  /tmp/tx439-kmesvcjt/trace-stress/manifest.json \
  /absolute/new/private/results.csv
```

Use the isolated venv installation instructions in SILERO-RESULTS.md. The probe
verifies hashes before inference and refuses to overwrite output. The earlier
synthetic/stress manifests are required. Private evidence is in
`/tmp/tx439-kmesvcjt/silero-probe`: NORMALIZATION-PLAN.txt, holdout-sources.json,
normalized-probe.py, normalized-results.csv, normalized-reproduction.csv and
normalized-probe.log. No user audio, credentials, microphone or UI was accessed.

## Integration boundary and next dependency

This is encouraging falsification evidence, not a sufficient production gate.
Short English digits and synthetic sentences do not establish recall for long,
multilingual, accented or naturally quiet speech. Generated tones/noise do not
establish rejection of real ambient noise, music or overlapping speech. Peak
normalization can amplify low-level noise; the limited controls do not prove
that harmless. Preserve the full failed raw experiment and earlier rejected VAD.

The current transcribe-cpp 0.2.3 public C API has no standalone VAD interface.
The independent whisper.cpp v1.9.5 reference does expose opaque VAD contexts,
`whisper_vad_detect_speech`, `whisper_vad_n_probs` and `whisper_vad_probs`, and
ships a Silero-to-GGML converter. Those are a concrete diagnostic comparison
route, not evidence that the current app runtime implements it. Its model format
and 16 kHz graph must be validated against the ONNX baseline; the 8 kHz public
files would require declared resampling and cannot silently be compared as
identical inputs. No registry source patch or private-layout access is proposed.

A production implementation would require a supported public detector extension
in the existing runtime, with pinned model provisioning and parity/recall checks.
Shipping the experimental Python/ONNX runtime or swapping the app's recognition
backend is outside the authorized constraints. No such change is included here.
Apple native consent and intentional microphone acceptance remain separate gaps.
