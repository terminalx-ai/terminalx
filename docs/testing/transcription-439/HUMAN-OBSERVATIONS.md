# Bounded human observations — 2026-10-25

These are accepted observations, not a blanket acceptance result. Coordinator
records are retained under
`/Users/pareshdudhat/.terminalx-tools/coord/github-quickwins-20261023/439-human-*.json`.
The post-split audit read all 13 matching JSONs (including two delivery receipts
and the AirPods correction), and verified all ten referenced screenshot hashes.
Screenshots are authoritative for visible output. The delivery receipts are
historical coordination evidence, not additional recognition trials or authority.

Requested phrase: “Open TranscriptionTab dot tsx and refreshDictationEngine.”

| Observation JSON suffix after `439-human-` | Visible observation | Limit |
| --- | --- | --- |
| `apple-disabled-observation.json` | “Siri and Dictation are disabled” | Initial blocked Apple trial retained; later recognition does not erase this event. |
| `input-airpods-correction.json` | User corrects earlier wired-headset description to AirPods | Actual selected device independently unverified. |
| `apple-baseline-observation.json` | Raw=final `Open transcription tab.PSX and refresh dictation engine`; no bias terms recorded | Guided OFF; import state not independently inspected; neither target exact. |
| `apple-on-observation.json` | Raw=final `Open TranscriptionTab.tsx and refresh dictation engine`; five bias terms | Filename exact; function remains spaced. One ON observation, not evaluation-set completion. |
| `apple-quiet-observation.json` | Start test available; no visible transcript/result/error after requested quiet procedure | Engine/settings inferred from preceding guided step; not captured acoustic silence or a general quiet-input pass. |
| `second-apple-off-observation.json` | Engine actually Apple; raw=final `Open transcription tab.TsX and refresh dictation engine` | Additional Apple no-bias observation, despite requested Whisper step. Never count as Whisper evidence. |
| `whisper-small-off-observation.json` | Raw=final `Open transcription tab.tsx and refresh dictation engine.`; no bias | Phrase-aligned, not exact target identifiers. |
| `whisper-small-on-problem-observation.json` | Substantial unrelated/mixed-language raw=final with five bias terms | User confirms only target phrase spoken. Retained failed ON trial; screenshot supplies exact text. |
| `whisper-small-dictionary-only-off-observation.json` | Raw=final `Open transcription tab.tsx and refresh dictation engine.`; bias None; Automatic visible | Phrase-aligned; other toggles not visible. |
| `whisper-small-dictionary-on-repeat-observation.json` | Raw=final `Open TranscriptionTab.tsx and refreshDictationEngine.`; five bias terms | Successful two-identifier trial only. Does not erase earlier ON failure or prove deterministic dictionary effect. |
| `whisper-small-on-quiet-failure-observation.json` | Raw=final `1.0T, 1Tpurpose`; five bias terms; guard disabled | Failed requested quiet trial; user agrees it appears invented. No audio, selected-device, duration or acoustic-silence verification; enabled detector was not tested. |

No matched Dictionary-OFF quiet result is present in these records; the manual
round paused before another accepted observation. No human Turbo, complete
recorded catalog/per-feature matrix, successful-send learning/removal, partial
Apple deletion or measured native latency result is manufactured from this round.
The raw/final/bias diagnostic display itself is now observed on Apple and Small.
All screenshot recognition results have equal raw and final text; exact spelling
in the successful Small repeat is visible in raw recognition, not credited to a
post-processing rewrite. No simultaneous-device/audio/timing measurement exists.

The user explicitly split silence/noise-guard acceptance into
[#631](https://github.com/terminalx-ai/terminalx/issues/631), recorded in the
[#439 scope comment](https://github.com/terminalx-ai/terminalx/issues/439#issuecomment-6397873863).
That criterion is deferred, not passed; no other criterion was waived. The
optional guard already exists in the candidate, but its model was absent from
the isolated app store at the bounded source/file-existence check. The separate
fixture asset existed; no provisioning or enabled run was performed. The
source-only report remains in `439-human-quiet-followup/REPORT.md` alongside
coordinator evidence. It does not establish a remedy or authorize a new trial.

All previous synthetic/public-recording evidence remains unchanged, including
the strict Small tone raw mismatch, five Nemotron empty quiet-ASR rows and
dog/sneezing detector false positives. See [ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md)
for criterion-by-criterion disposition and remaining publication gates.
