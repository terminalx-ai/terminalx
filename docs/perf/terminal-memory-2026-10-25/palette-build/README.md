# Matched palette builds, no measurement

Actual phase: 2026-10-24 20:31:23.679–20:41:36.342 UTC, 612.665 seconds;
original hard expiry 21:01:23.679. Both owner handoffs arrived before start.
Both sequential debug bundle builds exited 0 with jobs2 and CARGO_INCREMENTAL=0.
No GUI, guest access or memory measurement occurred. The build hold was released
to #467/#627 immediately after completion and final verification.

Parent e3f898e8673bf158689cfd8a09c917ca3bd1c434:
`/tmp/tx232-palette-build-20261025/parent/app.zip`
SHA256 `b94bed49202864033a76dfae47e70222ef87508fa89aabeb64c1b3549e4e6ed2`.
Executable SHA256 `cf6eb2698ec2e2aeaa7fab9160f38f8a9dbb9e16b39a1fd26db61179ef014d67`.

Candidate c378ada9dd75cd28f5e28cdf2ebed9374e16cd3f:
`/tmp/tx232-palette-build-20261025/candidate/app.zip`
SHA256 `11d4e5dbc94888bba25c041a6aa7f29544b89fff431e111a372a2a5632663024`.
Executable SHA256 `64f306b013d14b664e69e5db6df465e38168c9cb2a080599f0a093cadf492050`.

Both are arm64, SDK26.5, minimum macOS12.0; ad-hoc development signatures,
NOT distribution/notarization. Deep/strict verification passed for both private
copies. Their private bundle identifier is com.terminalx.next.dev.perf232.palette,
URL schemes removed; neither app was launched. Toolchain/config hashes and
per-arm timings are in the adjacent records. Source export comparison verified
all 1,576 parent /1,580 candidate tracked regular files unchanged after building;
all 10 regular files in each app bundle rehashed successfully. Full frontend
asset/source attestations and platform details remain in the raw artifact directory.

The original >=20 GiB gate passed after removing ONLY this worktree's reproducible
`src-tauri/target/debug/incremental` cache. lsof found no open users and no compiler
was running. The pre-existing bundle was copied before building; cleanup deleted no binaries,
bundles, sources, logs or evidence outside that authorized cache. Normal builds
updated the shared target outputs, and each completed bundle was copied before
the next build. Free bytes
at completion: 20,021,706,752 (~18.65 GiB). The runner stopped new work below 5.5 GiB
or at the original deadline; neither condition occurred.

Initial parent packaging failed before native compilation: exported root
node_modules alone did not resolve mobile's marked dependency. No source/package
change: read-only links to the existing matching workspace node_modules were added.
The failure/log remain preserved. A resume preflight also exited before work when
it mistakenly reapplied the initial 20 GiB gate after packaging had already consumed
space; the runner was corrected to verify the recorded initial gate and enforce
the authorized ongoing disk floor. Neither restart reset the 30-minute deadline.
A private Swift forwarding script appended --jobs 2 to helper builds because the
repository helper script invokes swift without a job limit; exported tracked source
and Tauri config were unchanged. Helpers were built/signed, never launched.

Final process audit found no Cargo/rustc/ditto and the runner returned exit0;
no queued follow-up. Exact files/hashes are in artifact-manifest.json. These are
successful builds, not memory results. The +68.46% failed production control and
physical failure remain unchanged. One future parent/candidate pair will provide
scoped observations, not a causal estimate of a small effect. Guest assignment
and the separate 15-minute quiet reservation are still required before execution.
