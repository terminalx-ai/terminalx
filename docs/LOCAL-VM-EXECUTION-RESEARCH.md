# Linux and macOS environments: comparison with other agent tools

Checked 2026-10-27 against public first-party documentation and source. This is
research, not a live product comparison or performance benchmark. No competing
application, container or VM was launched. TerminalX source baseline is
`ea51b8de2fccfbebfe0582155905485693da0da0`, including main `5a1c8723`.

The user's name “Open Mause Bot” is unresolved. OpenManus is a plausible match;
OpenClaw is included separately rather than treating them as the same project.

## Finding

The location of the agent controller and the location of its actions are
separate choices. A controller outside a guest can direct its browser, desktop,
shell and files through a bound interface. Alternatively, an agent worker can
run inside the guest. The UI should explain what executes in the selected
environment; it should not require the user to choose process architecture.

## What the products actually do

| Product | Execution model | Implication for TerminalX |
| --- | --- | --- |
| Conductor local | A workspace is a Git worktree on the Mac. Commands and agents retain the user's host permissions; a worktree is not an OS sandbox. | Useful workspace UX, but not evidence that local desktop work is isolated. |
| Conductor Cloud | A cloud workspace receives an isolated Linux sandbox with the development environment. | An environment is a coherent place for code and execution. |
| Cursor Cloud | A managed VM contains the development environment and a desktop the agent can operate. | Treat computer use as a capability of the execution environment. |
| Cursor self-hosted | The agent loop is in Cursor's cloud; a worker performs commands, edits and computer actions on the selected machine. | The agent loop need not move into the machine whose tools it uses. |
| OpenHands | A remote conversation connects to an agent server in a Docker or remote workspace; the server runs the agent and streams events. | A common workspace interface can hide backend differences. |
| OpenManus | Default local tools and the separate Daytona-backed SandboxManus are different execution paths. | A sandbox flag alone does not establish consistent placement of all tools. |
| OpenClaw | The host gateway can dispatch tools into a configured sandbox, with an optional sandboxed browser. | External orchestration and guest tool execution can coexist. |

### Conductor

