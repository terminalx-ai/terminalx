---
name: local-vm
description: >-
  Use TerminalX's Local VM whenever a task needs a virtual machine, a Linux
  desktop, a sandboxed GUI, or a browser to test a web app visually. Never
  install or start a VM, desktop image, Xvfb or VNC of your own.
---

# Local VM

TerminalX's Local VM is a Linux (XFCE) desktop in a container on this machine, with Firefox. The
user can open its viewer in TerminalX's right panel, Computer tab, and take control. Routine
agent actions work in the background; opening the viewer is optional.

The shared environment inventory also lists enrolled macOS Lume guests. Linux currently supports
attached desktop tools; macOS supports explicitly submitted guest tasks. Selecting a computer does
not move the host agent, shell or files. Linux guest-task execution and attached macOS desktop tools
are not supported by these routes. Fresh secure macOS creation remains unavailable in the pinned profile.

In Computer, select an existing Linux environment and attach its desktop tools to the stopped agent
tab before starting it. That exact runtime and container ID are retained for this conversation and
used for its `computer` MCP. Starting a container does not attach it to every agent. Stop this tab's
agent before changing the attachment. A missing/stopped/replaced target fails rather than silently
choosing the host, another container or another OS. For macOS, use the conversation's Local VM tasks
picker and capability check; only the selected prompt and files are submitted to the exact guest generation.

## Rules

- Use only this VM. Do not install, pull, build or start another VM, container image, X server,
  VNC/noVNC server or virtual display, and do not change the user's Docker or Podman setup.
- Servers on this machine are reached from inside the VM at `http://host.docker.internal:<port>`,
  not `localhost`. Start the app's dev server on this machine as usual, then open that URL in the
  VM's Firefox.
- The user may be watching or holding control. Keep actions purposeful, and stop if the screen
  changes under you in a way you did not cause.

## Commands

Use the executable you resolved (`terminalx`, `tnx`, or the app's own binary). Add `--json` for
machine-readable output.

```text
terminalx vm inventory --json       # existing Linux/macOS identities and supported routes
terminalx vm status                  # no_runtime, runtime_down, not_created, stopped or running
terminalx vm start                   # start it (the first start downloads about 450 MB)
terminalx vm screenshot --target TARGET_JSON [--out PATH] # the whole screen as a PNG on this machine; read it to see it
terminalx vm tools [TOOL] --target TARGET_JSON            # the driver's tools, or one tool's argument schema
terminalx vm call TOOL [JSON] --target TARGET_JSON        # run one tool in the VM
terminalx vm stop
```

For `tools`, `call` and `screenshot`, copy the selected Linux entry's complete `target` object from
`vm inventory` into `--target`, shell-quoted as one JSON argument. Keep that object for the task;
never refresh it to a replacement implicitly. Missing or incompatible identities are refused.

When `status` is not `running`:

- `no_runtime`: Docker or Podman is not installed. Tell the user; do not install it yourself.
- `runtime_down`: Docker or Podman is installed but not running. Ask the user to start it (the
  Computer tab has a button for it); do not start it yourself.
- `not_created` or `stopped`: run `terminalx vm start`.

## Driving it

The tools come from the VM's computer-use driver and change with its version, so read their
schemas with `terminalx vm tools TOOL --target TARGET_JSON` before calling one you have not used this session.
Most actions target a window: `pid` and `window_id` from `list_windows`, and an `element_index`
from `get_window_state` (preferred over pixel coordinates).

A typical check of a web app:

1. `terminalx vm inventory --json`; choose the exact supported target. Start it only when authorized, then explicitly select its resulting identity.
2. Start the dev server on this machine as usual (say on port 3000).
3. Open it in the VM's browser:
   `terminalx vm call --target TARGET_JSON launch_app '{"name":"firefox","urls":["http://host.docker.internal:3000"]}'`
4. `terminalx vm screenshot --target TARGET_JSON` and read the PNG.
5. To interact: `terminalx vm call --target TARGET_JSON list_windows '{}'` for the window, `get_window_state` with its
   `pid` and `window_id` for elements, then `click` / `type_text` / `hotkey` with them. Take a
   screenshot after each step that should change the screen.
