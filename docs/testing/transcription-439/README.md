# Offline dictation personalization evaluation (#439)

This protocol is written before tuning. Deterministic tests establish software
behavior; they are not evidence of improved speech recognition. Subsequent
synthetic recognition measurements are in [NATIVE-RESULTS.md](NATIVE-RESULTS.md)
and production detector evidence is in [PRODUCTION-DETECTOR.md](PRODUCTION-DETECTOR.md).
Human microphone and Apple acceptance remain pending; see [HANDOFF.md](HANDOFF.md).

## Corpus and consent

Record the sentences in `sentences.json` as 16 kHz mono WAV, three takes each,
with the same microphone and room. Include five seconds each of quiet, room
noise and keyboard noise. Keep recordings outside the repository in a private
disposable directory. Use invented project names and credentials only. Do not
record or read private conversations. Record microphone, OS, language, engine
revision, model SHA256 and ambient conditions alongside each result.

The sentences are recording instructions, not simulated recognition results.
Supply the actual recordings before scoring or making an improvement claim.
Use the exact same audio for paired local-model runs. For Apple's live route,
repeat each phrase in randomized on/off order and report that limitation;
loopback playback requires the person's chosen audio setup.

## Matrix

Run every sentence against Apple, Whisper Small, Whisper Large v3 Turbo,
Parakeet Unified EN, Nemotron Streaming and Canary 180M Flash. For each run:

1. All options off (baseline).
2. Context only, with the fixture project file names and identifiers visible.
3. Dictionary only; add the terms listed by the sentence.
4. Replacements/snippets only, with explicitly supplied heard/written pairs.
5. Cleanup stages individually, then combined.
6. All selected features together.

Log raw and final text, bias terms, exact options, preparation time and latency
from microphone stop to final text. Calculate word error rate as word-level
Levenshtein distance divided by reference word count; report identifier spelling
accuracy separately (exact case-sensitive match). Keep silence false positives
separate from WER. Do not average missing models as zero errors. Show paired
per-utterance results and sample counts, including regressions.

Acceptance needs an improvement in term accuracy for BOTH Whisper models and
Apple, no silence output, no unexpected expansion in negative examples, and no
noticeable latency regression. Prompt budget and cleanup rules remain provisional
until these measurements exist. Do not download missing models automatically.

## Additional manual observations

In a disposable app fixture, confirm mic toggle and hold-to-talk are unchanged;
edit/delete during Apple partial results, wait for the final, then send. Deleted
text must stay deleted. Learn only an isolated word correction after a successful
send; see it in Settings and verify remove, forget-all, reset and restart.
Repeat with learning off, an excluded tab, a password-like draft, and a cloud
composer with remote context off. Inspect diagnostics for absence of context.
Check Settings at 1360x860 and 1000x700, light and dark. Import/export a local
dictionary and reject an entry containing a synthetic secret. Verify no network
request is made for dictation, context, learning or personalization storage.

## Initial environment inventory (2026-10-24)

Read-only inspection found Parakeet Unified EN Q8_0 weights (731357568 bytes)
under the existing local models directory. No WAV/FLAC/MP3 corpus is checked in.
No private transcripts were opened and no weights were downloaded. Apple and
microphone behavior need user-provided observations; the live app must not be
restarted or automated for this issue.

## Reference

Ideas were reviewed in [Juno](https://github.com/Cassini-Research/Juno) revision
`217c7e71e7e6e737749bfa389621f2fa469b3144`, particularly prompt_builder.py,
context/redaction.py, memory/correction_diff.py and dictation/self_corrections.py.
TerminalX implements its own Rust/TypeScript logic and ships no Python runtime.

## Native paired-run harness

The ignored Rust test runs an installed catalog model directly, without the app,
microphone, downloads or user-store lookup. Prepare an explicitly donated audio
file as **headerless little-endian IEEE 754 float32 PCM, one channel, 16000 samples
per second**. Every sample must be finite and between -1 and 1. The file must be
nonempty, a multiple of four bytes, and no longer than 60 seconds (3,840,000
bytes). A WAV container is not accepted directly: export the raw PCM format with
your audio tool and retain the source WAV separately. Verify its export settings;
renaming a WAV file does not convert it.

Create a private manifest with these exact keys and absolute paths:

```json
{
  "model": "parakeet-unified-en-0.6b",
  "modelPath": "/private/evaluation/parakeet-unified-en-0.6b-Q8_0.gguf",
  "audioPath": "/private/evaluation/take-01.f32le",
  "personalizationPath": "/private/evaluation/options.json",
  "outputPath": "/private/evaluation/take-01-result.json",
  "terms": ["Parakeet", "DictationEngine.rs"],
  "reference": "Open DictationEngine.rs with Parakeet."
}
```

`personalizationPath` is the exported personalization JSON (`options` and
`entries`), validated by the same rules as Settings import. Optional `project`
selects the project ID used for scoped entries. `terms` supplies both context
candidates and target terms for scoring; enable context in the options to bias
with these candidates. Dictionary terms still require the dictionary switch.
No project files are traversed by this harness.

Run from `src-tauri`, using private disposable state directories:

```sh
TX_EVAL_STATE=$(mktemp -d)
CARGO_BUILD_JOBS=2 SDKROOT=$(xcrun --sdk macosx --show-sdk-path) \
  TERMINALX_HOME="$TX_EVAL_STATE/terminalx" \
  CLAUDE_CONFIG_DIR="$TX_EVAL_STATE/claude" \
  TX_DICTATION_EVAL_MANIFEST=/private/evaluation/manifest.json \
  cargo test transcription::evaluation::real_model_pair -- --ignored --exact
```

The destination must not exist. It is created with owner-only permissions; a
failed run can leave an empty file, so choose a new destination before retrying.
The report includes both raw/final transcripts, WER, exact case-sensitive target
term accuracy with word boundaries, candidate terms, actual model bias terms,
and inference/processing durations. WER is case-insensitive and strips outer
punctuation. Terms absent from the reference do not affect term accuracy; no
applicable terms gives `null`. An empty reference yields zero for silence or the
number of inserted words for nonempty output, which should be reported separately.

Actual `biasTerms` is empty for Parakeet, Nemotron and Canary because these
engines do not receive vocabulary hints. Their `candidateTerms` can still be
present; dictionary/replacement/cleanup processing runs after recognition.
Prompt-echo removal only receives hints actually supplied to Whisper.

Baseline inference includes cold model loading; the personalized run reuses
weights. Do not compare these timings as a latency benchmark. Direct-engine
silence runs deliberately bypass microphone capture guards and therefore assess
the recognizer itself. This harness does not evaluate Apple, microphone behavior,
composer insertion, or the Settings display. One paired recording is not an
aggregate improvement claim; complete the matrix above before claiming accuracy.