Its worktree documentation explicitly separates checkout isolation from a
security boundary. Local commands still execute with the Mac user's access.
[Git worktrees](https://www.conductor.build/docs/concepts/git-worktrees).

The current security reference distinguishes local execution from cloud Linux
sandboxes hosted by Vercel, including the different storage and network paths.
[Security and permissions](https://www.conductor.build/docs/reference/security-and-permissions).

Cloud workspaces start from prepared environment builds. The documented OS is
Amazon Linux 2023; new workspaces receive the active build while existing ones
keep their original environment. This is a useful model for avoiding repeated
dependency installation. These pages do not establish local macOS guest
provisioning. [Cloud Computer](https://www.conductor.build/docs/cloud/cloud-computer).

### Cursor

Managed cloud agents get an isolated VM with a desktop, browser control,
screenshots/videos and a remote takeover interface. These are capabilities of
the same development environment used to build and test the changes.
[Capabilities](https://cursor.com/docs/cloud-agent/capabilities).

Self-hosted workers make the controller/tool distinction explicit: Cursor runs
the agent loop remotely, while the worker executes file edits, terminal
commands and computer tools on the chosen machine.
[Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted),
[My Machines](https://cursor.com/docs/cloud-agent/self-hosted/my-machines).

On a macOS worker, computer use targets that user's signed-in GUI session and
requires Accessibility and Screen Recording grants. Linux uses X11; documented
desktop sharing is Linux-only. A Mac worker is therefore not automatically an
isolated macOS VM. To preserve the host desktop, the worker/helper must target
the guest's session. [Computer use and desktop sharing](https://cursor.com/docs/cloud-agent/self-hosted/computer-use).

### OpenHands

The SDK retains the Conversation interface while switching between a local
workspace, DockerWorkspace and a remote API workspace. A remote workspace
starts/connects to an agent server; that server executes the agent and exposes
commands, file transfer and streamed events. Prebuilt images reduce setup work.
This is a backend abstraction example, not proof of macOS guest support.
[Remote Agent Server](https://docs.openhands.dev/sdk/guides/agent-server/overview).

### OpenManus

Inspected FoundationAgents/OpenManus at
`3309bf4e416fb1c74b008f3e86494439a31bad53`, the repository's HEAD at research time.
Its ordinary Manus class installs PythonExecute and a file editor, and connects
Browser Use as a separate MCP service.
[Manus source](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/manus.py).

The default sandbox setting is false. The editor selects a local or sandbox
file operator, while PythonExecute uses a child of the current Python process
without routing through that sandbox setting. Enabling the editor sandbox
does not relocate every tool.
[Configuration](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/config.py),
[File editor](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/tool/str_replace_editor.py),
[Python execution](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/tool/python_execute.py).

SandboxManus is a separate path. It creates a Daytona sandbox and binds its
browser, file, shell and vision tools to the same sandbox object, with VNC and
web preview links. The controller calls those tools from outside that sandbox.
This supports coherent remote tool placement, but is not evidence of a local
Linux/macOS picker or seamless macOS provisioning.
[SandboxManus](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/sandbox_agent.py),
[Daytona creation](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/daytona/sandbox.py).

### OpenClaw

The gateway can remain on the host while shell and file tools execute in a
sandbox. The browser is an additional optional sandbox capability; explicit
outside-sandbox tools are a distinct policy choice.
[What gets sandboxed](https://docs.openclaw.ai/gateway/sandboxing/what-gets-sandboxed),
[Docker agent sandbox](https://docs.openclaw.ai/install/docker/sandbox-and-troubleshooting).

Its configuration separates when sandboxing applies, resource-sharing scope,
and runtime backend. Session changes are guarded against changing containment
under an active turn. This is useful precedent for durable per-conversation
binding, rather than a global OS switch that redirects every running agent.
[Modes, scope and backend](https://docs.openclaw.ai/gateway/sandboxing/modes-scope-and-backend).

### Cua: the closest backend reference

Cua documents using an existing harness to control sandbox commands, files,
screenshots and input without adopting a Cua agent loop.
[Use your own harness](https://cua.ai/docs/cua-sdk/guides/own-harness).

It also documents an MCP attachment for coding agents, guest Driver input and
an optional browser-based viewer. Its interfaces depend on the services
actually installed in the image; desktop availability is not implied by a
running sandbox. [Desktop and browser control](https://cua.ai/docs/cua-sdk/guides/desktop).

Runtime selection is based on image/OS capabilities: containers use Docker or
Podman, while macOS uses Lume on Apple silicon. It supports other runtime
families too; the user choosing an OS need not also choose every runtime detail.
[Runtime selection](https://cua.ai/docs/cua-sdk/guides/local-runtimes).

These are current public docs, not a compatibility claim for TerminalX's pinned
Cua 0.7.0/Lume 0.6.1 profile. No dependency change, spacesd adoption, license
decision or new API availability has been assumed from this research.

## Recommended TerminalX behavior

This is an engineering recommendation, not an accepted product decision.

1. Preserve an **attached computer** mode: the existing conversation and coding
   checkout stay where they are; its computer/browser tools target one chosen
   Linux or macOS guest. This extends the merged Linux feature without forcing
   a second provider login inside a guest just for desktop control.
2. Preserve **Run task in VM** as a distinct execution choice. For that task,
   shell, files, browser and desktop must refer to the selected guest. The
   parent conversation remains in TerminalX. This retains the original PRO-114
   contract instead of silently reducing it to remote clicks.
3. Both modes use the same Linux/macOS environment inventory and status model.
   Initially retain Docker/Podman for Linux and Lume for macOS. Runtime choice
   follows compatibility; it must never silently change the requested OS.
4. Bind a conversation/task to an exact environment identity and generation.
   An OS/viewer change cannot redirect an active workflow. Switching requires
   an explicit new binding, preserving the old task's history and lease.
5. Keep computer work in the background. The viewer observes execution and
   provides explicit takeover; opening or focusing it is not a prerequisite
   for ordinary screenshots, input, readback, save or close operations.
6. Optimize ready-environment reuse and prepared artifacts. Benchmark cold
   creation, warm start, reconnect and tool latency separately before claiming
   one runtime is fastest. No speed benchmark was run for this comparison.

The two execution modes must be labeled honestly: an attached VM desktop does
not isolate the coding agent's host shell. Conversely, selecting a full guest
task must not leave file edits or terminal commands silently on the host.

## Consequences for the current branch

The Linux code in `src-tauri/src/container_vm.rs` exposes computer MCP tools to
host agent launches. It does not create a guest coding worker. The macOS code
in `src-tauri/src/local_vm/` already implements guest workers, immutable task
bindings, receipts, workflow leases and retained results. The merge prevents
container tools from being appended to those bound guest workers.

Still needed: shared environment selection; per-conversation attached-computer
routing for macOS; Linux guest-task parity if offered; and safe switching and
reconnect behavior. A viewer-only selector does not fulfill these requirements.

Fresh secure macOS first-account provisioning and account-bound transport are
still unresolved in the pinned profile. Moving desktop control to an external
agent can avoid an unnecessary guest provider login for that mode, but cannot
solve guest OS account setup, permissions or transport identity by itself.
Existing runtime activation and real acceptance gates remain unchanged. The
background native input/readback/save/close proof at `128f5efc` remains passed.
