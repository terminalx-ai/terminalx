# Codex Chat to Terminal transition (#816)

The original 0.2.24 user report did not identify the error or establish a
shared cause with #815. The regression fixtures reproduce two concrete
failures in the local view-switch path: a native handoff refusal becomes
an agent recovery banner, and a failed CLI start still opens Terminal.
These are source-derived reproductions, not a recording of the user's session.

Native Codex now answers `false` when a live turn still owns its connection.
The desktop stays in Chat, shows a pending transition, and asks again every
500 ms until the turn finishes or the reader interrupts it. Stay in chat
cancels this request. The view switch does not interrupt, replay a prompt,
or start a second turn. Existing PTY sessions keep the same process and pane.

The turn decision is made under admission **before** installing the stop
fence. Previously the fence was installed before rejecting a busy handoff,
so a protocol write racing that check could be rejected as a stopped tab.
The regression checks that no fence is present at this decision; the RPC
fixture also proves that startup and interrupt frames still reach Codex
while handoff requests are pending. The idle handoff retains the existing
confirmed-exit requirement before changing the persisted transport.

A failed switch keeps Chat usable and explains the view-specific condition.
It does not synthesize a turn failure or change the tab's agent status.
Startup failure is returned to the view switch instead of being swallowed.
A successful retry clears the view refusal; native owner cleanup clears
its prior recovery state through the existing status path.

## Diagnostics

`terminal_view_transition` version 1 records share the tab's existing private
`*.diagnostics.jsonl` sink. That sink rotates at 1 MiB, retaining one previous
file. Reports contain UUID transition/event identifiers, ordered stage
numbers, UTC time, monotonic elapsed time, build, source event sequence,
transport/engine, tab state, turn-open/process/stop state, pending-decision
count, and fixed error categories. Local window stages distinguish request,
waiting, startup, attachment, opened, cancelled and failed. Native runtime
stages distinguish waiting, owner cleanup and transport change. A shared
transition UUID correlates window calls and repeated local/cloud handoff
requests. Runtime stages describe ownership, not actual terminal visibility.
No diagnostic claims a user click or impression from a background mount.

The request schema rejects unknown fields, non-UUID identifiers, and arbitrary
error categories. Prompts, tool output, commands, raw errors and paths are
excluded. Writes are best effort and never determine a transition's result.
This supplies the view-transition evidence for #815; it does not implement
that issue's broader recovery-visibility analytics or infer its root cause.

## Regression seams

- `src/lib/followTerminal.test.ts`: startup failure/retry, pending handoff,
  rapid requests, cancellation, stale replies after removal, and safe reports.
- `src/components/session/SessionView.terminalView.test.tsx`: local/native
  refusal presentation, existing idle/busy PTY switches, pending native UI,
  cancellation, retained conversation and follow-up send.
- `session::codex_stdio::tests::owned_stdio_lifecycle_is_process_bounded`:
  idle/active handoff, fence ordering, failed cleanup, confirmed owner exit,
  thread identity, repeated handoffs, recovery clearing and diagnostic content.
- `remote::server::tests::a_driver_who_may_start_its_terminal_moves_native_codex_there`:
  permission gates, active startup, interrupt, same-thread terminal resume,
  one terminal owner and no prompt replay.
- `session::view_transition::tests` and `recovery::tests`: report allowlist,
  bounded log rotation, and failed diagnostic writes.

The process fixtures use stand-in CLIs. They verify ownership and protocol
ordering, not compatibility with a live provider or a visual native app run.
