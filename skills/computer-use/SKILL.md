---
name: computer-use
description: >-
  Use TerminalX's computer-use CLI to inspect and operate local desktop app windows
  through accessibility trees, screenshots, and safe UI actions. Use for
  desktop app interaction: list apps/windows, get app state, read visible UI,
  click controls, type, press keys, scroll, drag, set values, or perform
  accessibility actions. Also use for browser windows, webviews, TerminalX app UI,
  or other desktop UI. Triggers include "computer use", "terminalx computer", "read
  Spotify", "read Slack", "control/click/read in a desktop app", and "get app
  state".
---

# Computer Use

This file is a discovery stub, not the usage guide. The full, version-matched computer-use
reference is served by the `terminalx` binary itself — kept out of this file on purpose so it can
never drift from the binary that will actually run your commands.

Engage TerminalX's computer-use surface whenever you must inspect or operate a local desktop app
window — reading its accessibility tree, taking screenshots, or performing safe UI actions
(click controls, type, press keys, scroll, drag, set values). It also covers browser
windows, webviews, and TerminalX's own UI. Triggers include "computer use", "terminalx computer",
"read Spotify", "read Slack", "control/click/read in a desktop app", and "get app state".

## Resolve the executable once

Use the first executable that exists, then keep using it for this session:

1. `terminalx` on `PATH`.
2. `tnx` on `PATH`.
3. `/Applications/TerminalX.app/Contents/MacOS/terminalx` when the app is installed there.

If none exists, ask the reader to open TerminalX → Settings → General and install the command
line tool. Do not guess a different executable or subcommand.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different TerminalX build.

## Load the full guide before running TerminalX commands

```text
terminalx skills get computer-use
```

Substitute the executable chosen above when it was not `terminalx`. That prints the complete,
version-matched guide for the exact binary that will handle your next commands — listing
apps/windows, reading UI, and driving clicks, typing, and other accessibility actions. Read it
first, then run the specific command you need.

Don't guess subcommands or flags from memory or from a cached copy of this stub. They
change between TerminalX releases, and this file deliberately no longer lists them. Confirm the
app is up with `terminalx status --json`, and prefer `--json` for agent-driven calls.

## If an older TerminalX does not recognize `skills get computer-use`

Use this fallback only when the selected binary explicitly reports that the command is
unknown or that it does not embed a guide named computer-use. Another failure is not proof of an
older binary; report it rather than guessing or changing executables. For a confirmed pre-guide
binary, use only this bounded, read-only bootstrap to orient. Do not dead-end and do not invent
commands:

```text
terminalx status --json
terminalx computer capabilities --json
terminalx computer list-apps --json
```

Then tell the user that updating TerminalX restores the full, version-matched guide via
`terminalx skills get computer-use`. Beyond these commands, ask the user rather than guessing a
command surface this older binary may not support.
