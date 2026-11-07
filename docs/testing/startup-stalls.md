# Local child startup incidents (#813)

The local runtime owns the monitor, so it continues when a window closes.
Settings → General → Local startup diagnostics opens the incident, thresholds,
health probe and export preview. A host incident also appears as one notice in
the workbench and as `startupIncident` in `terminalx status --json`. Its ID is
the correlation key for reports. This is separate from cloud diagnostics.

## What counts as evidence

PTY launches record spawning, a returned PID, startup progress and final exit.
Output or a grown application image disproves a pre-main startup suspicion;
silence after that never fails a compile. Known permission cards are a distinct
phase and remain human-only. A system prompt that TerminalX cannot see must be
checked by the person; a suspected stall does not authorize answering it.

On macOS the monitor reads only owned process trees through libproc. A
single-threaded process with nonzero resident memory at most 128 KiB, unchanged
CPU time and unchanged memory across the configured interval is supporting
evidence for a suspected startup stall. A larger image or CPU/memory progress
disproves or defers that suspicion. Descendants are identified by PID **and
birth time**, with parentage rechecked after enumeration. Command lines are
never requested. A vanished/unreadable descendant has an unknown final result,
not exit zero. Enumeration is bounded to 2,048 processes and 256 children per
parent per pass; it is not an exhaustive host-wide process scanner.

This heuristic is intentionally specific to the observed small-image failure.
It is not proof of a dyld, security, or resource-pressure cause, and it does not
diagnose every possible launch hang. It cannot observe a process outside the
runtime's owned trees. Remote VM capture/network failures are separate evidence.

Default thresholds are 120 seconds without startup progress, then escalation
300 seconds after incident detection. Both can be set to 15–3,600 seconds.
The monitor ticks every five seconds. Matching suspicions join one unresolved
host incident. Detection and escalation times persist in owner-private
`$TERMINALX_HOME/startup/incidents.json`; neither PR changes nor a recorder
finishing is required for escalation. Pipeline polling visits affected author
work even before a PR exists and deduplicates the reason it presents.

New local validation is held while the host incident is unresolved; unrelated
working sessions continue. Pipelines held indirectly are recorded as blocked
dependencies of the same incident. The monitor sends no prompts, starts no
reviewers, and performs no process killing, reboot, security-policy change or
gate bypass.

## Durable results and recovery

Run one health probe from the incident. A detached recorder runs the fixed
basic-shell probe (`/bin/sh -c 'exec /usr/bin/true'`) and the native TerminalX
`--startup-probe` entry point. The latter runs before configuration, logging,
hooks or application startup and writes a fixed readiness marker.

The observation period is 15 seconds. A timeout leaves the same recorder
pending; reopening the window or restarting the app cannot launch a duplicate.
The recorder keeps at most 8 KiB per output stream while draining the rest, and
writes the shell result before starting the native step. The eventual exit
codes, signals, truncation flags and output are kept in an owner-private UUID
directory. Late success, nonzero application exit and an unresolved recorder
are distinct. A process not known to have exited is never called successful.
If the recorder itself never starts or loses its result, the incident stays
unresolved and needs a person; automatic retries cannot prove the old one gone.

Configured local validation also uses a detached recorder with bounded output.
It records the leader's exit before waiting for output EOF, so an inherited pipe
cannot erase the exact status. The coordinator's 30-minute observation limit
does not kill validation. A host blocker releases the observer sooner. Checkout
ownership remains held while that recorder is pending. Once it finishes, the
checkout hold can clear, but its late result never certifies a potentially
changed commit: retry the configured check on the final head.

Recovery requires both probe steps to succeed, the native readiness marker,
and no still-observed stalled launch or pending human prompt. The probe result
must be newer than the last affected progress. An interrupted/unobserved launch
still has an unknown exit, even when fresh launch health permits a retry.
Review, security, local checks and CI keep their existing gates. The monitor
does not change a prior failed check into a pass.

Preserve work and quiesce jobs before considering a coordinated restart.
Restart is a recovery experiment, not an established fix. Preserve PRO-166's
clean local merge `c2940ea4`; do not reset or replace it to obtain a checkmark.

## Reporting and optional investigation

Preview the redacted report, agree to save those exact bytes, then choose a
**new local JSON file**. The backend consumes a short-lived preview identifier;
it does not regenerate a different report during save and will not overwrite
an existing file or follow a symlink. Nothing is uploaded. The report button
opens public issue #813 without transmitting the report; attach or send only
what you have reviewed and agreed to share.

The export allowlist is: app/macOS version and build, architecture, UTC time,
thresholds, incident ID, counts, command category, evidence enum, launch phase,
last progress, exact exit codes/signals and the fixed native readiness marker.
It omits pane/session IDs, PIDs, identifying paths/accounts, command text,
environment values, tokens, credentials, source, prompts/transcripts, shell
history, arbitrary stdout/stderr and unrelated commands. Unknown or malformed
incident IDs are redacted, not copied as strings. The raw owner-private recorder
files are **not** the export and can contain sensitive validation output.

Include these details in the report:

- Incident ID; app and macOS version/build; architecture; timestamp/timezone.
- Reproduction steps, command category (native/script/build/test/agent), elapsed
  time and last meaningful progress, affected-session and dependency counts.
- Basic-shell result, visible permission/system prompts, and recovery outcome.

Optional evidence should be narrow and locally reviewed first:

- Take a one-second `sample` of a **currently owned** child PID named by the
  incident; verify ownership again before sampling. Do not sample unrelated
  applications. `_dyld_start` alone is not a cause.
- Collect only the incident's short time window from launch/security logs,
  scoped to the owned PID and relevant launch service (for example amfid or
  syspolicyd). Avoid a broad system log archive. Review paths, account names and
  messages; these logs are not included automatically in the safe export.
- Compare the same command app-launched versus direct shell, native versus
  script, and before versus after an explicitly coordinated recovery. Keep
  each observation timeout distinct from the recorder's eventual exit.
- Record a resource snapshot separately; one CPU/memory/disk snapshot does not
  establish sustained saturation.

Use an agreed private channel for sensitive samples/logs, never public raw
attachments. No permission or security prompt may be automatically answered.

## Checks

Rust tests cover simulated never-ready children, multi-session deduplication,
bounded escalation across a serialized restart, quiet healthy compiles,
permissions, PID generations, late exit 23 with both streams, bounded draining,
pending probe deduplication, late health results and export secret exclusion.
Pipeline tests exercise blockers with unchanged author metadata and no PR,
and successful CI that must not admit a host-blocked local check. UI tests
exercise preview, consent, canceled destinations and a pending probe.

Production-binary subprocess tests also exercise both health-probe steps,
private durable result files, a leader's exact exit while a grandchild holds
its output pipe, bounded real stdout/stderr, and signal termination. A macOS
kernel census regression verifies that a recorded owner includes its actual
child, rather than only testing synthetic observations.

Run the four checks in `CONTRIBUTING.md` before review/merge. A launcher, build
script or test process that has not reached test code is **not a passing test**.
Do not run duplicate heavy checks into an unresolved host incident.
