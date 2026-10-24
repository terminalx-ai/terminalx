# Dictation personalization references

TerminalX's offline dictation personalization is an independent Rust and
TypeScript implementation inspired by [Juno](https://github.com/Cassini-Research/Juno),
Cassini Research's MIT-licensed local voice layer. No Juno source code, word lists,
model weights, or data files are included in this implementation.

The primary-source design references consulted were Juno's
`juno_v2/memory/correction_diff.py` (safe attribution of edits to inserted text)
and `juno_core_v3/dictation/self_corrections.py` (unambiguous spoken retakes).
TerminalX uses stricter whole-word substitution and exact repeated-phrase rules,
rather than porting Juno's fuzzy matching algorithms. It does not embed Juno's
Python runtime or writer model.
