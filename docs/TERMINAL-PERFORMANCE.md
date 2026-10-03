# Terminal performance and memory

Issue [#232](https://github.com/terminalx-ai/terminalx/issues/232): the
terminal view was reported slow and unreliable, with memory growing over a
long session. This document records how that is measured, the numbers, and
what they point to. It is updated by each change that moves a number.

## The path being measured

```
program ──▶ PTY ──▶ pty-read thread ──▶ pty-emit thread ──▶ the pane's channel
                    (16 KB reads)       (batches of up to    (raw bytes, to the
                         ▲               8 ms / 32 KB; the    one xterm showing
                         │               first output after   this pane)
                 held while the view     a quiet spell goes        │
                 is 1 MB behind          at once)                  ▼
                         └──────────── acknowledgements ◀──── xterm.js ──▶ WebGL
```

One xterm.js instance per terminal lives for as long as the terminal does
(`src/lib/terminal.ts`). It is in the document, and has a WebGL context, only
while a view shows it (`src/components/terminal/TerminalView.tsx`,
`src/lib/terminalWebgl.ts`). The baseline below was measured on the path as
it was before: output base64-encoded in a JSON event broadcast to the window,
no acknowledgements, and a WebGL context per terminal from creation.

## Counters

`terminalx status --json` reports what the terminals hold, under `terminals`:

- `backend`: PTY panes, how many are running, scrollback bytes held, the
  output batches and bytes sent since launch, how many panes have a view
  attached (`views`), and how many bytes those views have yet to draw
  (`unackedBytes`: around 1 MB per pane that is being held back).
- `webview`: live xterm instances and how many are in the document, how many
  are on WebGL and how many on the DOM renderer, how many a view is showing
  (`onScreen`), how many of those are on the DOM fallback (`domOnScreen`,
  which should be 0) and how many are in the document with no view showing
  them (`hiddenInDocument`, which should be 0: such a terminal draws all its
  output for nobody), WebGL contexts created / lost / refused since the window
  loaded, buffer lines held, and output events and bytes per second (local
  and cloud). It is `null` when the window did not answer within 500 ms.

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
- **Background** (`--scenarios background`). The app is hidden through System
  Events, by process id, and a pane runs `cat` of the 50 MB log, once as a
  shell and once as an agent's pane. Timed: until the program has exited.
  Nothing in this scenario waits for a frame, which a hidden page never gets.
- **Covered** (`--scenarios covered`). A real session with two shell tabs:
  the one behind prints an agent-style stream for 10 s while the other is
  selected. Counted: how often xterm draws the covered one (`onRender`). The
  other scenarios host their terminals themselves, so only this one and the
  soak go through the app's views.
- **Soak.** Through the app's own stores and views: open 4 sessions, each with
  a terminal that fills its 10,000-line scrollback; open and close 50 terminal
  tabs; open and close 20 agent tabs (against a stand-in CLI); switch
  sessions 200 times; delete the sessions. The same terminals are
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

**What changed:**

- The blink timer is stopped when a terminal lets go of its renderer
  (`src/lib/terminalWebgl.ts`).
- A terminal gets a WebGL context when a view shows it, not when it is
  created. The 6 most recently shown hidden terminals keep theirs.
- A context is released (`WEBGL_lose_context`) when its terminal is closed or
  goes over the budget.
- When WebKit takes a context from a terminal that is on screen, it gets a new
  one at once, on the `webglcontextlost` event, instead of staying on the DOM
  renderer. A hidden one gets a new one when it is next shown.
- **A terminal that is not shown is not in the document**
  (`src/components/terminal/TerminalView.tsx`). A covered terminal (an
  agent's terminal under its chat, a shell tab behind another) used to stay
  in the document with `visibility: hidden`, and xterm pauses drawing only
  for what an IntersectionObserver calls hidden, which that is not. It drew
  every frame of output for nobody.
- **A terminal's size no longer depends on its renderer**
  (`src/lib/terminalFit.ts`). xterm's fit addon uses the active renderer's
  cell width, and WebGL floors it to device pixels where the DOM renderer
  does not, so a renderer swap could change the column count and resize the
  program. The size is now computed from the measured character size, as
  WebGL draws it, from the view's box alone. That is also what lets a
  terminal follow its box while it is out of the document.

**Covered terminal** (`--scenarios covered`: a shell tab behind the selected
one prints an agent-style stream for 10 s):

| | Times xterm drew it | Renderer | In the document |
| --- | --- | --- | --- |
| Baseline (`a68e6e1`) | 86 | WebGL | yes |
| After | 0 | none needed | no |

**Soak, before → after:**

| After | WebContent (MB) | Terminals on screen that are on the DOM renderer | Live terminals on WebGL / DOM | Closed terminals collected |
| --- | --- | --- | --- | --- |
| 4 sessions open (baseline) | 347 → 300 | 0 → 0 | 8 / 0 → 6 / 2 | |
| 50 tabs opened and closed | 1,209 → 1,143 | 1 → 0 | 0 / 8 → 1 / 7 | not measured → 4 of 50 |
| 200 session switches | 1,231 → **344** | 1 → 0 | 0 / 8 → 4 / 4 | not measured → 50 of 50 |
| Sessions deleted, terminals closed | 1,247 → 350 | | | 50 of 50 |

- Memory after the soak is 1.15 times the baseline in this run (was 3.5
  times). Three runs of an earlier revision of the same change gave 0.93 to
  0.96 times; the readings move by some 30 MB with when WebKit collects.
  The 1,143 MB right after the tab step is garbage it had not collected yet
  (4 of 50 terminals at that point); it is gone by the next reading.
- No terminal on screen is on the DOM renderer at any point, in the soak or
  with 20 terminals open (was 4 of 20, and 8 of 8 after the soak).
- WebKit still took 6 contexts during the tab step, all from the hidden
  terminals holding one under the budget. `loseContext()` is called for every
  closed terminal, yet the closed terminals' contexts keep counting against
  WebKit's limit until they are collected, and that lags. The terminals
  affected get a new context when shown.
- Throughput, typing echo and Ctrl+C are unchanged, as expected: `cat` of
  50 MB in 0.56–0.66 s, echo p95 31 ms under a flood, output for about
  600 ms after Ctrl+C.
- 200 session switches created 3 contexts, so switching between recently
  used terminals does not pay for a new context.

### A deleted session's terminals are closed; stray output is dropped

- Deleting a session, or the workspace it ran in, now closes its terminals:
  the window drops their panes and xterm instances, and the backend kills the
  session's shells (it already stopped the agent tabs). Before, the shells
  kept running and their buffers stayed in the window until it was reloaded.
- When a session's worktree is removed and the session stays listed, its
  shells are closed; its agent panes are left to their tabs.
- Output that arrives within 5 s after a pane was closed is dropped instead of
  starting a replay buffer. Opening a pane under the same id again keeps its
  output from that moment.

| Soak | Before | After |
| --- | --- | --- |
| Panes and xterm instances still held right after the sessions were deleted | 8 and 8 | 0 and 0 |
| Replay buffers left after 50 tabs were closed | 45–48 | 0 |
| Replay buffers left at the end of the run | 48–51 | 0 |

Memory is as in the entry above (344 MB baseline, 320 MB after the soak).

### A closed agent tab's terminal is dropped

Closing an agent tab stopped its CLI but left its pane and its xterm in the
window, with the whole scrollback, until its session was deleted. The window
now drops both when a tab is closed, and when the backend reports a session
with fewer tabs.

The soak has a step for it: 20 agent tabs opened and closed through the
app's own tab functions. They run `scripts/remote-runtime/fake-claude`, which
`bench-app.sh` puts first on the app's path together with a `HOME` of its
own, so no real agent runs and nothing is written under the real home.

| After 20 agent tabs were opened and closed | Before | After |
| --- | --- | --- |
| xterm instances (8 belong to the open sessions) | 28 | 8 |
| Panes | 28 | 8 |
| Of the 20 closed terminals, collected by the end of the run | 0 | 20 |

An archived session still keeps its terminals.

### Output over a raw channel per pane, with flow control

**What the baseline hid.** With output as a broadcast event and nothing
holding the program back, a flood reached xterm faster than it parses, and
past 50 MB of backlog xterm.js throws output away. The app logged about
91,000 `write data discarded` errors in one run of the matrix on the old
path. That is where the 500–600 ms of output after Ctrl+C came from, and the
"100 MB/s" in the typing-echo rows was largely output being dropped.

**What changed** (`src-tauri/src/pty.rs`, `src/lib/terminalFeed.ts`):

- A view attaches to its pane (`pty_attach`) and gets the pane's output as
  raw bytes on a `tauri::ipc::Channel` of its own: no base64, no JSON, and no
  other listener. It is handed the backend's scrollback first, with nothing
  lost or repeated in between, so the window no longer keeps replay buffers,
  and a pane no view has shown costs the window nothing.
- The view acknowledges what xterm has parsed, as a running total, about
  every 256 KB. A pane that is more than 1 MB ahead of its view is not read
  until the view catches up, so the program waits on its own output as it
  would in any terminal. A total that is lost on the way is made good by the
  next one.
- A **shell** that is not on screen is acknowledged at about 5 MB/s. Its
  output is still parsed in order and in full, but a flood in a hidden tab no
  longer takes the main thread from the terminal being typed in.
- An **agent's pane** is never slowed for not being looked at: it is
  acknowledged as fast as xterm parses, shown or not.
- **Nothing is held for a hidden window.** WebKit runs a hidden page's timers
  about once a second, and xterm parses on timers, so a page in that state
  acknowledges output as it arrives and every program runs at full speed, as
  before there was flow control.
- The first output after a quiet spell is sent at once instead of after the
  8 ms batching window. That is a key's echo.
- A view that says nothing for 2 s while its pane is held (a frozen window)
  stops being waited for until it speaks again, and what it was silent on is
  written off, so a program can never hang, or be held back for good, on a
  window that is not drawing or on bytes that never arrived.
- A pane keeps one slot for its views for as long as it lives. A view that
  detaches and attaches again, a page that is reloaded, and a view that
  attaches before or after its pane was spawned all get the scrollback and
  then everything after it. A reloaded page drops the attachments of the page
  before it, and a view attaches only after that.
- A pane's exit is announced after the last of its output.
- The `pty_data` event is still emitted for the listeners in the backend (the
  mobile reader, the remote runtime); the window no longer listens to it.

**Where memory is not bounded.** Flow control bounds what is in flight to
about 1 MB per pane only while the window is visible and answering. While a
window is hidden, or for the 2 s it takes to decide a view has stalled and
from then until it speaks again, output is sent as fast as the program
prints, and waits in the page (Tauri's channel queue, then xterm's write
buffer, which discards past 50 MB). That is what happened on every flood
before this change; it is not made worse, and it is not fixed.

Cloud terminals already have their own bounded stream: the runtime keeps a
ring per terminal and a reader that falls behind resumes from it, so they are
not part of this change. They share the view, and so the earlier ones.

**Before → after** (before: the entry above, same machine and build type):

| | Before | After |
| --- | --- | --- |
| Typing echo, nothing else running, p50 / p95 | 12 / 14 ms | 1 / 3 ms |
| Typing echo, a flood in another tab, p50 / p95 | 20–21 / 31 ms | 1 / 1–4 ms |
| Key press to the frame showing it, p95 | 29 ms idle, 50–52 ms under a flood | 16–17 ms in both |
| Long tasks during 14 s of typing under a flood | 5–6, up to 57 ms | 0 |
| Ctrl+C to the last output, during a flood | 605–647 ms | 6–15 ms |
| Writes xterm discarded in the matrix | about 91,000 | 0 |
| `cat` of a 50 MB log | 0.56–0.66 s, 76–90 MB/s | 0.51–0.61 s, 82–98 MB/s |
| Agent-style redraws, 4,000 frames | 0.09–0.12 s | 0.10–0.13 s |
| WebContent memory after the soak (baseline → after) | 300 → 344 MB | 364 → 377 MB |

- The after column is from 2026-10-03, on a machine that other sessions were
  loading heavily (load average 43 to 73 over the preceding fifteen minutes).
  In the matrix run itself `cat` took 0.71, 1.70 and 5.30 s with 1, 8 and 20
  terminals, and `yes | head` 3.6–4.2 s; a repeat a few minutes later gave
  the `cat` figures in the table and `yes | head` at 2.1–4.0 s. On 2026-10-02,
  with the machine quiet, `yes | head` was 2.0–2.1 s. It is limited by the
  pipe and the PTY, not by the app.
- A flood in a hidden shell now runs at about 5 MB/s instead of as fast as
  the PTY carries it. That is the trade for the typing numbers above.
- Key press to frame is bounded by the display: 17 ms is one frame at 60 Hz.

**With the window hidden** (`--scenarios background`: the app is hidden as
when the person works in another app, and a pane runs `cat` of the 50 MB
log):

| | Acknowledged on parse, hidden or not (first revision of this change) | Now |
| --- | --- | --- |
| The program has exited after | not within 180 s; 18 of 50 MB read after about six minutes | 0.75 s in a shell, 0.71 s in an agent's pane |

A program must not be slowed because nobody is looking at the window, an
agent's CLI least of all. The first revision of this change held the pane for
a page whose timers WebKit had all but stopped.

**In the real window** (`scripts/perf/verify-agent-terminal.mjs`). The
benchmark attaches its own terminals in its own order, and that hid two
defects in the first revision: an agent tab's terminal stayed blank after a
launch, and a view that attached a second time got the scrollback and nothing
after it. This script goes through the app's launch, its session and tab
views and a page reload, with the stand-in agent CLI, and checks that the
reply to a prompt appears in the tab's terminal:

| | First revision | Now |
| --- | --- | --- |
| An agent started from the CLI, once its session is opened | scrollback only | live |
| An agent tab after a launch | blank | live |
| An agent tab after the page is reloaded | scrollback only | live |

All five acceptance criteria of the issue are met on this machine (memory
after the soak 1.04 times the baseline in this run).

Still open from the baseline: finding 8 (the status bar cannot see the web
view's memory on macOS). Not done: an archived session keeps its terminals,
and there is no cap on how many idle xterm instances are kept.
