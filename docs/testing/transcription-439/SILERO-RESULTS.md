# Independent Silero gate experiment

This is a rejected diagnostic candidate, not an application dependency or a
shipped noise remedy. It follows the [FP16 comparison](F16-RESULTS.md), which
reproduced the noise failures without Q8 quantization. The experiment checks
whether a separate audio classifier can reject those inputs while preserving
speech. It adds public human controls rather than relying only on synthetic
voices. Neither public file audio nor synthetic audio proves microphone accuracy.

## Sources, licenses and isolation

- Silero VAD: `snakers4/silero-vad` commit
  `066409f3d9db45a30d21dfcbf9147826ffdd7052`, MIT, copyright 2020-present
  Silero Team. The ONNX model is 2,327,524 bytes, SHA-256
  `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`.
  The probe adapts its public state/context calling protocol; the required
  notice is retained in [silero-LICENSE.txt](silero-LICENSE.txt).
- [Free Spoken Digit Dataset](https://github.com/Jakobovski/free-spoken-digit-dataset),
  Jakobovski and contributors, commit
  `26eb9aaf76e81b692f806f9140c2d2777410d7a1`. Audio is licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  Every recording numbered 0 was selected before scoring: ten digits from
  each of six speakers, 60 files from the dataset's designated test split.
  No participant metadata was used beyond the public recording identifiers.
  Quiet variants multiply the decoded float samples by 0.03 or 0.001; this is
  a declared modification, not an original microphone recording at that level.
- [silero-sources.json](silero-sources.json) pins all public URLs, sizes,
  SHA-256 and Git blob hashes. Each source was checked against the pinned Git
  tree before use. The 64 files (model, upstream utility source and license,
  60 WAVs, dataset README) total 2,788,194 bytes. No audio or model is committed
  into this repository; downloaded fixtures remain under a private `/tmp` root.

ONNX Runtime 1.19.2 and NumPy 1.26.4 were installed as binary wheels in a
**disposable diagnostic venv**, with the resolved versions retained in
[silero-requirements.lock](silero-requirements.lock). There is no change to the
app's Cargo/pnpm manifests, runtime, engine catalog or packaged processes.
CPUExecutionProvider is explicitly selected with one intra/inter-op thread;
ONNX telemetry is disabled before creating the session. There is no network
inference, credential use, audio upload, microphone capture or app/store access.
Downloaded upstream Python utilities are inspected as reference, never executed.

## Method fixed before prediction

[silero-plan.txt](silero-plan.txt) records the method before the first pass.
Use the upstream documented 0.5 threshold and retain an input if **any** frame
scores at least 0.5. This minimizes extra duration-based speech rejection. It
is not Silero's complete timestamp segmentation algorithm; no minimum voiced
length, hysteresis, threshold tuning or gain normalization is added.

State resets for every input. Inference follows the public protocol: 512-sample
frames and 64 samples of preceding context at 16 kHz; 256/32 at 8 kHz. Only the
last incomplete frame is zero-padded. Public FSDD PCM16 is decoded to float32
without resampling; its original 8 kHz is supported by this model. The existing
synthetic/stress corpus remains 16 kHz with matching checksums.

Inputs: all 51 existing synthetic/stress files (48 speech, 3 generated
non-speech), plus the 60 public human clips at gains 1, 0.03 and 0.001: 231
inputs total. No files were screened by detector score or removed afterward.

## Complete results

[silero-results.csv](silero-results.csv) retains every frame summary, input
PCM hash and failure. These are VAD recall observations, not recognition WER.

| Group | Speech inputs | Retained | Rejected |
| --- | ---: | ---: | ---: |
| Existing synthetic and quiet controls | 48 | 46 | 2 |
| Public human digits, original amplitude | 60 | 59 | 1 |
| Public human digits, gain 0.03 | 60 | 27 | 33 |
| Public human digits, gain 0.001 | 60 | 0 | 60 |

The three non-speech inputs were all rejected: maximum scores were 0.00891 for
silence, 0.03633 for white noise and 0.06249 for tone. That benefit is insufficient:
96/228 known-speech inputs were also rejected. Many very quiet human variants
may also challenge ASR; no claim is made that all 96 would transcribe correctly.

There are two direct, already measured ASR counterexamples. The rejected
`daniel-literal-gain-0.001` and `daniel-legitimate-gain-0.001` are correctly
recognized by **both** catalog Whisper models in the earlier OFF/ON telemetry:
“Document what scratch that means.” and “Thank you for reviewing this change.”
See [whisper-telemetry.csv](whisper-telemetry.csv). Gating those existing correct
transcripts would lose speech. No repeat ASR run was needed to establish this.
The one original-amplitude human miss, `2_yweweler_0`, is 0.274875 seconds long,
with maximum detector score 0.42627; its published label is speech, but it was
not separately ASR-scored here.

The checked-in probe reproduced all 231 input hashes and every prediction
exactly in a second pass after its paths were made explicit CLI arguments.
Only timing fields differed. The original and reproduction CSVs remain in the
private evidence directory; the checked-in CSV is the first complete pass.
Elapsed columns are diagnostic per-input work, not microphone stop-to-final
latency or a production performance guarantee.

## Reproduction

Use only an isolated venv and new private fixture/output directories:

```sh
python3 docs/testing/transcription-439/fetch-silero-fixtures.py /absolute/new/private/fixtures
python3 -m venv /absolute/private/venv
/absolute/private/venv/bin/python -m pip --isolated install \
  --index-url https://pypi.org/simple --only-binary=:all: \
  -r docs/testing/transcription-439/silero-requirements.lock
/absolute/private/venv/bin/python docs/testing/transcription-439/probe-silero.py \
  /absolute/new/private/fixtures \
  /tmp/tx439-kmesvcjt/evaluation \
  /tmp/tx439-kmesvcjt/trace-stress/manifest.json \
  /absolute/new/private/results.csv
```

The checked-in fetcher verifies size, SHA-256 and Git blob identity before
writing each file. The probe independently checks source/input SHA-256, rejects
invalid audio and refuses to overwrite results. It needs the earlier generated
synthetic/stress manifests, not private user recordings.

Evidence root: `/tmp/tx439-kmesvcjt/silero-probe`. Retain `PLAN.txt`, `sources.json`,
`results.csv`, `reproduction.csv`, `probe.log`, `reproduction.log`, `install.log`
and the private fixture directories. Source/probe syntax and the 231 unique
result rows were verified. The application's four checks passed as recorded in
F16-RESULTS.md; those checks do not establish model acceptance.

## Decision and remaining needs

Do not integrate this gate or its runtime. The observed quiet-speech loss fails
the task's preservation constraint, even with the conservative any-frame rule.
No threshold, normalization or smoothing was tuned on these results. The prior
Earshot rejection also remains valid. This does not rule out every possible
VAD preprocessing/segmentation design; any such design needs fresh held-out
controls and a separately justified integration plan within the app's runtime
constraints.

The remaining engineering problem is a validated speech/non-speech decision,
not a missing wrapper accessor or a model precision switch. The human files
broaden falsification controls but are short English digits from six speakers,
not a representative microphone/ambient-noise acceptance set. Intentional
user microphone samples and consent-dependent Apple native observations remain
separate requirements. No native consent or computer-use boundary was bypassed.

A separately planned [normalization follow-up](SILERO-NORMALIZED-RESULTS.md)
uses a fresh recording split. It does not erase this raw-gate failure.
