# Cloud session parity (#1289)

A cloud or machine session is the local session view with the cloud parts
added, not a reduced copy. There is one chat implementation: `SessionView`
and `TabView` over a `SessionBackend` (`src/lib/sessionBackend.ts`), local
(`localSessionBackend`) or remote (`cloudSessionBackend`, which machines use
too).

## Where a remote session opens

- A session row (`cloud:<org>:<workspace>:<session>`, `machine:<m>:<p>:<s>`)
  opens `CloudSessionHost` / `MachineSessionHost`, both the shared `SessionView`.
- A whole workspace or machine (`CloudWorkspaceMain`, `MachineMain`) shows its
  terminals, files, Git and ports. Its **Agent** tab lists the agent sessions
  (`CloudAgentSessions`) and opens each in the shared view; **+ Agent** starts
  one and opens it there. It has no chat of its own any more: the parallel
  `CloudAgentPane`, its status chips, steer, stop and outbox are gone.

## Options a remote session cannot take yet

Where a local session has an option a remote one cannot take, the control is
shown disabled with the reason (`SessionBackend.unavailable`,
`REMOTE_UNAVAILABLE`) rather than left out. A local backend has no
`unavailable`, so nothing changes there.

## Checklist

| Area | Local | Cloud and machine now | Remaining |
| --- | --- | --- | --- |
| Tab strip row | yes | cloud: **yes**, the runtime's agent tabs and shells, closed on the runtime; machine: its own strip (21.08) | — |
| Header: Run menu | yes | machine: its own (PRO-403); cloud: shown disabled with why | — |
| Header: branch and Git button | yes | machine: its own; cloud: **Git** opens the Changes panel (commit, push, PR) | — |
| Header: Share | yes | machine: none; cloud: **Share** opens the workspace's people | — |
| Header: account label | yes | machine: yes; cloud: none. A cloud agent signs in with the organization's login, and the sign-in notice says when it cannot | — |
| Split panes | yes | cloud: **yes**, laid out per viewer on this computer; machine: no (one pane and its terminal dock) | — |
| Lead chat, orchestration run, browser tabs | yes | no: they stay on this computer, and the "+" menu says so (see below) | — |
| Second opinion | yes | disabled with why | #1327 |
| Agent handoff (composer) | yes | no | #1327 |
| Retry in new chat | yes | disabled with why | #1327 |
| Reset, Fork | yes | disabled with why | #1326 |
| Checkpoints, first message | yes | no | #1326 |
| Send again / Retry | yes | **yes**: the message's text, through the mailbox; one with attachments is refused with why | — |
| "Send now" on a queued message | yes | no; the runtime holds follow-ups (outbox) | #1328 |
| Held follow-ups tray, hold/now preference | yes | no | #1328 |
| Attachments | any file | images with `composer/3`; machine files with `composer/4` | #1329 |
| PR and dropped-file mentions | yes | off | #1329 |
| Terminal view toggle | always | with `agent-pty/1` and a terminal-first agent; otherwise the reason (`TERMINAL_VIEW_*`) | runtime update |
| Interrupt | yes | with `session/3` while connected; otherwise Stop is the hard stop | runtime update |

## Tabs and panes of a cloud session (#1325)

A cloud workspace session draws the same strip and panes as a local one
(`WorkspaceTabStrip`, `WorkspacePanes`) from a remote row
(`useRemoteTabRow` in `src/lib/remoteTabRow.ts`, over `remoteRow` in
`src/lib/sessionTabs.ts`):

- **Tabs** are the runtime's: the session's agent tabs and the shells it
  opened for the session. An agent tab's own terminal is its terminal view,
  and a machine's script runs are its dock's, so neither is a tab.
- **Showing** a tab selects it in the session, as the sidebar does; the
  runtime's active tab still decides only what the view opens on.
- **Closing** a tab closes it on the runtime, for everyone in the workspace
  (`CloudSessionModel.closeTab`: `session.close` with `remove`, or the
  shell's `pty.kill`). It is a manager's: a driver or a viewer has no close
  (`closeBlockedReason`), as the runtime would refuse them.
- **Layout** (order, pins, the split into two panes and its ratio) is the
  viewer's own, kept on this computer under `remote:<session key>` with the
  other tab layouts. Nothing of it is sent to the runtime, so two people in
  one workspace each keep their own arrangement.
  A tab closed elsewhere (by someone else, or ended by the runtime) leaves it
  once the runtime has listed the session's agent tabs and shells since
  connecting (`tabsListed`); deleting the session drops its layout.
- A tab's menu holds only what applies to a runtime tab: pin, the other pane,
  terminal view (where the runtime serves it), move, close.

**Decision: browser tabs and orchestration runs stay on this computer.**
Both act on the computer a person sits at: a browser page is this
computer's webview, and a run needs the project's checkout here to start
workers (`orchestrateOffered` already refuses a cloud place). A runtime
answers `browser.*` with `unsupported` (as for machines, MACHINES.md
decision 7). A cloud session therefore leads no run and holds no browser
tab; its "+" menu says so (`REMOTE_LOCAL_ONLY`), and a workspace's port
opens in this computer's browser from Ports and previews.

The cloud-only parts stay additions to the same layout: the location chip with
the workspace's lifecycle actions, ports, presence and access chips.
