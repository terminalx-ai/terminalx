# Spike: other terminal engines (issue #232, phase 3)

**Not for merging.** This directory and `src/lib/spike/` exist to put numbers
on a question; the result and the recommendation are in
`docs/TERMINAL-PERFORMANCE.md`.

- `ghostty-vt.wasm`: libghostty-vt, built from Ghostty at revision
  `9f62873bf195e4d8a762d768a1405a5f2f7b1697` for `wasm32-freestanding`,
  `ReleaseSmall`, with Zig 0.15.2 (sha256
  `56f9eb384290a3ab5146bd0dba7032a9a23b3330ac5ad650322a41df4b9cc29c`).
  Ghostty is MIT: `LICENSE-ghostty`. The file is the one the Zuse project
  builds with its `build:ghostty:wasm` script from unmodified Ghostty source.
- `src/lib/spike/ghosttyVt.ts`, `ghosttyCanvas.ts`: a minimal binding and a
  2D-canvas renderer, written for this spike against Ghostty's C headers
  (`include/ghostty/vt/*.h`). None of Zuse's terminal code is used: Zuse is
  AGPL-3.0-only, and this repository is MIT.
- `vtbench/`: a standalone program that parses the benchmark's workload files
  with `alacritty_terminal`, natively. `cargo run --release -- <files>`.

Run the in-app comparison with
`node scripts/perf/terminal-bench.mjs --home ~/.txperf --pid <pid> --scenarios engine`.
The spike adds `'wasm-unsafe-eval'` to the app's content security policy,
which WebKit needs to compile WebAssembly.
