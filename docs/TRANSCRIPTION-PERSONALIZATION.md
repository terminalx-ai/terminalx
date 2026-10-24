# Offline dictation personalization

All personalization options default off. Data is stored in the app's private
data directory as `transcription-personalization.json`. Atomic writes and a
revision check prevent a stale Settings page from overwriting newly learned
corrections. Exports are plain JSON; imports validate the complete document
before replacing it. No audio or dictation history is stored.

The composer prepares a bounded list of non-hidden, non-ignored file names in
the background. Starting the microphone never waits for a repository walk.
Context uses file names, the branch, named tools and the selected agent/model.
Draft and visible terminal text can promote known file/tool/dictionary terms,
but cannot introduce arbitrary words from pasted ignored-file contents. Tool
arguments/results, assistant prose, file contents and editor/diff buffers are
not read. Open-file names are promoted only when present in the allowed file
list. No Accessibility or other-app screen capture is involved.

Per recording, explicit dictionary terms rank before identifiers. The prompt
is capped at 200 UTF-8 bytes (a conservative upper bound for a 224-token budget,
not a measured optimum) and 64 terms. Whisper gets an initial prompt and
previous-context limit; Apple gets contextual strings. Parakeet, Nemotron and
Canary have no vocabulary hint extension in the installed runtime. Diagnostics
show actual hints, so these engines show no bias terms. All engines receive
enabled dictionary spelling repair, replacements, snippets and cleanup.

Apple requests on-device recognition unconditionally and refuses unsupported
locales. This intentionally closes the old server-fallback path, including with
personalization off. For engines available offline, all-off output remains the
existing trimmed recognition output. Language hints reach Apple, Whisper and
Canary; unsupported Canary languages produce a clear error.

Cleanup is conservative English grammar: exact prompt echoes and long repeated
loops, a repeated phrase with one corrected word or an explicit am/pm time
retake, explicit `number three`, file extensions, selected symbol phrases,
`snake/camel/Pascal/kebab case … end case`, and `at file example.rs`.
Ambiguous phrases are preserved. Snippets/replacements run once against the
result, so inserted text cannot recursively trigger another expansion.

Learning is opt-in for existing local tab composers. It tracks only the latest
dictated segment in memory until a successful send. The surrounding draft must
still match. Edits while results are settling, multiple changed words,
case/punctuation-only edits, remote tabs and sensitive surfaces are excluded.
At least three words must remain, with exactly one whole-word substitution.
Learning does not change sending, insertion, shortcuts or the mic UI. There is
no transcript history; learned entries contain only the accepted word pair.

Secret-like text is rejected before prompt compilation, imports and learning.
Sensitive tabs disable personalization entirely. Remote workspace context is
off by default and remote corrections are never learned. Ordinary dictation
events log lengths, not spoken text. Raw/final diagnostic text is emitted only
for the explicit Settings test target and kept in that page's memory.

The runtime does not expose per-result no-speech probability. There is no
common-phrase blacklist: legitimate “thank you” must not be deleted. Digital
silence is already refused by capture; ambient-silence false positives and
recognition improvement require the recorded evaluation. See the
[handoff](testing/transcription-439/HANDOFF.md) and
[Juno attribution](TRANSCRIPTION-ATTRIBUTION.md). No measured improvement is
claimed by the deterministic unit tests.
