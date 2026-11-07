# Data privacy mode

Settings → General → **Data privacy mode** turns off cloud workspaces,
organisations, remote control (including existing LAN and relay connections),
pairing, MCP servers supplied by organisation config, and external logging.
The affected surfaces say **Turned off by data privacy mode**. Local agent
sessions keep running and agents retain their own network access.

The account session, paired-device credentials, cloud catalog and personal
organisation display preferences stay saved. Turning the mode off resumes
account refresh, catalog polling and relay recovery without a new sign-in.
Already running cloud workspaces are not stopped by disconnecting this Mac.

The owner-only `data-privacy.json` file under `TERMINALX_HOME` stores the personal
choice. A missing file defaults to off; an unreadable or malformed existing file
fails closed. The desktop loads the policy before creating service clients. Each
window loads it before rendering and the local background runtime watches the
same policy. A setting change also asks the attached owner to reload it and
waits for its acknowledgement. An older or unavailable owner produces a synchronization error alongside the
actual applied Mac policy. The switch shows that applied value; an IPC failure
makes it unavailable, rather than claiming that protection is enabled. Profile changes are checked every second; windows refresh their
display every two seconds and on focus.

## Enforce it with macOS device management

Set the Boolean **`DataPrivacyMode`** to **`true`** in the managed preferences
domain **`com.terminalx.next`**. Both release and development builds, including
the local background runtime, read this domain. See the installable example
[data-privacy.mobileconfig](data-privacy.mobileconfig); deploy it through the
organisation's MDM configuration-profile mechanism.

The app checks `CFPreferencesAppValueIsForced` as well as
`CFPreferencesCopyAppValue`, following Apple's
[managed preference guidance](https://developer.apple.com/documentation/corefoundation/cfpreferencesappvalueisforced(_:_:)).
A forced true value locks the switch on and shows **Managed by your organisation**.
A forced value of the wrong type also fails closed. An ordinary `defaults write`
is not a managed policy and does not lock the switch. A false profile value never
overrides a person's own opt-in. Removing the profile restores the personal choice.

## Enforcement and verification

Every native TerminalX HTTP client (account refresh, organisations, catalog,
work claims, mailbox/checkpoints and relay director included) uses the policy's
HTTP middleware. The change waits for admitted HTTP requests to finish before
reporting completion; subsequent attempts are refused before DNS or connection.
Service credentials are not cleared by that refusal.

Relay and LAN streams enforce the policy below TLS and WebSocket framing,
including handshake, automatic pong and close writes. Enabling invalidates all
existing stream generations and wakes idle readers. Old streams stay invalid
after disabling; normal recovery creates new ones. Pairing/share entry points,
mobile grants and guest requests also check the policy. Remote writes hold a
lease through delivery, including PTY paste/draw waits and partial native Codex
frames; activation drains these leases before acknowledging. Old grants and
queued prompts and control commands stay invalid after a toggle. Phone controls
retain privacy authority through mutations; queued slash commands, native Codex
frames, HTTP actions and deferred restarts revalidate it at their final writer. Reconnecting obtains new grants. Organisation launch
config is not injected into new agent processes while enabled.

Frontend gates stop catalog polling and queued cloud/remote actions. Webview
external images and update checks are suppressed too. The app's existing
diagnostic logs stay local; no external logging sink is enabled by this mode.

App-owned GitHub subprocesses (PRs, issue reads/writes, repository listing and
SSH/gh identity probes) share admission and cancellation. They are refused while
enabled and terminated, reaped and drained before activation is acknowledged,
including when a process stops reading a request body. Authority is captured
before blocking dispatch and retained across pages and fallbacks; an off/on cycle
cannot revive queued work. Overview and disposition reads keep one request ticket,
and serving-runtime GitHub RPCs capture it before the relay async queue, retain it
through the blocking queue, repository fan-out and reconciliation, and drain
app-owned network processes before acknowledging that runtime’s policy. Local Git
metadata and checkout issue templates remain
available. Identity headers refresh when privacy is disabled, without signing in
again. Agent-owned subprocesses retain their network access.

App-owned Git transfers also share this boundary: branch refresh, worktree-base
refresh, project cloning, desktop/workspace pull and push, and pipeline transfer
and reconciliation. Authority is captured before blocking queues and forwarded
to the runtime with its owner-issued generation. Branch polling pauses while
privacy is enabled. Cached branch facts remain available; worktree creation can
use cached refs and records an unfetched warning. Clone progress, deadlines and
explicit cancellation remain active.

Explicit transfers use a private stdio SSH adapter before any app/runtime
services start. Each invocation reads the current repository's SSH configuration,
including recursive submodules, and retains the original environment and command
config precedence. OpenSSH runs without a control socket, preventing shared
master reuse or persistence. Other transport variants keep their argument grammar;
capability probes share the original transfer's process group and admission.
The app never terminates someone else's SSH master. Local Git inspection still
disables lazy object fetching, and agent executables are not intercepted.
Update checks and downloads use native admission too: an already admitted
transfer drains, with a 60-second limit, before privacy activation is acknowledged.
Its result is then discarded. Cached updates and deferred install choices are
withdrawn across activation/restoration; a fresh check is required after restoring
access. The short-lived GitHub broker helper loads the same policy before access.

`data_privacy::tests` includes real loopback HTTP and WebSocket network tests
(zero connections while on, idle-stream invalidation, retained bearer credentials
after off), native macOS preference reads in an isolated test domain and forced
policy resolution. Vitest covers the locked switch, empty states, command gate,
catalog boot/poll/restore and network-image suppression.
