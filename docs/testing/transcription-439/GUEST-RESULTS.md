# Assigned guest validation and Whisper telemetry

Acceptance remains open. This follow-up tested the repaired implementation after
merging current main, including #567, at source
`b48618e1901ecefb43f7e2cc9039396bb5c74da5`. No existing commits were rewritten.

## Exact native artifact and isolation

- Guest: `local:terminalx-cua-macos`, macOS 26.5.2 (25F84), arm64.
- Artifact: guest `/tmp/tx439/TerminalX Dictation 439.app`.
- Executable SHA-256: `3ee9d8f37359898b22d4e4124a92b557980922a05e33e5a2868f01b44ca1c6f2`.
- Rebuilt using the documented debug packaging command in NATIVE-BUILD.md,
  jobs=2 and xcrun SDKROOT; ad-hoc hardened-runtime signing with the repository
  entitlements. Signature and executable hash verified on both machines.
- Unique bundle `com.terminalx.next.dev.dictation439`; no URL schemes, helper
  omitted. Launcher uses `env -i`, private HOME/config/stores under `/tmp/tx439`,
  and keychain service `dev.terminalx.dictation439.guest-b48618e1`.
- Only explicit app/fixture archives and the Apple probe were transferred.
  Fake Claude is the repository's `scripts/remote-runtime/fake-claude`, copied
  to the private PATH. Its version and running executable paths were verified.
  No real accounts, recordings, agent services or cloud workspaces were used.
- Native app PIDs 13800 then 14302 were verified before termination. Final
  app and fake-agent PIDs 14302, 14811 and 14814 were confirmed absent.
  The guest remains running; our desktop work is finished and the lane is
  released to the coordinator. No host GUI or #232 guest was accessed.

## Native UI results

The bundled CUA 0.38.0 guide and schemas were read. Actions used the named
sandbox's MCP endpoint and exact app PID/window; observation and input were
combined using `run_script` where the capture must share a connection.

Passed, with actual local persistence independently read back:

1. Settings → Transcription initially had personalization off.
2. Imported ON settings plus the genuinely backend-learned `paraquet → Parakeet`
   entry from the preceding synthetic evaluation. Context/project/dictionary/
   learning switches and all six entries persisted; remote context stayed off.
3. The learned entry appeared in Settings. Removing its row left zero learned
   entries in the store. This proves display/removal of an imported learned
   entry, not automatic learning after a user's dictated send.
4. Edited `TranscriptionTab.tsx` to add “transcription tab” as its pronunciation.
   Focused text input, Save, visible readback and saved JSON agreed. Direct
   AXValue setting had not persisted; that earlier attempt is not counted.
5. Started a disposable quick chat using the verified fake agent and sent the
   typed sentence “Open the Parakeet files.” It appeared in the conversation;
   the private fake transcript independently contained both the user message
   and the fake assistant echo.
   No learned entry was created from this typed-only message (negative control).
6. Expanded Sensitive tabs and excluded that fake chat. Its actual tab ID
   persisted in `sensitiveTargets`; `remoteContext` remained false.

The native picker initially resisted Go to Folder keyboard actions because its
sheet was a different key window. Wrong-window delivery was refused; no refusal
was bypassed. A test-specific initial-folder preference,
`NSNavLastRootDirectory=/tmp/tx439/transfer`, was set only for this disposable
bundle, followed by restarting our app. Selecting List view and the exact JSON
file then completed the real import through the picker. No TCC/global security
preference was altered. Raw logs retain failed and successful attempts.

## Remaining native limits

The genuine Apple file probe returned authorization status 0 (`notDetermined`),
available=true and supportsOnDeviceRecognition=true. It exited 3 before opening
the input or requesting permission. This is distinct from the host's earlier
Code 201 result. Enabling OS Dictation does not establish app speech consent;
no TCC prompt was answered or bypassed.

The guest lists an Apple Virtual Sound Device with input and output. Its input
source is not proven to be an invented fixture rather than a forwarded input,
so no recording was started. No driver was installed. Live microphone accuracy,
Apple partial deletion, native raw/final recognition diagnostics, and automatic
learning after a dictated successful send remain unverified. Ordinary fake-agent
sending and imported-entry removal do not substitute for those rows.

Post-merge native backend context evaluation passed separately: 100-file walk
3,452 µs, local preparation 3,581 µs, remote-off 37 µs and sensitive 20 µs.
Remote-off/sensitive lists were empty; ignored-file and pasted-word assertions
passed. This is backend privacy evidence, not native diagnostic-panel evidence.

## Public runtime telemetry investigation

[whisper-trace.cpp](whisper-trace.cpp) is a diagnostic executable, **not shipped
or called by the app**. It uses only the installed runtime's public C interfaces:
model/session lifecycle, default run parameters, Whisper prompt extension, and
`transcribe_get_whisper_chunk_count` / `transcribe_get_whisper_chunk_trace`.
It neither accesses private Rust layouts nor changes decoding thresholds.
Model weights and canonical inputs are the verified files in NATIVE-RESULTS.md.

[whisper-telemetry.csv](whisper-telemetry.csv) preserves all 204 input runs and
205 chunk traces: two Whisper models, OFF/ON, the original 19 inputs plus 32
quiet-speech controls. The latter multiply each of the 16 original speech
waveforms by 0.03 and 0.001, preserving duration, words and padding. These are
synthetic amplitude stress tests, not human microphone recordings. Raw stdout,
stderr, fixture hashes and PCM remain under `/tmp/tx439-kmesvcjt`.

