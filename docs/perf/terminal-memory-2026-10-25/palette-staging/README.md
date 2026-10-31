# Paired guest staging — not measured

The conditional pair was NOT started. Both builds had completed and both owners
handed off, but repeated host quiet audits at20:55–20:56 UTC showed sustained
unrelated activity: dasd PID390 at91.3/94.0% CPU and the other guest's Virtualization
PID10103 at32.4/33.5%. Host idle was73.18/74.31%; no Cargo/rustc job remained.
These observations did not establish the required quiet host. No system service,
other guest or non-owned process was changed. The pending hold and assigned guest
were released to coordinator/#467/#627 at20:56:58 UTC, before latest start21:05.
This is an explicit **not-measured** outcome, not an incomplete workload relabelled
as passing, and not a claim that such background load necessarily causes failure.

Assigned guest was local:terminalx-cua-macos, macOS26.5.2 build25F84, arm64,
4 vCPU /8 GiB. It was idle (~98% CPU idle in the sampled interval) and has different
resources from the earlier failing guest. Both new roots were verified absent
before creation, then staged:

- /tmp/tx232-palette-parent
- /tmp/tx232-palette-candidate

Both app archives, all20 bundle regular files, signatures, and the common driver,
workload and fake-agent hashes verified in the guest. No app was launched. No
benchmark or provider process was started, so there was no owned runtime cleanup.
No guest action followed the release. All prior workers' files/processes were
preserved; guest inventory was read-only except the two new disposable roots.
Node24.21.0 is at /usr/local/bin/node; fixture Python is /usr/bin/python3.

The staged outer lifecycle runner has a one-run sentinel, verified executable/PID
identity, bounded startup/readiness and driver lifetime, and exact-identity cleanup.
It is source preparation only and has NOT been runtime-validated. Its foreground
`open -n` launch intentionally omits `-g` from the earlier draft to keep the newly
owned benchmark window foreground without separate focus automation. No renderer
or product settings change. Actual guest invocation still requires a new allocation
and quiet window; do not interpret staged files as authorization to run.

Local offline summarizer reproduced the historical +68.4607671% failed result and
rejected incomplete, missing-agent-step and diagnostic-labelled controls. No native
count-only diagnostic or memory run occurred. Source runtime remains c378ada9;
production failures and unchanged <=10% endpoint requirement remain intact.

Raw preparation, guides, audits and scripts: /tmp/tx232-palette-run-20261025.
The adjacent manifest pins relevant evidence. Reuse the verified bundles and
staging in a future reservation after rechecking root integrity, no prior launch,
process identity and quiet; no build or repeated allocation diagnostic is needed.
