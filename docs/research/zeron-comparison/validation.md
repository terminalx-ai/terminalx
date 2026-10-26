# Validation record

Validated on 26 October 2026 (Asia/Dubai), using TerminalX application source `e86b2de2db8968739d75e85ae0e859b38e95a862`. Only research documents, media and the video renderer changed in this branch.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; no lockfile changes. |
| `pnpm check` | Passed again after the final report/video changes: TypeScript and 289 test files / 3,387 tests, 42.89 seconds. The test environment emitted canvas-not-implemented messages; no test failed. |
| Frontend and Tauri Dev application build | Passed; app installed and launched in a clean Lume clone. Exact build identity and packaging overrides are documented in the evidence ledger. |
| Fresh VM walkthroughs | Completed for the disclosed local, unauthenticated scope. Zeron was exercised through the Lume viewer; TerminalX continued through guest Cua without host desktop input. |
| Video render | Passed: 23 chapters, 1600 × 1000 H.264 at 25 fps, AAC narration and 69 English mov_text subtitle cues. Duration 541.821 seconds (9:02 rounded). |
| Full video/audio decode | Passed with `ffmpeg -v error`; empty error log and successful exit. |
| Audio level | Non-silent: mean −15.8 dBFS, peak −1.3 dBFS. |
| Visual inspection | Inspected a rendered frame from every chapter and the selected TerminalX evidence contact sheet. No clipped editorial text, blank media panels or provider authentication URLs in the published selections. |
| Artifact integrity | Local Markdown targets, storyboard media, title bounds, ordered chapter/caption timing, JSON parsing and Python compilation passed. |
| VM cleanup | Both comparison VMs verified stopped and retained. The guest Codex session was explicitly stopped; unrelated VMs were not changed. |

The native Dev build is installation evidence, not production-installer or updater validation. TypeScript/unit checks verify the unchanged application baseline; they do not establish GUI parity.

The earlier host Accessibility blocker was resolved for this task by the user's explicit authorization to use trycua inside the VM. The continuation used the guest's already-granted Cua Spacesd service. No host desktop input or host permission repair was used. Native-menu automation refusals are recorded as harness limits, not application failures.

**Not tested:** authenticated inference, sync/remote/cloud workflows, GitHub/Linear writes, voice, Appshots capture, normal-Quit semantics, full reboot and update installation. The tested SIGTERM/relaunch cycle preserved the local runtime and Codex process, but the browser tab did not return; shell scrollback preservation is not claimed. No comparative performance or accessibility-compliance claim is made.

Local command logs and intermediate render files are retained under `/tmp/zeron-comparison-2026-10-26`. The durable evidence and rebuild inputs are committed with this report. Working credentials and OAuth URLs are excluded.

Final `video/comparison.mp4` SHA-256: `0f44b15c57ff0c0da88780e83649b0d1b1b37848eee54ed769278d84cfeafd83`.
