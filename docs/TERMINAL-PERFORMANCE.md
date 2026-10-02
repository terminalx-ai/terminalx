# Terminal performance and memory

Issue [#232](https://github.com/terminalx-ai/terminalx/issues/232): the
terminal view was reported slow and unreliable, with memory growing over a
long session. This document records how that is measured, the numbers, and
what they point to. It is updated by each change that moves a number.

## The path being measured

```
program ──▶ PTY ──▶ pty-read thread ──▶ pty-emit thread ──▶ Tauri event `pty_data`
                    (16 KB reads)       (8 ms / 32 KB        (base64 in JSON, to
                                         batches)             every listener)
                                                                   │
        screen ◀── WebGL or DOM renderer ◀── xterm.js ◀── decode ◀─┘
```

One xterm.js instance per terminal lives for as long as the terminal does,
on screen or not (`src/lib/terminal.ts`). Each asks for a WebGL context when
it is created (`src/components/terminal/TerminalView.tsx`).

## Counters

`terminalx status --json` reports what the terminals hold, under `terminals`:

- `backend`: PTY panes, how many are running, scrollback bytes held, and the
  `pty_data` events and bytes sent since launch.
- `webview`: live xterm instances and how many are in the document, how many
  are on WebGL and how many on the DOM renderer, how many a view is showing
  (`onScreen`) and how many of those are on the DOM fallback (`domOnScreen`,
  which should be 0), WebGL contexts created / lost / refused since the window
  loaded, buffer lines held, replay
  buffers and their bytes, and output events and bytes per second (local and
  cloud). It is `null` when the window did not answer within 500 ms.

The webview counts as it goes (a few additions per output event) and computes
the rest only when asked. The same counters are at
`window.__TERMINALX_PERF__.counters()` in Web Inspector.

## The benchmark

The benchmark runs in the real app window, so it covers the whole path above
in the real WKWebView. `src/lib/terminalBench.ts` opens the terminals and
takes the times; `scripts/perf/terminal-bench.mjs` writes the workload files,
drives the app over its control socket and reads process memory.

```sh
pnpm tauri build --debug --bundles app --no-sign --config src-tauri/tauri.dev.conf.json
pid=$(scripts/perf/bench-app.sh ~/.txperf)        # an isolated copy, opened in the background
node scripts/perf/terminal-bench.mjs --home ~/.txperf --pid "$pid" --out results.json
kill "$pid"
```

`bench-app.sh` launches a copy of the build with its own bundle id, no URL
scheme, its own `TERMINALX_HOME` and Keychain service, and
`TERMINALX_TERMINAL_BENCH=1`. Without that variable the app refuses to run a
benchmark. Run the soak on a freshly launched app (`--scenarios soak`), since
the other scenarios leave their own mark on memory.

What a run does:

- **Field.** `N` terminals are open (1, 8 and 20). One is on screen. The
  others have a live xterm that is not in the document, as after a session
  switch, and each prints an agent-style redraw ten times a second.
- **Drain.** The on-screen terminal runs a workload between two in-band marks
  (`OSC 7777`). The time is taken when xterm has *parsed* each mark, so it is
  the time for the whole path, not for the process. Workloads:
  `yes | head -n 2000000` (6 MB), `cat` of a 50 MB log, and 4,000 agent-style
  redraws (11 MB: synchronized output, cursor up over a 20-line block, every
  line rewritten with colours, a line scrolling away every fifth frame).
- **Typing echo.** The on-screen terminal runs `cat` in raw mode. 200 key
  presses go through the typing path (xterm `onData`, then `pty_write`), and
  each is timed until xterm parses its echo and until the next frame. With
  more than one terminal, another tab floods: the 50 MB log in a loop.
- **Ctrl+C.** The on-screen terminal runs the same flood. After 2 s, Ctrl+C
  goes through the typing path. Timed: until the process has exited, and until
  the last output is parsed, which is what the person waits for.
- **Main thread.** WebKit has no long-task observer, so a 4 ms timer measures
  how late it fires. A gap over 50 ms is a long task. Frames are counted with
  `requestAnimationFrame`.
- **Memory.** `phys_footprint` (what Activity Monitor shows) of the app's
  WebContent and GPU processes, read with `footprint` before, during (peak of
  500 ms samples) and 5 s after each run. WebKit's processes are children of
  launchd, so the script finds them by asking which app each is responsible
  to. There is no JavaScript heap figure: WKWebView does not expose one.
- **Churn** (`--scenarios churn`). 30 terminals are created, filled with
  10,000 lines and disposed, with no process and no view, in five variants
  (never shown; on screen; with WebGL; focused; with a process and closed
  through the store). A `FinalizationRegistry` counts how many the garbage
  collector takes back. This is what separates a leak in xterm or its renderer
  from one in the app.
- **Soak.** Through the app's own stores and views: open 4 sessions, each with
  a terminal that fills its 10,000-line scrollback; open and close 50 terminal
  tabs; switch sessions 200 times; delete the sessions. The same terminals are
  open after the first three steps, so memory should be flat across them. The
  terminals the tab step closes are tracked the same way as in the churn.

## Baseline

Taken 2026-10-02 at `e4c3ea6`, on a 12-core Apple silicon Mac with 24 GB,
macOS 27.0, a `--debug` bundle (Rust `opt-level` 1, dependencies 2; the web
side is the production bundle), window 1360 × 520 at 2× (190 × 24 cells),
visible but not focused. The matrix and the soak each ran on a fresh app.

### Throughput

| Workload | Terminals | Drain (s) | MB/s | Long tasks | Longest block (ms) | Frames/s | WebContent + GPU memory before → peak → after (MB) | Renderer on screen | WebGL / DOM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yes \| head -n 2000000` | 1 | 2.02 | 2.8 | 0 | 18 | 59.5 | 158 + 124 → 340 + 230 → 304 + 147 | webgl | 1 / 0 |
| `yes \| head -n 2000000` | 8 | 2.06 | 2.8 | 0 | 15 | 60 | 304 + 147 → 481 + 226 → 359 + 144 | webgl | 8 / 0 |
| `yes \| head -n 2000000` | 20 | 2.08 | 2.7 | 0 | 8 | 59.8 | 359 + 144 → 491 + 151 → 360 + 140 | dom | 16 / 4 |
| `cat` of a 50 MB log | 1 | 0.61 | 82.5 | 0 | 34 | 51.5 | 360 + 140 → 566 + 223 → 378 + 147 | webgl | 1 / 0 |
| `cat` of a 50 MB log | 8 | 0.55 | 90.3 | 0 | 30 | 49.2 | 378 + 147 → 513 + 224 → 441 + 147 | webgl | 8 / 0 |
| `cat` of a 50 MB log | 20 | 0.54 | 92.8 | 0 | 23 | 49.2 | 441 + 147 → 511 + 153 → 378 + 145 | dom | 16 / 4 |
| Agent-style redraws, 4,000 frames | 1 | 0.11 | 66.7 | 0 | 19 | 50 | 378 + 145 → 441 + 222 → 381 + 148 | webgl | 1 / 0 |
| Agent-style redraws, 4,000 frames | 8 | 0.09 | 82.0 | 0 | 18 | 48.8 | 381 + 148 → 490 + 227 → 363 + 146 | webgl | 8 / 0 |
| Agent-style redraws, 4,000 frames | 20 | 0.13 | 55.3 | 0 | 34 | 54.1 | 363 + 143 → 503 + 154 → 368 + 150 | dom | 16 / 4 |

### Typing echo

| Terminals | Renderer on screen | Load in the other tab (MB/s) | Echo p50 (ms) | Echo p95 (ms) | Echo max (ms) | To frame p50 (ms) | To frame p95 (ms) | Lost | Long tasks | Longest block (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | webgl | none | 13 | 14 | 19 | 21 | 28 | 0 | 0 | 9 |
| 8 | webgl | 100.6 | 21 | 32 | 41 | 28 | 51 | 0 | 6 | 67 |
| 20 | dom | 100.2 | 21 | 31 | 46 | 28 | 48 | 0 | 6 | 70 |

### Ctrl+C during a flood

| Terminals | Renderer on screen | Flood before Ctrl+C (s) | Ctrl+C → process exit (ms) | Ctrl+C → output stops (ms) | Output received after Ctrl+C (MB) | Longest block (ms) | Frames/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | webgl | 2 | 15 | 604 | 0.6 | 54 | 43.6 |
| 8 | webgl | 2 | 12 | 593 | 3.0 | 33 | 44.6 |
| 20 | dom | 2 | 11 | 589 | 3.1 | 32 | 45.3 |
| 1 | webgl | 8 | 15 | 496 | 0.6 | 167 | 39.9 |

The last row ran on the app the soak had already left at 1.1 GB; its
WebContent process peaked at 1.77 GB during the flood.

### Soak

| After | WebContent (MB) | GPU (MB) | Main (MB) | xterm instances | WebGL / DOM | Contexts created / lost | Buffer lines | Replay buffers (bytes) | Panes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 sessions open (baseline) | 347 | 236 | 40 | 8 | 8 / 0 | 8 / 0 | 40,168 | 0 (0) | 8 |
| 50 tabs opened and closed | 1,209 | 56 | 42 | 8 | 0 / 8 | 58 / 8 | 40,168 | 46 (276) | 8 |
| 200 session switches | 1,231 | 52 | 34 | 8 | 0 / 8 | 58 / 8 | 40,168 | 46 (276) | 8 |
| Sessions deleted, terminals closed | 1,247 | 154 | 34 | 0 | 0 / 0 | 58 / 8 | 0 | 48 (490) | 0 |

Right after the sessions were deleted, all 8 of their panes and xterm
instances were still held; the benchmark then closed them itself.

Each session shows 2 terminals: the app opens a shell for a session with no
agent, and the soak adds the one that fills its scrollback.

## What the baseline says

Against the acceptance criteria of the issue:

| Criterion | Baseline | Met |
| --- | --- | --- |
| Typing echo under one frame (16.7 ms) at p95 while another tab floods | 31–32 ms to parse, 48–51 ms to the frame | No |
| `cat` of 50 MB does not freeze the app | 0.55–0.61 s, no long task | Yes |
| Ctrl+C takes effect within 200 ms | The process exits in 11–15 ms, but output keeps arriving for 500–600 ms | No |
| Web view memory after the soak within 10% of the baseline | 347 MB → 1,231 MB (3.5 times) | No |
| No terminal silently on the DOM renderer with 20 or more terminals | 4 of 20; after the soak, 8 of 8 with only 8 terminals open | No |

Findings, most important first:

1. **Closed terminals keep their WebGL contexts, and live ones pay for it.**
   Opening and closing 50 tabs left every one of the 8 live terminals on the
   DOM renderer, although only 8 terminals were open. WebKit allows about 16
   contexts and takes away the oldest, and the oldest are the long-lived
   terminals. Nothing releases a disposed terminal's context
   (`loseContext()` is never called), so closed terminals still count against
   the limit, and a terminal that loses its context is never given one back. This is the "unreliable" part of the report: after
   enough tab churn every terminal is silently on the fallback renderer.
2. **Web view memory grows with every terminal opened and does not come
   back.** The same 50 open-and-close cycles took the WebContent process from
   347 MB to 1.2 GB, about 17 MB per closed terminal, and closing everything
   did not return it. Session switching itself added almost nothing (22 MB
   over 200 switches). The numbers in the issue (215–266 MB per WebContent
   process) are what a fresh window measures here; a long session is far
   above that.
3. **Deleting a session does not close its terminals.** Its panes and xterm
   instances stay until the window reloads.
4. **Output that arrives after a pane is closed starts a replay buffer that
   nothing ever drops.** 46 buffers after 50 closes. They are small here
   (6 bytes each) but each may grow to 256 KB.
5. **Typing echo is not under a frame even when idle.** 13 ms at p50 with
   nothing else running, of which up to 8 ms is the output batching window in
   `pty.rs`, and 21 ms to the frame. With a flood in another tab it is
   21 / 32 ms (p50 / p95) to parse and 28 / 51 ms to the frame, with 6 long
   tasks of up to 70 ms in 14 s: the hidden terminal's output is parsed on the
   same thread.
6. **There is no flow control.** A flood reaches the window at about
   100 MB/s. After Ctrl+C the process is gone in 15 ms, but the window is
   still working through what it already has for half a second, and
   WebContent memory rises by 100–650 MB while a flood runs.
7. **Raw throughput is not the problem on this machine.** 50 MB drains in
   0.55 s (about 90 MB/s) with no long task, at 1, 8 and 20 terminals, on
   WebGL and on the DOM renderer alike. `yes | head` is held to 2.8 MB/s by
   the pipe and PTY, not by the app. The benchmark does not reproduce "very
   slow" on a fresh window; what it reproduces is the state a long session
   ends in (findings 1 and 2).
8. **The status bar cannot see the web view's memory on macOS.**
   `status_resource_sample` sums the app's child processes, and WebKit's
   processes are launchd's children, so `webviewRssBytes` is always empty
   there. Not changed here; the benchmark reads the processes itself.

Limits of this baseline: one machine; a debug Rust build; `phys_footprint`
rather than a heap snapshot, so memory that WebKit would give back under
pressure counts as held; the soak uses shell terminals, not agent CLIs; cloud
terminals are counted (`data.cloud`) but no cloud scenario was run, because
the local cloud stack was in use by another session.

## Changes since the baseline

Each entry is one pull request, measured with the same benchmark on the same
machine, with the matrix and the soak each on a fresh app.

### WebGL contexts are budgeted and released; closed terminals are freed

**Cause of the memory growth.** `@xterm/addon-webgl` 0.19.0 never disposes its
cursor-blink timer: the field that holds it is not registered with the
renderer's disposables. A terminal that has focus when it is closed, which is
the usual way to close one, leaves an interval running for good. The interval
keeps the renderer, its WebGL context and the terminal with its whole
scrollback reachable. The churn scenario isolates it: every variant gave its
terminals back except the focused one.

| Churn variant (30 terminals) | Collected before | Collected after |
| --- | --- | --- |
| Never shown | 24 of 30 | 24 of 30 |
| On screen, DOM renderer | 29 of 30 | 29 of 30 |
| On screen, WebGL | 29 of 30 | 29 of 30 |
| On screen, WebGL, focused | **0 of 30** (WebContent 344 → 1,222 MB) | 29 of 30 (161 → 171 MB) |
| On screen, WebGL, with a process, closed through the store | 29 of 30 | 29 of 30 |

**What changed** (`src/lib/terminalWebgl.ts`):

- The blink timer is stopped when a terminal lets go of its renderer.
- A terminal gets a WebGL context when a view shows it, not when it is
  created. The 6 most recently shown hidden terminals keep theirs; the rest
  draw with the DOM renderer, which does nothing while hidden.
- A context is released (`WEBGL_lose_context`) when its terminal is closed or
  goes over the budget.
- When WebKit takes a context from a terminal that is on screen, it gets a new
  one at once, on the `webglcontextlost` event, instead of staying on the DOM
  renderer. A hidden one gets a new one when it is next shown.

**Soak, before → after:**

| After | WebContent (MB) | Terminals on screen that are on the DOM renderer | Live terminals on WebGL / DOM | Closed terminals collected |
| --- | --- | --- | --- | --- |
| 4 sessions open (baseline) | 347 → 345 | 0 → 0 | 8 / 0 → 6 / 2 | |
| 50 tabs opened and closed | 1,209 → 1,153 | 1 → 0 | 0 / 8 → 1 / 7 | not measured → 2 of 50 |
| 200 session switches | 1,231 → **323** | 1 → 0 | 0 / 8 → 4 / 4 | not measured → 50 of 50 |
| Sessions deleted, terminals closed | 1,247 → 329 | | | 50 of 50 |

- Memory after the soak is now 0.94 times the baseline (was 3.5 times). The
  1,153 MB right after the tab step is garbage that WebKit had not collected
  yet (2 of 50 terminals at that point); it is gone by the next reading.
- No terminal on screen is on the DOM renderer at any point, in the soak or
  with 20 terminals open (was 4 of 20, and 8 of 8 after the soak).
- WebKit still took 6 contexts during the tab step, all from hidden
  terminals: `loseContext()` does not free WebKit's slot, only collecting the
  context does, and that lags. The terminals affected get a new context when
  shown.
- Throughput, typing echo and Ctrl+C are unchanged, as expected: `cat` of
  50 MB in 0.55–0.69 s, echo p95 31–32 ms under a flood, output for about
  630 ms after Ctrl+C.
- 200 session switches created 3 contexts, so switching between recently
  used terminals does not pay for a new context.

Still open from the baseline: findings 3 to 6 and 8.
