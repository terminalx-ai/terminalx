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
| Tab strip row | yes | hidden | #1325 |
| Header: Run menu | yes | machine: its own (PRO-403); cloud: shown disabled with why | — |
| Header: branch and Git button | yes | machine: its own; cloud: **Git** opens the Changes panel (commit, push, PR) | — |
| Header: Share | yes | machine: none; cloud: **Share** opens the workspace's people | — |
| Header: account label | yes | machine: yes; cloud: none. A cloud agent signs in with the organization's login, and the sign-in notice says when it cannot | — |
| Lead chat, orchestration run, panes, browser tabs | yes | no | #1325 |
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

The cloud-only parts stay additions to the same layout: the location chip with
the workspace's lifecycle actions, ports, presence and access chips.
