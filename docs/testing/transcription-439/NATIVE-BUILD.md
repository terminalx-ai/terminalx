# Disposable Apple validation build

Prepared on 2026-10-24. **Built and verified, never launched.**

- Artifact: `/tmp/tx439-kmesvcjt/TerminalX Dictation 439.app`
- Source: `ec423d66bf96bd072516a7ba23e20b21aa31c40e` (clean checkout when packaging began).
- Bundle identity: `com.terminalx.next.dev.dictation439`; no URL schemes.
- Binary SHA-256: `ab0461e233a01807d2e462a004b76937ad4e89aefadd9a2cf704fe6ed0020f8d`.
- Verification: native debug app build succeeded; `codesign --verify --deep
  --strict` passed; signature is ad hoc with hardened runtime and
  `com.apple.security.device.audio-input=true`. Both microphone and speech
  usage descriptions are present. The launcher passes `sh -n`.
- Source checks at that commit: TypeScript, Vitest (3,353 tests), Clippy with
  warnings denied, and Rust (2,214 unit + 8 integration tests) passed.

## User launch

Run this one command in Terminal (it remains attached until the test app quits):

```sh
/tmp/tx439-kmesvcjt/launch.sh
```

Use this launcher rather than double-clicking the app: it supplies isolation.
It starts the bundle executable with `env -i`, an empty home, separate
`TERMINALX_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, XDG/Git/GitHub config and
temporary directories under `/tmp/tx439-kmesvcjt`. Agent/account CLI shims return an error,
so this fixture cannot be used for agent work. It does not need sign-in.

Keychain isolation uses the repository's supported debug service override:
`dev.terminalx.dictation439.tx439-kmesvcjt`. Cloud-agent keys derive from that namespace;
pairing uses `com.terminalx.next.dev.dictation439.pairing` from the compiled bundle identity.
These are new service namespaces in the current macOS keychain, not a modified
keychain search list or a new system account. Explicit Claude configuration
also prevents fallback to the real Claude credential service.

App permissions are scoped to the distinct bundle identity. If prompted while
performing the user test, grant microphone/speech access only to **TerminalX
Dictation 439**. No permission reset or other system-setting change was made
during preparation. No recordings, credentials or personal stores were copied.

## Short OFF/ON test

1. Open Settings → Transcription in this test app; select Apple and the mic.
2. Import `/tmp/tx439-kmesvcjt/OFF.json`. Under Test dictation, leave Test project at Global
   dictionary only. Start test, say the script line, Stop test; preserve
   raw/final text and bias terms, marked OFF.
3. Import `/tmp/tx439-kmesvcjt/ON.json` and repeat, marked ON. Alternate OFF/ON order between
   lines. Use the same microphone/language. Do not sign in or start an agent.
4. Report errors, missing first words, stop-to-final delay and silence text;
   quit only this disposable app.

The minimum donated-audio action is **one new recording** following
`/tmp/tx439-kmesvcjt/RECORDING-SCRIPT.txt`. The coordinator splits/converts that file and
creates all manifests. The full repeat counts, silence blocks, Apple evidence
and remaining model/context/learning matrix stay in [HANDOFF.md](HANDOFF.md).
This first dictionary-context pass does not satisfy the entire acceptance set.

## Reproduction and limits

The build uses the documented debug app packaging and isolation mechanisms in
[RELEASING.md](../../RELEASING.md) and `scripts/perf/bench-app.sh`; the benchmark
launcher itself was not run. From this worktree, the build command was:

```sh
CARGO_BUILD_JOBS=2 SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" \
  TERMINALX_HOME=<empty-build-state> CLAUDE_CONFIG_DIR=<empty-build-claude> \
  TERMINALX_COMPUTER_MACOS_SKIP=1 \
  pnpm tauri build --debug --bundles app --no-sign \
  --config src-tauri/tauri.dev.conf.json --config /tmp/tx439-kmesvcjt/build-config.json
```

It reused this worktree's Cargo target cache. The overlay sets the unique
identity/name, removes URL schemes, disables updater artifacts, runs `pnpm
build`, and omits the optional computer-use helper resources. No CSP or
application source was changed. The helper is deliberately unavailable in this
dictation-only test bundle. No installed app, launcher registration, permissions
or credentials were changed. Only the disposable copy was then ad-hoc signed
with the repository's `src-tauri/Entitlements.plist` and runtime option.

The bundle and its metadata/settings are under `/tmp`; preserve them for the
manual hold before a reboot/temporary-directory cleanup. `verification.json`
beside the app records its hash and source. Launch/microphone behavior is still
unverified; packaging success is not native acceptance. Nothing was pushed,
no acceptance-complete PR was opened, and auto-merge was not enabled.
