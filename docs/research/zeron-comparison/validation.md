# Validation record

Validated on 26 October 2026 (Asia/Dubai), using TerminalX source `e86b2de2db8968739d75e85ae0e859b38e95a862`. Only research documents and media are added to the repository.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; no lockfile changes. |
| `pnpm check` | Passed: TypeScript and 289 test files / 3,387 tests. The test environment emitted canvas-not-implemented messages; no test failed. |
| Frontend and Tauri Dev application build | Passed; app installed and launched in a clean Lume clone. Exact build identity and packaging overrides are documented in the evidence ledger. |
| Video render | Passed: 14 chapters, 1600 × 1000 H.264 video at 25 fps, AAC narration and English mov_text captions. Approximately 350 seconds. |
| Full video/audio decode | Passed with `ffmpeg -v error`; no decode errors. |
| Audio level | Non-silent: mean −15.7 dBFS, peak −1.1 dBFS. |
| Visual inspection | Inspected a rendered frame from every chapter, plus the end of the terminal/authentication excerpt; no clipped editorial text or blank media panels found. |
| Artifact integrity | Local Markdown targets, storyboard media, chapter/caption timing, JSON parsing and Python compilation checked. |

The native Dev build is installation evidence, not production-installer or updater validation. The TypeScript/unit checks verify the unchanged project baseline; they do not establish GUI parity.

**Still blocked:** TerminalX's fresh-install UI walkthrough and matched recording. The host helper reported `permission_denied` for Lume with no accessible window; its permission inventory still showed granted. The installed computer-use guide directs the person to repair the permission through the setup UI before retrying. No alternative desktop driver was used.

**Not tested:** authenticated inference, sync/remote/cloud workflows, GitHub/Linear writes, voice, Appshots capture, and update installation. No comparative performance or accessibility-compliance claim is made.

Local command logs and intermediate render files are retained under `/tmp/zeron-comparison-2026-10-26`. The durable evidence and rebuild inputs are committed with this report.
