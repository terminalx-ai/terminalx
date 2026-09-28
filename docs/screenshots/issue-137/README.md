# Issue #137: transcription audio input

## September 16 follow-up

The existing implementation was rechecked, and two remaining edge cases were fixed:

- A known unavailable-input fallback stays visible during Starting, Listening, and Finishing instead of being replaced by the unavailable device's preferred name.
- A delayed preference read from a surface mounted during a save cannot overwrite the newly saved choice.

Regression coverage now includes these cases, closing an open picker when recording starts, passive rendering for both composer targets, and selection synchronization in both directions between the composer controls and the actual Transcription settings component.

Validation on this checkout:

- `pnpm check`: TypeScript and 450 frontend tests pass (73 files), including 20 focused picker/permission tests.
- `pnpm build`, native development build, and `cargo clippy --all-targets -- -D warnings`: pass.
- `cargo test`: 471 pass, four ignored.
- **The previously outstanding two-input recording check passed.** The native composer listed and selected `MacBook Pro Microphone` and `iPhone Microphone`. Both recordings reached Listening and Finishing, disabled the picker, returned text to the composer, and restored the picker afterward. The built-in input transcribed a spoken test sentence played through the speakers; the iPhone input returned repeated “Hello” speech. This verifies capture and completion, not comparative recognition accuracy. [Native iPhone recording result](two-input-validation.png).
- Selecting the built-in input in the composer was reflected in Transcription settings. The isolated `settings.json` then confirmed the saved iPhone selection.

The test app used this worktree's frontend on port 1537 and `TERMINALX_HOME=/tmp/terminalx-137-validation`, with Parakeet selected from an existing local model. No agent prompt was submitted. The test app was stopped after verification.

## September 8 validation archive

At the original validation, the required recording check with two distinct inputs was blocked by hardware availability: that Mac exposed only “Paresh’s AirPods Pro #3.” System default resolved to that same input. The follow-up above closes that hardware check; the original evidence below remains available.

## Native application evidence

- [Composer and recording video](transcription-input.mp4): real macOS screen recording of the changed native app, including new-composer capture/finishing, the existing composer, keyboard opening/selection, and the saved named input.
- [Unavailable-input video](unavailable-input.mp4): a deliberately missing saved preference, its unavailable marker and fallback explanation, and successful fallback capture.
- [Existing-composer picker](existing-picker.png) and [unavailable preference](unavailable-input.png): screenshots taken with `terminalx computer`, inspected as pixels.

The MP4s are H.264 exports (1280 pixels wide, 15 fps) of real `screencapture` MOV recordings, not reconstructed screenshots. Original recordings are retained at `/tmp/terminalx-137-evidence/capture-validation.mov` (99.975 seconds) and `/tmp/terminalx-137-evidence/unavailable-validation.mov` (44.98 seconds). Representative frames from each source recording were decoded and visually inspected. An earlier 150-second recording of composer/Settings synchronization is retained at `/tmp/terminalx-137-evidence/demo-region.mov`.

## Checks performed

- `pnpm check`: TypeScript and 377 tests across 65 files pass, including 15 focused picker/permission tests.
- `pnpm build` and native `cargo build --manifest-path src-tauri/Cargo.toml --bin raccoon`: pass.
- Both composers display the shared picker beside the mic. Tab reaches the control, Return opens it, Down navigates, Return selects, and Escape dismisses.
- Composer → Settings and Settings → composer selections stay synchronized; the isolated `settings.json` confirms persistence. The AirPods selection survives restarting the test app.
- Real local Whisper capture completes from both composers for System default and explicitly selected AirPods, with text returned. The picker is disabled during Listening and Finishing.
- A deliberately missing long saved name is marked unavailable, wraps inside the menu, retains its selected marker, and explains system-default fallback. Recording with that preference succeeds via fallback. This is a saved-preference fixture, not a physical unplug/replug test.
- Both composers were visually checked with the 400-pixel side panel open, leaving approximately 692 pixels for the composer area. Mic and Send/Start remain visible. Native window-resize drags did not resize the window; no 760-pixel full-window validation is claimed.
- Empty input lists, absent system default, enumeration/save errors, refresh on reopening, synchronization, and permission boundaries are covered by focused tests.

The built-in Apple engine reported `Siri and Dictation are disabled`. Whisper Small was downloaded and selected only in the isolated profile to validate capture without changing system-wide dictation settings. The label represents the persisted preference; during recording it explicitly says “Preferred,” since hardware can change after enumeration.

## Isolation

Worktree: `proud-flax-raven`; implementation commit: `d15c9d8`.
App: `/tmp/TerminalX Issue 137.app`, bundle ID `com.terminalx.issue137`, built from this worktree. Its frontend ran on port 1537 and `RACCOON_HOME` was `/tmp/terminalx-137-home`. The existing-session surface used a saved idle session fixture; no agent task was submitted. UI operations and recordings used the shared desktop lock. Only the test app was restarted/stopped; production TerminalX remained running at PID 6564.
