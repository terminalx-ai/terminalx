---
name: terminalx-cli
description: Drive a running TerminalX app through its authenticated terminalx command-line interface. Use for project, session, tab, transcript, permission, worktree, and issue operations owned by the app.
---

# TerminalX CLI

This file is a discovery stub, not the usage guide. The complete guide is embedded in the
installed CLI so its commands and recovery advice always match the binary that will run them.

## Resolve the executable once

Use the first executable that exists, then keep using it for this session:

1. `terminalx` on `PATH`.
2. `tnx` on `PATH`.
3. `/Applications/TerminalX.app/Contents/MacOS/terminalx` when the app is installed there.

If none exists, ask the reader to open TerminalX → Settings → General and install the command
line tool. Do not guess a different executable or subcommand.

## Load the version-matched guide

Run:

```text
terminalx skills get terminalx-cli
```

Substitute the executable chosen above when it was not `terminalx`. Read the returned guide
before issuing another command. Prefer `--json` for agent-driven commands.

If this exact `skills get` command is reported as unknown, use only this bounded, read-only
fallback:

```text
terminalx status --json
terminalx projects list --json
terminalx sessions list --json
```

Then ask the reader to update TerminalX. Never infer or guess additional subcommands from the
fallback.
