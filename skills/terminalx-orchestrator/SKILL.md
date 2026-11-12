---
name: terminalx-orchestrator
description: >-
  Decide whether and how to split a large task across worker sessions with TerminalX
  orchestration runs. Use when asked to split, parallelise, fan out or delegate a large task,
  to "use workers", "use subagents", "run this as an orchestration run", or when a task is
  too wide for one session's context. Covers when not to split, how many pieces, how to cut
  them, how to brief a worker, how to write the plan for `runs create`, and how to read and
  check worker reports.
---

# TerminalX orchestrator

This file is a discovery stub, not the guide. The full, version-matched guide is served by the
`terminalx` binary itself.

Most tasks should stay in one session. The guide gives the gate that decides it, and what to do
when the answer is to split.

## Resolve the executable once

Use the first executable that exists, then keep using it for this session:

1. `terminalx` on `PATH`.
2. `tnx` on `PATH`.
3. `/Applications/TerminalX.app/Contents/MacOS/terminalx` when the app is installed there.

If none exists, ask the reader to open TerminalX → Settings → General and install the command
line tool. Do not guess a different executable.

## Load the guide before splitting anything

```text
terminalx skills get terminalx-orchestrator
```

Read it first, then plan. The commands it uses are in `terminalx skills get terminalx-cli`.
