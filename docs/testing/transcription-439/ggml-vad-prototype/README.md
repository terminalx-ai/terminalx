# Static detector adapter prototype

This standalone diagnostic crate uses transcribe-cpp **0.2.3**, the unchanged
application runtime. Its build script obtains installed GGML headers through
public Cargo metadata and compiles a static C++ adapter; no registry source is
patched. There is no second recognition engine, Python/ONNX runtime or subprocess
in this Rust path. It is not yet a production dependency.

Run in disposable app/config directories, with `CARGO_BUILD_JOBS=2` and
`SDKROOT` from `xcrun --sdk macosx --show-sdk-path`:

```sh
cargo test --manifest-path docs/testing/transcription-439/ggml-vad-prototype/Cargo.toml --locked
TX439_VAD_MODEL=/absolute/verified/model.gguf cargo test --manifest-path docs/testing/transcription-439/ggml-vad-prototype/Cargo.toml --locked -- --include-ignored
cargo run --manifest-path docs/testing/transcription-439/ggml-vad-prototype/Cargo.toml --locked -- /absolute/manifest.json /absolute/new-results.jsonl
```

The manifest is produced by `../prepare-native-vad-inputs.py`. All source audio
and detector copies are hashed; output is create-new. The wrapper additionally
pins the exact detector hash internally before native parsing. Errors never count
as rejected speech. Normalization is detector-only, with a fresh recurrent state
per utterance and a single CPU thread.

`boundary-test.cpp` is a real-model C++ sanitizer test. It must receive the same
checksum-verified detector model. Its regression lengths include 257 and 261
frames to cover the initial short-final-batch view-offset failure. The parent
results document records both the failed prototype and the passing repair.

The graph and model layout are adapted from MIT transcribe.cpp v0.4.1
(commit `4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b`); see
`LICENSE.transcribe`. Silero model protocol attribution is in
`../silero-LICENSE.txt`. Exact model/source licenses and pins are in the parent
manifests. The decoder/recognition runtime remains unchanged.
