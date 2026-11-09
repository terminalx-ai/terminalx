# Native Codex runtime handover (#818)

The process fixture reproduces the reported idle/transition discrepancy: start
a native Codex connection, finish a turn, stop it, observe `Idle`, then call the
real session handover collector. Before the fix it fails with
`The agent in stdio-owner/tab is starting or stopping`.

Native compaction bindings deliberately survive process exit so buffered reader
observations remain admissible. The final reader-drain callback dropped the
tab's token without removing its binding from compaction admission. Consequently
`compaction.is_idle()` stayed false after a successful Stop, and the handover
collector rejected the tab indefinitely. This is a controlled source-derived
reproduction consistent with the November 7 logs; those logs alone do not prove
the internal state of the original runtime or the release that introduced it.

The drain callback now retires bindings belonging to its exact launch and child
epoch. A later launch's bindings and any failed-publication latch remain intact.
The process and reader exit checks still govern Stop; visible idle status is
never used as evidence that a process has exited. Compaction blockers now name
compaction state rather than claiming that the agent is starting or stopping.
Native descendants still running after their leader exits remain on the list
requiring stop approval; reader drain does not make their process group
transferable.

## Already-running older runtimes

A new app cannot patch the memory of a 0.2.24 runtime. Repeated `handover_busy`
responses must therefore have a bounded recovery path in the desktop too.
The desktop retries on its five-second check interval, then pauses after six
busy refusals and displays the runtime's blocker. Try again still attempts a
handover with only the listed agents approved to stop. The message also points
to **Stop all and quit**, then reopening TerminalX, if the old runtime remains
stuck. That explicit action stops agents and terminal commands; it is never
performed automatically or inferred from consent to stop only native agents.

## Automated validation

- `session::codex_stdio::tests::owned_stdio_lifecycle_is_process_bounded` includes
  `handover-stop` and `handover-exit`: explicit Stop and spontaneous exit,
  repeated handover collection, stale-token rejection, and an old drain callback
  after a replacement connection has bound. `handover-descendant` retains the
  stop-approval requirement after the native leader and its readers exit.
- `local_runtime::replace::tests` covers throttled and bounded busy retries,
  reconnecting to the same blocked runtime, explicit retry, and stop scope.
- `cargo test --manifest-path src-tauri/serve/Cargo.toml --test local_handover`
  executes a real runtime handover after first refusing an unapproved native
  connection. Only its approved process stops; an ordinary PTY agent keeps its
  PID, answers another turn, and survives a second handover. Connected runtime
  and CLI-reported versions equal the installed target build. Existing tests
  also cover live turns, pending permission cards, queued input, and PTY output.

For the narrow process reproduction:

```sh
TERMINALX_TEST_STDIO_OWNER_CASE=handover-stop cargo test \
  --manifest-path src-tauri/Cargo.toml --no-default-features --lib \
  session::codex_stdio::tests::child_fixture -- --exact --nocapture
```

## Packaged update acceptance

These fixtures use stand-in CLIs and an installed copy of the test runtime.
They do not claim a signed desktop 0.2.24-to-target update or live provider
compatibility. In an isolated home, install the release candidate, retain a
normal PTY session and native Codex tabs, and accept only the offered native
stops. Verify the bundle version, `status.appVersion`, and
`status.localRuntime.version` all equal the target; the runtime epoch changes
on handover, the PTY PID remains unchanged, and its next turn completes once.
For an already-stuck old runtime, verify bounded retries and the recovery
message before explicitly choosing the broader stop-all recovery. Preserve
that distinction in release evidence; do not force an update of a working
developer runtime to collect it.
