# Acceptance status after worker recovery

Issue #439 remains open for acceptance. The replacement worker preserved branch
`raccoon/gh-439-offline-dictation-context` at recovery head `61eb29a6` and the
production implementation at `4c85ecd6`. This ledger distinguishes implemented
and tested behavior from the remaining observations. The coordinator retains
independent review, publication, CI/private-CI exception and cleanup gates.

| Issue criterion | Evidence available | Remaining acceptance gap |
| --- | --- | --- |
| Context improves Whisper and Apple term accuracy | Both Whisper models improved on the synthetic corpus in NATIVE-RESULTS.md | Human paired corpus and Apple OFF/ON measurements |
| Dictionary, replacements and snippets on every catalog engine | Shared processing tests and five-engine synthetic dictionary/combined matrix | Full recorded per-feature matrix; no native vocabulary bias is claimed for Parakeet, Nemotron or Canary |
| Learn a correction, show it, remove it | Backend observed-ASR learning and deduplication; guest display/removal of imported learned entry | Actual dictated correction learned after successful native send |
| Conservative spoken retakes | Deterministic tests and retained synthetic recognition failures | Recorded unambiguous/ambiguous examples; misrecognized cues remain unchanged |
| Silence produces no text | Production detector paired fixture results tracked in PRODUCTION-DETECTOR.md | Microphone quiet/ambient/typing and Apple; broader detector evidence still retains dog/sneezing false positives |
| No secret or ignored-file content enters prompt/store | Context and personalization regressions; disposable project walk | Native sensitive/cloud-off diagnostics remain unobserved |
| All features off preserves existing output | Default run-option and byte-identical processing tests; disabled detector performs zero timed work | Human native OFF baseline; repeated stochastic ASR output must not be mistaken for an option change |
| Audio/context/personalization stays local | In-process local recognition, explicit pinned model provisioning, bounded ephemeral context and local store | End-to-end native network observation from the protocol remains pending |
| Dictation UI unchanged; options in Settings | Existing settings UI evidence; production integration keeps capture/insertion routes | Human mic/shortcut/hold-to-talk and Apple partial-deletion observations |
| Test panel raw/final/bias terms | Implemented diagnostic event and settings tests | Successful native recognition diagnostic capture |
| Context does not delay recording start; added stages do not noticeably delay final insertion | Backend context measurements and file timing proxies only; [PRODUCTION-DETECTOR.md](PRODUCTION-DETECTOR.md) explicitly excludes performance acceptance | Pending native context-preparation/start-of-recording and microphone stop-to-final/insertion latency observations under the [HANDOFF.md](HANDOFF.md) protocol |
| Attribution | Juno ideas documented; native detector attribution and pinned model provenance retained | Final independent attribution review |

The host candidate at `/tmp/tx439-kmesvcjt/presence-4c85ecd6` remains under the
user/coordinator's control. OFF import is reported; microphone testing and Apple
consent/results are not confirmed. Historical app/probe failures remain evidence,
not permission to alter settings or repeat consent attempts. Neither guest was
used during replacement-worker recovery.

No synthetic, public recorded-file, unit-test or imported-entry result substitutes
for human microphone, native successful-send learning, or Apple acceptance.
The acceptance protocol and detailed native gaps remain in HANDOFF.md and
GUEST-RESULTS.md. No push, PR, automatic completion publication or closure is
authorized by these measurements alone.
