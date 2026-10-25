# Acceptance status after the explicit #631 split

Audit baseline: branch `raccoon/gh-439-offline-dictation-context`, HEAD
`5617c2b031ea432b5044af6b9d68f141e6247e78`; production candidate remains
`4c85ecd6f8971af8b167260a5134bb99800dfce0`. This update changes evidence only.

The user explicitly deferred the silence/noise-guard criterion to
[#631](https://github.com/terminalx-ai/terminalx/issues/631), recorded in the
[#439 scope comment](https://github.com/terminalx-ai/terminalx/issues/439#issuecomment-6397873863).
It is **deferred, not passed**. No other criterion is waived. The existing optional
guard implementation is still on this branch and still needs implementation
review; the scope split does not remove code or establish enabled-guard success.
The manual round is paused. No further user tests are requested by this ledger.

[HUMAN-OBSERVATIONS.md](HUMAN-OBSERVATIONS.md) reconciles the accepted screenshots,
including failed and successful trials. “Supported” below means evidence exists
for review, not an independent declaration that the entire issue is ready to merge.

| Issue criterion | Evidence available | Disposition / remaining gap |
| --- | --- | --- |
| Context improves Whisper and Apple term accuracy | Synthetic improvement for both Whisper models; Apple ON filename exact versus OFF errors; one Small ON repeat gets both identifiers exact | Open accuracy gate: bounded single-phrase human observations do not complete the project/identifier evaluation set. Original Small ON unrelated-output failure remains; no deterministic cause or statistical improvement asserted. |
| Dictionary, replacements and snippets work on every catalog engine | Five-engine dictionary/combined synthetic matrix; shared processing and scoped replacement tests | Shared path is implemented, but no direct snippet regression assertion was found in this audit. Smallest check is per-engine finalization/dispatch coverage with explicit snippet and replacement cases, not an automatic full ASR rerun. Full recorded per-feature matrix remains uncollected. |
| A safe dictated correction is learned, visible and removable | Backend observed-ASR learning/deduplication; frontend callback tests; imported learned entry displayed/removed in guest | Open native learning gate: no observed actual dictated edit → successful send → learned row → removal. Typed-only send and imported-row removal do not establish it. |
| Unambiguous retakes applied; ambiguous ones preserved | Existing conservative-retake regressions and retained synthetic results | Supported deterministic behavior; misrecognized cues remain unchanged. More accents/phrases strengthen validation but are not a new mandatory sample-count rule. |
| Silence produces no text | Apple requested quiet trial has no visible result/error; Small requested quiet trial returns `1.0T, 1Tpurpose` with guard disabled; fixture results retained | **Deferred to #631, not passed.** Candidate detector asset absent at the read-only check; enabled detector not tested in the human failure. Dog/sneezing false positives remain. |
| No secret/ignored-file content enters prompt/store; a test proves it | Secret rejection, private persistence, ignored-file walk and sensitive/remote-off regressions | Supported by required test evidence, pending final source review/checks. Native diagnostic screenshots would strengthen evidence, not create a separate mandatory UI test beyond this criterion. |
| Features can be off; all-off preserves existing output | Runtime-default and byte-identical post-processing tests; OFF detector disabled/zero work; human no-bias baselines | Supported processing/options evidence, not deterministic ASR repeatability. Apple refuses unavailable on-device recognition even when features are off; this documented privacy behavior must be included in compatibility review. |
| Audio/context/personalization stays local | Local source paths/storage; on-device Apple request; no personalization RPC; explicit asset download separated from audio | Source/test evidence for independent privacy review; no native traffic capture claimed. A traffic capture is stronger validation, not itself an explicit issue checkbox method. |
| Dictation UI unchanged; new controls in Settings | Source and existing UI tests; native Settings observations | Review capture/insertion and successful-send integration, especially after main adoption. Human shortcut/hold-to-talk and Apple partial-deletion observations remain absent; source/tests are not fabricated manual passes. |
| Test panel shows raw/final/bias terms | Human Apple and Small screenshots now show raw/final and bias/no-bias diagnostics | Native display requirement observed for those routes. Raw=final in these trials; unequal raw/final has automated UI coverage, not a newly claimed human cleanup result. |
| Context does not delay recording start; added stages do not noticeably delay final insertion | Background project preparation and backend/file timing only | Open native latency gate: no measured/reported context/start-of-recording or stop-to-final/insertion delay. [HANDOFF.md](HANDOFF.md) and [PRODUCTION-DETECTOR.md](PRODUCTION-DETECTOR.md) retain the protocol and performance limitations. No numeric performance threshold invented. |
| Attribution | Juno design attribution and detector notices present; independent evidence review checked presence/provenance | Supported; final implementation/license review remains, without claiming an exhaustive upstream licensing audit. |

## Publication checkpoint

CONTRIBUTING.md requires TypeScript, Vitest, Clippy (warnings denied), and Rust
tests before a PR. The scope comment retains exact-head checks and independent
review before publication/merge. Existing full-suite logs concern the earlier
production candidate, not a candidate reconciled with current main. The accepted
independent review was an evidence review; its latency-ledger P3 was resolved by
`5617c2b0`. It is not full implementation or new-human-evidence acceptance.

A read-only fetch pinned main at `04a073127bc0991090289f9050dca1c5f15a0ccc`.
Merge simulation reports a CHANGELOG conflict and automatic merges in
`src-tauri/Cargo.toml`, `Cargo.lock`, `src/commands.rs`, and `src/lib.rs`.
No merge/rebase/adoption or conflict repair occurred. Resolve that concrete
integration blocker only in a separately authorized step, review the combined
source, then schedule exact-candidate checks with the coordinator; #467 owns the
current heavy-check slot. CI or the existing explicit private-CI exception and
cleanup gates remain with the coordinator. No commit, push, PR or closure is
performed or authorized by this evidence update.

The isolated presence app/store remains preserved. AirPods and test procedures
are user context, not independently captured audio/device/timing. Failed human
ON/quiet trials, the strict Small tone mismatch, five empty Nemotron quiet
recognitions and environmental false positives remain evidence. Detector speech
retention never means accurate or nonempty transcription.