The probe reports each full output as UTF-8 hex, then every chunk's window,
no-speech probability, average log probability and runtime skip decision.
All runs succeeded; fallback sampling remains the runtime default and is not
claimed bit-deterministic. Neither failures nor adverse speech rows were removed.

| Input | Small OFF no-speech | Small ON no-speech | Turbo OFF no-speech | Turbo ON no-speech |
|---|---:|---:|---:|---:|
| Zeroes | 0.937230 | 0.608263, 0.866325 (two chunks) | 1.57e-10 | 2.55e-10 |
| White noise | 0.849259 | 0.441573 | 8.60e-11 | 2.28e-10 |
| Tone | 0.585292 | 0.331525 | 5.47e-11 | 1.96e-10 |

A standalone `no_speech > 0.6` post-filter would still retain nonempty output
on three of six Small noise rows and all six Turbo noise rows. It would also
remove a real quiet-speech result: Daniel's learning sentence at gain 0.001
produced “Open the Perique files.” with no-speech 0.609917 and average log
probability -0.725635. The runtime's combined gate retained it. A no-speech-only
filter is therefore **not validated**, even on this bounded corpus.

This does not establish why Turbo's probabilities are so small. It could involve
model conversion, runtime behavior or model calibration; calling it a proven
runtime bug would exceed the evidence. Pure threshold tuning or a phrase
blacklist would hide known failures and risk deleting legitimate speech.

### Concrete implementation options

1. **Small, bounded telemetry extension:** add an owned `WhisperChunkTrace`
   vector to the Rust wrapper result, copying public C trace structs while its
   session is alive. Test non-Whisper/empty results, multi-chunk ownership and
   repeated runs. Pin the reviewed upstream release or an explicitly maintained
   wrapper fork. No C ABI/private-layout change or new process is needed.
   This makes gated guards observable; the measurements above show it is not
   itself a sufficient noise fix.
2. **Recommended quality work:** validate an independent local speech-activity
   detector before recognition, with a pinned model/license/checksum and a
   held-out speech/noise corpus. Integrate it in-process, opt-in under guards,
   preserving all-off behavior. Measure quiet/short speech, accents, languages,
   stationary and transient noise, and onset/ending clipping before selecting
   an operating point. This adds a dependency/model asset and needs more than
   the current 19 synthetic inputs; no model or threshold has been silently
   selected or represented as validated.
3. Independently compare Turbo telemetry on the same public inputs with the
   model's reference runtime to isolate a conversion/runtime defect before
   accepting a dependency fix. The public C probe is ready for that comparison.

### Reproduce the telemetry

Compile the checked-in probe against the same pinned crate and existing static
build artifacts (these paths are from the measured worktree):

```sh
TX_TRANSCRIBE_SRC="$HOME/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/transcribe-cpp-sys-0.2.3"
TX_TRANSCRIBE_LIB=src-tauri/target/debug/build/transcribe-cpp-sys-aba44c4c31433cd2/out/lib
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" xcrun clang++ -std=c++17 \
  docs/testing/transcription-439/whisper-trace.cpp \
  -I "$TX_TRANSCRIBE_SRC/include" -L "$TX_TRANSCRIBE_LIB" \
  -ltranscribe -lggml -lggml-metal -lggml-cpu -lggml-base \
  -framework Metal -framework Foundation -framework Accelerate \
  -o /tmp/tx439-kmesvcjt/whisper-trace-rebuilt
python3 docs/testing/transcription-439/run-whisper-traces.py \
  /tmp/tx439-kmesvcjt/evaluation /absolute/new/private/output \
  /tmp/tx439-kmesvcjt/whisper-trace-rebuilt
```

Cargo's build-directory hash can differ; use the matching 0.2.3 static artifacts,
not a different runtime version. The runner verifies the existing input and
model checksums, creates a new output directory, generates the quiet controls,
and retains stdout/stderr for every run. It downloads nothing. The measured
raw files came from the equivalent explicit invocations retained in the private
evidence root; the reusable runner is checked separately as noted below.

## Checks and evidence

All four checks passed after merging main: `tsc --noEmit`; Vitest 288 files /
3,368 tests; Clippy `--all-targets -- -D warnings`; Rust 2,236 unit tests plus
6 CLI and 2 integration tests (18 intentional ignored tests). The context test
ran explicitly after those checks. The C++ probe compiled and all 204 real
inference runs completed. The reusable runner completed another 204 runs
with zero runtime failures, and all 32 regenerated quiet PCM hashes matched.
The formatted checked-in C++ probe also compiled with warnings denied and ran
a speech fixture successfully. Reproduction outputs remain in `trace-reproduction/`;
only the first measured pass supplies the table/CSV above. No production
filtering change was made from these measurements.

Host evidence root: `/tmp/tx439-kmesvcjt`:
`guest-build.log`, `guest-binary-sha256.txt`, `guest-merge-{tsc,vitest,clippy,cargo}.log`,
`guest-merge-context.{log,json}`, `guest-apple-file-probe.log`,
`guest-fake-transcript-proof.json`, `guest-ui-*.log`, `guest-*-store.json`,
`trace-*.{out,err}`, `trace-stress/manifest.json`. Guest files remain only in our
`/tmp/tx439` fixture and disposable bundle preference namespace. Do not publish
unrelated filenames incidentally included in picker accessibility trees.

Auto-merge remains off. Nothing was pushed, no PR was opened, and no issue
closure or acceptance-complete result is justified yet.

A subsequent headless [independent detector experiment](VAD-RESULTS.md) retains
all 51 results and rejects a default-threshold gate because it loses quiet
speech while retaining white noise. No production filter was added.
