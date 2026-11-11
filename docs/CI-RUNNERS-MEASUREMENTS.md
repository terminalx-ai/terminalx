# PRO-267 measurements

## Status on 2026-11-11

The branch now integrates main `7284dbcba023` and its three-job split from
[#882](https://github.com/terminalx-ai/terminalx/pull/882), merged at
02:29:20 UTC on November 11. It preserves required names `check`, `frontend`
and `webkit-layout`, moves the full portable Rust suite to Linux, and reserves
private-runner selection for protected-main events only. No Hetzner deployment,
activation or measured PR speedup is claimed.

| Phase | Successful first-attempt PR runs | Whole-run median | Whole-run p90 | Status |
| --- | ---: | ---: | ---: | --- |
| Historical unsplit baseline, November 6 | 10 | 59.0 min | 74.1 min | Frozen historical sample, not today's three-job baseline |
| Main's #882 three-job layout, November 11 | 6 | 52.2 min | 62.3 min | **Incomplete: 6/10**; descriptive only |
| PRO-267 Linux Rust split | 0 | — | — | **Incomplete: 0/10** at preparation; collect after publication |
| Hetzner main/nightly pilot | 0 main runs | — | — | Owner prerequisites and activation pending; cannot represent PR acceleration |

The issue's 26-run mixed-event baseline (63-minute median, 76 p90) is a different
cohort. Do not mix it with these samples or compare heterogeneous cohorts as a
measured speedup. The November 11 sample contains successful first-attempt PR
runs started after #882 merged, with all three job names and no `linux-rust` job.
The raw sanitized observations are in
[`baseline-three-jobs.json`](../infra/ci-runners/baseline-three-jobs.json).
The workflow blob on each included PR head matches main exactly: `28f0ae3e08612918769f48b0f92082391f14e47e`.
Run `42950103996` was excluded after checking its different workflow revision,
even though its job names matched. A later completed run (`42994223501`)
matched the workflow and was added in the final refresh. The ten-run acceptance
criteria remain open.

## Current main's three-job sample (incomplete)

Main three-job layout before PRO-267 (incomplete sample): 6 successful first attempts; durations in minutes.

| Job | Runs | Median | p90 (nearest rank) |
| --- | ---: | ---: | ---: |
| Whole run | 6 | 52.2 | 62.3 |
| check | 6 | 43.3 | 58.5 |
| desktop-platforms (instabox-medium) | 6 | 9.9 | 12.2 |
| frontend | 6 | 4.1 | 6.0 |
| headless-serve | 6 | 5.2 | 6.1 |
| legacy-runtime-probe (instabox-medium) | 6 | 0.1 | 0.2 |
| legacy-runtime-probe (macos-latest) | 6 | 0.2 | 0.2 |
| webkit-layout | 6 | 19.5 | 24.0 |

Samples:
- [42994223501](https://github.com/terminalx-ai/terminalx/actions/runs/42994223501) · 2026-11-11T09:19:35Z · `71aa466de0c9`
- [42976833560](https://github.com/terminalx-ai/terminalx/actions/runs/42976833560) · 2026-11-11T07:04:28Z · `cdcd82088080`
- [42974110579](https://github.com/terminalx-ai/terminalx/actions/runs/42974110579) · 2026-11-11T06:40:44Z · `bf27a131d9d4`
- [42949051452](https://github.com/terminalx-ai/terminalx/actions/runs/42949051452) · 2026-11-11T02:53:25Z · `1260ee3e4ca5`
- [42947045989](https://github.com/terminalx-ai/terminalx/actions/runs/42947045989) · 2026-11-11T02:35:20Z · `014d477cd82e`
- [42946576296](https://github.com/terminalx-ai/terminalx/actions/runs/42946576296) · 2026-11-11T02:31:17Z · `22ea1940251f`

## Method and collection after publication

Whole-run duration is `run_started_at` to the last successful job's
`completed_at`, including runner queue time. Job duration is `started_at` to
`completed_at`, including setup and cache post-steps. p90 uses nearest rank
(`ceil(0.9 * n)`). For six observations p90 is the maximum, which is another
reason not to treat this small sample as stable. Failed, cancelled and rerun
attempts are excluded; partial reruns are not independent observations.
Skipped optional steps are not treated as zero-duration successful suites.

The read-only collector uses `gh api` locally, never in CI. Stored observations
contain only public run IDs/URLs, commit hashes, timestamps and durations; no
runner identities, addresses or credentials. Reproduce the historical baseline:

```sh
python3 infra/ci-runners/timings.py --label 'Historical unsplit PR baseline' \
  --input infra/ci-runners/baseline.json
```

Choose a non-overlapping creation-time window in GitHub's `START..END` syntax
for each phase, then collect:

```sh
python3 infra/ci-runners/timings.py --label 'PRO-267: GitHub-hosted PR split' \
  --created "$CI_SAMPLE_WINDOW" --count 10 --output /tmp/ci-step1.json
```

The collector rejects fewer than ten runs rather than claiming a comparison.
Inspect each selected run's workflow/jobs: a date window alone can include PRs
still using the previous layout. Keep only runs with this split. This PR changes
native Rust/workflow files and therefore selects the full macOS suite; it cannot
stand in for the faster ordinary-PR cohort. Record whether the macOS test step
ran within `macos-native`, and compare ordinary and Apple-selected PRs separately.

After owner activation, collect **main pushes separately**, using `--event push`.
Compare main before/after on the same job mix, cache state and CPU architecture.
Record cache hit/miss, server CPU type and queue effects. Post the public run
links and per-job median/p90 in the PR and PRO-267. Local test durations are
correctness evidence, not CI measurements. Neither a projection nor ten reruns
of this one PR establishes the intended ten-run comparison.

## Validation after merging current main (2026-11-11)

- Passed: desktop/mobile TypeScript; all 5,392 Vitest tests in 456 files;
  frontend build. No frontend code changed after these checks.
- Passed: macOS helper build, all 123 Swift tests and all 18 icon tests.
- Passed on both macOS and Linux: `cargo clippy --locked --all-targets -- -D
  warnings`, including the final loader and timestamp-fixture changes.
- Passed in TerminalX Local VM (Debian 12, ARM64): full default-feature
  `cargo test --locked`, with **3,371 unit tests and 14 integration tests**;
  zero failures and the same 17 pre-existing ignored tests. No test filter or
  feature reduction. The VM had ripgrep and zsh installed, two Cargo build
  jobs, two Rust test threads and two Tokio worker threads. Unit tests took
  237.44 seconds; this is not a CI performance observation.
- Passed on macOS: the merged baseline's full Rust suite, with **3,426 unit
  tests and 14 integration tests**, the same 24 existing ignored tests, and
  one Rust test thread. After the Linux-discovered fixes, all 16 approval-wrapper
  tests, the session-grant directory regression and the cache-rewrite fixture
  passed again on macOS. The updated full macOS suite is also selected for this
  PR in CI; a second complete local macOS run is not claimed.
- Passed: actionlint 1.7.12 and **23** CI policy/selector/measurement tests.
  Negative fixtures reject unguarded custom runners, mutable actions, token
  escalation, workflow-wide secret expressions, privileged triggers, cross-scope
  cache fallbacks, missing aggregate dependencies and missing security tools.
  The aggregate accepts success and rejects failure, cancellation and skips.
- Passed: diff whitespace checks and an added-line scan for credential/key/IP
  patterns. Baseline JSON contains only public run metadata and durations.

The first merged Linux run found four security-test failures: setting an empty
loader-tracing flag returned success before executing either the command or its
directory guard. The fix unsets it before launching an executable and fails
closed if it is readonly. Mac testing also caught zsh's different `command`
builtin lookup; the regression now exercises sh, bash and zsh directly. CI
requires both ripgrep and zsh so existing executable security fixtures cannot
skip because of a missing tool.

A later Linux run exposed an intermittent same-size cache rewrite whose mtime
had not changed. A temporary deterministic same-timestamp reproduction failed
with 34 instead of 68 tokens before the fixture fix, then passed afterwards.
The fixture now explicitly advances mtime; production caching and all cost,
rewrite-retention and deletion assertions remain unchanged. No new Rust ignore,
macOS-only test gate, relaxed assertion or extended deadline was introduced.
The final Linux run includes all these corrections; the changed Rust source
hashes were checked against the worktree. Temporary diagnostic instrumentation
and the transfer server were removed/stopped after validation.

These checks establish local correctness, including a real Linux pass. Hosted
AMD64 CI and independent review remain publication gates; no local timing is
substituted for the incomplete ten-run comparisons or live Hetzner acceptance.

## Observed baseline

Before split: PR baseline: 10 successful first attempts; durations in minutes.

| Job | Runs | Median | p90 (nearest rank) |
| --- | ---: | ---: | ---: |
| Whole run | 10 | 59.0 | 74.1 |
| check | 10 | 58.9 | 63.5 |
| desktop-platforms (ubuntu-latest) | 10 | 7.4 | 9.0 |
| headless-serve | 10 | 3.1 | 3.4 |
| legacy-runtime-probe (macos-latest) | 10 | 0.2 | 0.2 |
| legacy-runtime-probe (ubuntu-latest) | 10 | 0.1 | 0.1 |

Samples:
- [42187021437](https://github.com/terminalx-ai/terminalx/actions/runs/42187021437) · 2026-11-06T08:20:55Z · `1cee963a2c39`
- [42182759310](https://github.com/terminalx-ai/terminalx/actions/runs/42182759310) · 2026-11-06T07:43:37Z · `ef15312fad9a`
- [42182220329](https://github.com/terminalx-ai/terminalx/actions/runs/42182220329) · 2026-11-06T07:38:37Z · `ce2f2110582f`
- [42181472026](https://github.com/terminalx-ai/terminalx/actions/runs/42181472026) · 2026-11-06T07:31:52Z · `c5562d809ebd`
- [42180827149](https://github.com/terminalx-ai/terminalx/actions/runs/42180827149) · 2026-11-06T07:25:53Z · `8edc397e3119`
- [42083542482](https://github.com/terminalx-ai/terminalx/actions/runs/42083542482) · 2026-11-05T18:22:07Z · `9d129c44ccad`
- [42081866999](https://github.com/terminalx-ai/terminalx/actions/runs/42081866999) · 2026-11-05T18:11:39Z · `76b522c487d3`
- [42078671635](https://github.com/terminalx-ai/terminalx/actions/runs/42078671635) · 2026-11-05T17:51:25Z · `1acbdee62d4d`
- [42078411228](https://github.com/terminalx-ai/terminalx/actions/runs/42078411228) · 2026-11-05T17:49:47Z · `78d9293d62a9`
- [41801072107](https://github.com/terminalx-ai/terminalx/actions/runs/41801072107) · 2026-11-04T08:38:30Z · `6a1c10b41cff`

## Historical local validation (2026-11-06, before merging current main)

- Passed: workflow validation with actionlint 1.7.12; 11 coverage-selector/timing
  regression tests; aggregate-gate exercises for success, failure, cancellation
  and skipped dependencies; `git diff --check`.
- Passed on macOS: desktop and mobile type checking, `pnpm build`, all 18 icon
  checks, Swift helper tests/build, `cargo clippy --locked --all-targets -- -D
  warnings`, the full `pnpm test:webkit-layout` command and permission-details
  WebKit check.
- Passed on macOS: full `cargo test --locked`, with 2,871 unit tests and eight
  integration tests passing. The final full run used `RUST_TEST_THREADS=1`
  while other builds were active on the host (743.99 seconds for unit tests).
  Earlier runs hit timing-sensitive fixture failures; assertions and their
  existing deadlines were retained. The 24 existing ignored tests remain
  unchanged; this change adds no ignored Rust test.
  The final unread-input fixture synchronization also passed a focused macOS
  run after the full suite.
- Passed on macOS: the headless server's all-target Clippy check and all 43
  `local_handover`, `local_lifetime` and `owner_pretool` integration tests,
  covering the session and terminal changes in the shared Rust library.
- Passed on the follow-up run: the unmodified `pnpm check` command, including
  TypeScript and all 4,129 Vitest tests across 339 files (88.91 seconds). Earlier
  runs had timeouts and a worker exit; no assertions, test timeouts or CI checks
  were relaxed to obtain this pass.
- Passed in TerminalX Local VM (Debian 12, ARM64): desktop/mobile type checking,
  all 4,129 Vitest tests in 339 files, frontend build, all five portable icon
  tests and all 11 CI-helper tests. The three Apple icon decoders are exercised
  by the macOS job. Vitest used one worker to fit the VM's 4 GB memory limit.
- Passed on Linux: `cargo clippy --locked --all-targets -- -D warnings` with
  default desktop features. No warning suppression was added.
- Passed on Linux: full default-feature `cargo test --locked`, with 2,821 unit
  tests and eight integration tests passing (206.69 seconds for unit tests).
  The 17 existing ignored tests remain unchanged. Validation used Git 2.51.0,
  two Cargo build jobs, two Rust test threads and two Tokio worker threads to
  fit the VM; no test was filtered out. Linux failures led to the portability,
  watcher-lifetime and PTY deadline fixes described in `CI-RUNNERS.md`.

That earlier Linux suite passed on a real Linux kernel, in an ARM64 VM. These
local checks are correctness evidence, not CI performance measurements: they
do not substitute for GitHub-hosted AMD64 CI or either post-change ten-run
comparison. No Hetzner runner has been provisioned, activated or certified by
this change.
