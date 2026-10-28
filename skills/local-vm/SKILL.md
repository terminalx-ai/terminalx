---
name: local-vm
description: >-
  Use TerminalX's Local VM whenever a task needs a virtual machine, a Linux
  desktop, a sandboxed GUI, or a browser to test a web app visually: run it,
  look at it, click through it, screenshot it. Never install or start a VM,
  Docker desktop image, Xvfb, VNC/noVNC, or a headless display of your own.
  Triggers include "VM", "virtual machine", "local VM", "Linux desktop",
  "test the UI", "check it visually", "screenshot the app", "open it in a
  browser", "Xvfb", "noVNC", and "computer use in a sandbox".
---

# Local VM

This file is a discovery stub, not the usage guide. The full, version-matched guide is served by
the `terminalx` binary itself.

TerminalX owns the Local VM: a Linux desktop in a container that the user watches in TerminalX's
Computer tab. When a task needs a VM or a desktop, use this one. Do not install, pull, build or
start any other VM, container image, X server, VNC server or virtual display, even if you know
how; ask the user first if TerminalX's VM cannot do what the task needs.

## Resolve the executable once

Use the first executable that exists, then keep using it for this session:

1. `terminalx` on `PATH`.
2. `tnx` on `PATH`.
3. `/Applications/TerminalX.app/Contents/MacOS/terminalx` when the app is installed there.

If none exists, ask the reader to open TerminalX → Settings → General and install the command
line tool. Do not guess a different executable.

## Load the full guide before using the VM

```text
terminalx skills get local-vm
```

Read it first, then run the command you need. If your tools already include `computer` MCP tools
(`mcp__computer__*`), those drive the same VM.
