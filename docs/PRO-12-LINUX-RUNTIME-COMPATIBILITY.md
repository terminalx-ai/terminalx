# PRO-12 Linux runtime compatibility review

**Outcome:** analysis-only closure is justified for the current scope. No actionable Linux runtime gap was found in the app entrypoint or Tauri configuration.

The desktop entrypoint in `src-tauri/src/main.rs` contains Windows-only console attachment behind `cfg(windows)` and otherwise starts the same library entrypoint on Linux. Linux-specific runtime behavior is selected through the desktop-script provider (`target_os = "linux"`), with the Python helper packaged by `src-tauri/tauri.linux.conf.json`. The macOS helper build command is intentionally a no-op off macOS, so it does not block Linux builds. CI's `desktop-platforms` job covers Linux frontend build, Rust compilation/tests, and Linux helper renderer tests.

Validation performed during this review:

- `python3 native/computer-use-linux/runtime_render_test.py` — 8 tests passed.
- `python3 native/computer-use-linux/launcher_test.py` — 6 tests passed.
- `pnpm build:computer-macos` — completed on macOS (the expected Linux no-op is enforced in CI).
- `pnpm install --frozen-lockfile` restored the workspace dependencies, after which `pnpm build` succeeded and all 404 Vitest tests passed.
- Local `cargo check --all-targets` succeeds when `SDKROOT` is set to Xcode's SDK (`/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`). The default `xcrun` SDK path pointed at a malformed Command Line Tools SDK; this was a host configuration issue, not a project defect.

No code changes are required for PRO-12. A real Linux desktop build remains covered by the existing Ubuntu CI job.
