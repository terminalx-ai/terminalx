# Dictation personalization references

TerminalX's offline dictation personalization is an independent Rust and
TypeScript implementation inspired by [Juno](https://github.com/Cassini-Research/Juno),
Cassini Research's MIT-licensed local voice layer. No Juno source code, word lists,
model weights, or data files are included in this implementation.

The primary-source design references consulted were Juno's
`juno_v2/memory/correction_diff.py` (safe attribution of edits to inserted text)
and `juno_core_v3/dictation/self_corrections.py` (unambiguous spoken retakes).
TerminalX uses stricter whole-word substitution and exact repeated-phrase rules,
rather than porting Juno's fuzzy matching algorithms. It does not embed Juno's
Python runtime or writer model.

The optional native noise detector adapts the MIT Silero graph from
[transcribe.cpp v0.4.1](https://github.com/handy-computer/transcribe.cpp/tree/4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b).
It compiles against the unchanged transcribe-cpp 0.2.3 public GGML API. Copyright
and full notices for transcribe.cpp and the Silero protocol are retained in
`src-tauri/src/transcription/native-detector/` and `THIRD-PARTY-NOTICES.md`.
Detector weights are pinned, checksum-verified and separately downloaded; their
provenance and evaluation limitations are recorded under
`docs/testing/transcription-439/`. No Juno, Python or ONNX runtime is embedded.
