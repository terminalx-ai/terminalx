# Independent voice detector experiment

This is a rejected candidate, not a production fix or microphone acceptance.
Application source remains at `b48618e1901ecefb43f7e2cc9039396bb5c74da5`;
subsequent commits add evidence only. No application dependency or decoding
behavior changed. The isolated guest app remains stopped and its lane released.

## Candidate and provenance

[Earshot 1.2.2](https://github.com/pykeio/earshot) is a Rust voice activity
detector with embedded weights, licensed MIT OR Apache-2.0. The standalone
probe pins the crates.io package in its own Cargo.lock, checksum
`afea66474c4036a7e5fa4b072a3b0a09cd0b01f00134da3115d76b7cc5899f03`.
The downloaded crate is 55,707 bytes. Default features require no additional
runtime, model download or dependency. It is not added to TerminalX's manifest.
The probe uses the public `Detector::default` and `predict_f32` APIs; no
upstream implementation or weights are copied into the repository.

Inputs are the same 19 invented offline Samantha/Daniel and generated
silence/noise/tone fixtures used by the recognition evaluation, plus 32 quiet
speech controls (gains 0.03 and 0.001). See [GUEST-RESULTS.md](GUEST-RESULTS.md)
for their generation, checksums and recognition results. No microphone,
private recording, network inference, account or credential was used.

Before inspecting results, the probe fixed the documented score threshold at
strictly greater than 0.5. It uses a fresh detector for each 16 kHz mono f32le
input, 256-sample frames and zero padding of the last incomplete frame. A
conservative proposed gate would retain any clip with at least one voice
frame. No thresholds, minimum frame counts or input gains were tuned afterward.

## Complete results

[vad-results.csv](vad-results.csv) retains every one of the 51 inputs, including
failures. Frame counts are observations, not word error rates.

| Input group | Clips | Clips retained by any-voice rule |
| --- | ---: | ---: |
| Original speech, both voices | 16 | 16 |
| Speech at gain 0.03, both voices | 16 | 16 |
| Samantha speech at gain 0.001 | 8 | 8 |
| Daniel speech at gain 0.001 | 8 | 0 |
| Digital silence | 1 | 0 |
| Generated tone | 1 | 0 |
| Generated white noise | 1 | 1 |

White noise had 7/313 positive frames (maximum score 0.5727113). Silence had
0/313 (maximum 0.27532268); tone had 0/313 (maximum 0.445624). Eight of 48
speech controls were rejected, including quiet speech the recognizer can
decode. This rules out shipping this simple gate: it both loses speech and
retains a noise input that previously hallucinated. A minimum frame count
chosen to exclude these seven frames would be tuning on the observed failure,
not independent validation.

The final release-build pass took median 704 microseconds and maximum 1,220
microseconds per clip on the host. This measures detector construction plus
frame inference, excluding file loading and recognition. It is not microphone
stop-to-final latency. A second full pass reproduced every frame count and
score; timing naturally varied. Evidence is synthetic and small, so it cannot
establish general voice/noise accuracy even for the passing controls.

## Reproduction

First generate the evaluation corpus and quiet controls using the instructions
in GUEST-RESULTS.md. Keep the manifests outside the repository. Build the
standalone probe (the pinned dependency is fetched if absent):

```sh
CARGO_BUILD_JOBS=2 SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" \
  cargo build --release --locked \
  --manifest-path docs/testing/transcription-439/vad-probe/Cargo.toml \
  --target-dir /tmp/tx439-vad-target
```

Run only explicitly selected manifest inputs; this verifies their hashes before
reading audio. Adjust the two private paths to the generated evidence root:

```python
import hashlib, json, pathlib, subprocess
root = pathlib.Path('/tmp/tx439-kmesvcjt')
rows = json.loads((root / 'evaluation/corpus.json').read_text())
rows += json.loads((root / 'trace-stress/manifest.json').read_text())
for row in rows:
    assert hashlib.sha256(pathlib.Path(row['audioPath']).read_bytes()).hexdigest() == row['sha256']
with (root / 'vad-reproduced.tsv').open('x') as output:
    subprocess.run(['/tmp/tx439-vad-target/release/tx439-vad-probe',
                    *[row['audioPath'] for row in rows]], stdout=output, check=True)
```

The checked-in CSV records IDs rather than private absolute paths. The probe
outputs TSV with absolute input paths; retain it locally. Original logs and
outputs: `/tmp/tx439-kmesvcjt/vad-{initial,final}.tsv`, `vad-final-build.log`,
`vad-clippy-fixed.log`. The final standalone probe passes Clippy with all
warnings denied. An initial lint failure was repaired without suppressions.

## Remaining engineering decision

Neither the runtime no-speech score nor this independent detector's default
threshold supplies a defensible guard. A production remedy needs broader
held-out human speech and representative noise, particularly quiet speech,
and comparison against a reference Whisper runtime to distinguish model or
conversion calibration from runtime behavior. A bounded public-API telemetry
extension can expose evidence but cannot by itself repair these failures.
Do not claim silence/noise acceptance or replace this gap with a phrase blacklist.

## Repository checks

All four required checks passed again with this evidence change: TypeScript
`tsc --noEmit`; Vitest 288 files / 3,368 tests; Clippy all targets with warnings
denied; Rust 2,236 unit tests plus 6 CLI and 2 integration tests (18 ignored).
Logs remain at `/tmp/tx439-kmesvcjt/vad-app-{tsc,vitest,clippy,cargo}.log`.
The checked-in standalone probe also passed Clippy separately. These checks
verify software behavior; they do not establish recognition acceptance.
