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
  escalation, workflow-wide secret expressions, privileged triggers, broad
  cache fallbacks, missing aggregate dependencies and missing security tools.
  The aggregate accepts success and rejects failure, cancellation and skips.
- Passed: diff whitespace checks and an added-line scan for credential/key/IP
  patterns. Baseline JSON contains only public run metadata and durations.

The first merged Linux run found four security-test failures: setting an empty
loader-tracing flag returned success before executing either the command or its
directory guard. The initial fix unset it before launching an executable.
Independent review then found that a startup-defined `unset` function could
execute before sanitization. The revised fix rejects a present flag using only
redirection and parameter expansion, without a cleanup command or control
keyword that startup functions or aliases could replace. Its regressions
exercise sh, bash and zsh directly, including empty and readonly flags. CI
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
AMD64 CI and independent review remain merge gates; no local timing is
substituted for the incomplete ten-run comparisons or live Hetzner acceptance.

## Review 1 corrections (2026-11-11)

The reviewer reproduced an unapproved write through a startup-defined `unset`
function, including when the later directory guard returned 125. The revised
wrapper has no cleanup command to resolve: a present loader-tracing flag causes
a redirection through `/dev/null/<fixed suffix>` to fail before execution.
Normal execution retains stdin and the directory guard. The regression poisons
`unset`, `builtin`, `command`, `false`, `exit` and aliases in bash/zsh startup
files, proves the malicious fixture is active, and checks both accepted and
refused commands without a marker write. The sh/bash/zsh loader tests also
cover empty, unexported, exported and readonly flags.

All four Cargo jobs now restore their own cache namespace first, then a matching
main cache with the same job, OS, architecture and lockfile hash. Saves retain
the original primary key and PR merge-ref isolation. The new namespace first
needs a successful main run to populate it; no elapsed-time improvement is
claimed, and the incomplete ten-run samples above remain unchanged.

Validation of these corrections:

- Passed: all 28 CI policy/selector/measurement tests and actionlint. New negative
  fixtures reject other-PR restores, shared main write keys, saving to a matched
  fallback key and removal of the main restore fallback.
- Passed: desktop TypeScript. The full Vitest run had 5,385 passes and seven
  five-second timeouts in five unchanged files while host load was about 199 on
  16 CPUs. All 63 tests in those five files passed in a one-worker rerun, with
  unchanged assertions and deadlines. No second full Vitest pass is claimed.
- Passed: `cargo clippy --locked --all-targets -- -D warnings` on Linux and macOS.
- Passed on macOS: all 17 approval-wrapper tests, plus the session-directory
  regression using that freshly compiled test binary. A redundant second Cargo
  compile was stopped; no second full macOS suite is claimed.
- Passed in TerminalX Local VM (Debian 12 ARM64): full default-feature
  `cargo test --locked`, **3,372 unit tests and 14 integration tests**, zero
  failures and the same 17 pre-existing ignores. Both changed Rust files had
  identical hashes in the VM and worktree. Unit tests took 297.49 seconds;
  this is local correctness evidence, not a CI timing sample.
- Passed: Rust formatting, diff whitespace and added-line credential/key/address
  pattern checks. No runner, repository-setting or activation changes were made.

## Review 2 correction (2026-11-11)

The reviewer reproduced an inherited zsh `TRAPZERR` function writing a marker
and exiting zero when loader rejection failed its redirection. The guarded
execution now occupies the conditional side of `&&`, suppressing inherited error
hooks while retaining a failing exit status. Only on success, the existing
loader-masked `/usr/bin/env -i` launcher runs again without a payload to return
zero silently. It resolves no new shell helper and performs no ordinary shell
assignment; normal output, stdin and exit statuses are preserved.

The new executable fixture installs `TRAPZERR`, `TRAPERR`, list-style zsh traps
and bash `ERR` traps through shell startup files. Its unguarded control must
write the marker and forge success. The approved wrapper must then preserve
success, command failure and directory rejection, or fail closed for empty,
set and readonly loader flags, with no marker. The matrix also covers strict
shell modes. Existing startup-function coverage now poisons status/cleanup
helpers, zsh null commands and a global alias for an empty status expansion.
On Linux, it also requires bash nameref support and poisons `LC_ALL` with an
array-index command substitution. This catches attempts to use an ordinary
assignment as a status helper. macOS's system bash 3.2 lacks namerefs; all other
cases run there. All existing checks remain enabled; runner activation remains
owner-only.

Validation of the final revision:

- An initial candidate failed the startup-alias regression. The final revision
  keeps that regression and uses the existing masked launcher instead of a
  shell status helper. A Linux probe also demonstrated why an ordinary shell
  assignment is unsafe with a nameref; the fixture now enforces that case.
- Passed: desktop TypeScript and all **5,392 Vitest tests in 456 files** in one
  run with two workers, without changing assertions or test deadlines.
- Passed: `cargo clippy --locked --all-targets -- -D warnings` on macOS and Linux.
- Passed on macOS: all **18 approval-wrapper tests** plus the session-directory
  regression, **19 total**, in a single test invocation. No full macOS rerun is
  claimed; that suite remains selected for this PR in CI.
- Passed in TerminalX Local VM (Debian 12 ARM64): full default-feature
  `cargo test --locked`, **3,373 unit tests and 14 integration tests**, zero
  failures and the same 17 pre-existing ignores. Both changed Rust files had
  identical hashes in the VM and worktree. Unit tests took 269.08 seconds;
  this is local correctness evidence, not a CI measurement.
- Passed: Rust formatting, diff whitespace and added-line credential/key/address
  pattern checks. The incomplete ten-run samples and owner-only Hetzner
  prerequisites remain open.

## Review 3 correction (2026-11-11)

The previous presence check could evaluate a Bash nameref's array subscript
before environment cleanup or directory validation. The replacement never
expands or tests a startup-defined named parameter. It probes the existing
masked `env -i` launcher with a clean shell that exits 9, then uses shell-owned
`$?` and descriptor duplication to reject the tracing loader's false status 0.
No cleanup builtin or new aliasable control keyword runs in the startup shell.
The previous function, alias and error-trap protections remain in place.

The new regression first proves that the malicious nameref writes its marker
when expanded, including a reference to an unset array element. The actual
wrapper must then produce `hello` in the approved directory and status 125 in
the wrong directory, without a marker in either case. Both unset and populated
targets run on Linux Bash 5.2. macOS system Bash 3.2 cannot define namerefs.
Unexported flags and Darwin's inert glibc flags now allow genuine sanitized
execution; their tests require real output and the directory guard, rather
than accepting an early zero status. Exported glibc flags still fail closed,
including empty and readonly values. No existing case was removed.

The new test failed against the previous wrapper with the reproduced marker
write, then passed after the fix in a focused source-level Linux harness.
Validation of the final source revision:

- Passed on macOS and TerminalX Local VM (Debian 12 ARM64):
  `cargo clippy --locked --all-targets -- -D warnings`.
- Passed on each platform: **20 focused project tests**, comprising all 19
  approval-wrapper tests and the session-directory regression, with zero
  failures or ignores. The invocation was `cargo test --locked --lib --
  harness::read_only
  session::watch_tests::codex_0164_discovery_and_session_grants_enforce_their_directory_at_execution`.
  The new nameref payload ran on Linux Bash 5.2; macOS's Bash lacks namerefs,
  as documented above. No new full-suite or frontend rerun is claimed.
- The two Rust files had identical hashes in the VM and worktree. Rustfmt,
  diff whitespace and added-line credential/key/address pattern checks passed.

These local checks do not fill either incomplete ten-run CI sample.
Infrastructure, credentials, repository settings and runner activation remain
owner-only. The independent review hold is unchanged.

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

## Step 1 of the 5 to 10 minute target (2026-11-23): what was measured, and what was not

The workflow changes of #1514 (nextest in parts, the wider selector, the
Linux WebKit workflow) were written without a CI run. Nothing below is a
measured run time on a hosted runner; the first pull request that carries the
workflow is the first measurement. Local checks were compile-only by the
owner's rule: no full suite ran.

Measured on the development Mac (arm64, busy, load average 8 to 100):

| What | Result |
| --- | --- |
| `cargo test --locked --lib --no-run` with only a one-line `dist/index.html` | builds, 4 min 46 s warm dependencies |
| Tests in the library's binary (`--list`) | 5,871, of which 26 `#[ignore]` |
| `cargo nextest list --locked --lib --profile ci` (cargo-nextest 0.9.152) | 5,845: the same names, less the 26 ignored |
| `--partition count:N/4` | 1,462 + 1,461 + 1,461 + 1,461 = 5,845 |
| `--partition hash:N/4` | 1,492 + 1,463 + 1,467 + 1,423 = 5,845 |
| 85 tests by name under nextest: the privacy tests that run the test binary again, `github_process`, `session::codex_stdio`, `machine_host::security_tests`, `control::issue_tests` and others | 85 passed, none retried; 297 s, all of it one test |
| The slowest of them, `github_process::tests::privacy_covers_identity_and_issue_entry_points` | 297 s in a process of its own under that load |
| macOS filters (`macos-rust.py --filters`) against the binary's list | 51 filters, 1,889 of 5,871 tests |
| The selector over the last 400 first-parent commits | none of the selected jobs 8; frontend alone 94; Rust alone 44; phone alone 2; Rust and frontend 64; macOS 118 |
| WebKit parts (`run-all.mjs --shard N/4 --list`) | 32 + 31 + 31 + 31 = 125 |

Not measured, and to read from the first runs: each `linux-rust-tests` part's
time under nextest on a four-core runner (the 297 s test sets a floor for its
part); whether the serve crate's test binaries pass on a hosted runner (no
workflow ran them before); the Linux WebKit parts; a cold and a warm
`ci-v5` cache; and the macOS job's time on a selected pull request.

## Step 1, first hosted runs (2026-11-23)

One run of each, so every number is a single sample.

### #1518's first run (run 45252128642, head `c9e811e4`)

| Job | Result | Time |
| --- | --- | --- |
| `linux-rust-tests` parts 2, 3, 4 (nextest) | pass, 1,443 tests each | 14 min 45 s, 14 min 30 s, 15 min 23 s; the tests themselves 132 s, 222 s, 202 s |
| `linux-rust-tests (1)` | failed before any test | an `apt-get` download hung until the step's 10 minutes ended |
| `linux-rust-tests (binaries)` | pass | 17 min 17 s |
| `serve-tests` | pass | 10 min 15 s |
| `linux-rust` (Clippy) | pass | 12 min 23 s |
| `webkit-layout` (macOS, 125 checks) | pass | 22 min 2 s (11 min 46 s for the same checks on #1515's first run) |
| `macos-native`, selected pull request | pass, 1,875 passed and 14 ignored of 51 filters | 81 min 34 s |
| `frontend` | failed | the icon check ran before `pnpm` was set up |

Every Rust job compiled from nothing: no `ci-v5` cache existed. A warm run is
still unmeasured, on Linux and on macOS.

`macos-native` compiled the library's tests twice: the `--no-run` step ended
with `Finished test profile in 34m 25s`, and the test step then printed
`Compiling raccoon` again and `Finished test profile in 28m 23s` before
`running 1889 tests` (856 s). Which input changed between the two is not
found.

### WebKit on Linux (run 45252129157, not required)

111 of 120 checks passed over four parts in 4 min 21 s to 7 min 40 s a job;
five are left out as Mac-only. The nine failures, none diagnosed, are step 2's
list:

| Check | Part | What failed |
| --- | --- | --- |
| `sidebar-extras` | 1 | `locator.waitFor`, 15 s |
| `dictation-edits` | 1 | four assertions in "a session's composer" (Delete over a selection; dictated words; Backspace over them; the settled utterance) |
| `quick-open` | 1 | `locator.waitFor`, 30 s |
| `command-palette` | 2 | `locator.waitFor`, 30 s |
| `file-tab` | 3 | `locator.waitFor`, 30 s |
| `review-threads` | 3 | an assertion after the light theme's footer checks |
| `sidebar-order` | 4 | `page.waitForFunction`, 30 s |
| `machine-session` | 4 | an assertion after the light theme's header checks |
| `finished-toast` | 4 | `locator.waitFor`, 10 s |

### WebKit on macOS: one slow run that did not repeat (#1515)

| Run | Runner | Checks | Wall time | Check time |
| --- | --- | --- | --- | --- |
| `main`, fast runner | 4 at once | 124 | 596 s | 2,183 s |
| #1515 round 1 | 4 at once | 125 | 503 s | 1,897 s |
| `main`, slow runners | 3 at once | 124 | 1,650 to 1,940 s | |
| #1518 round 1 (the code of #1515 round 1) | 3 at once | 125 | 1,225 s | 3,631 s |
| #1515 round 2 | 3 at once | 123 of 128 ended | cut off at 50 minutes | over 8,319 s |
| #1515 round 3 | 3 at once | 128 | 1,888 s | 5,604 s |

Runner speed moves this job more than the pooling does: do not set the fast
run's 11 min 46 s against `main`'s median.

Round 2 is one bad run whose cause is not shown. The same 109 checks took
7,344 s against 3,208 s on #1518's round, 1.2 times as long in the first ten
minutes and about 3.6 times from the twentieth on; `agent-dashboard`'s three
entries had run together for five minutes just before. Run alone on a Mac, a
part, a Vite check, `machine-page` and `run-all` itself each left no process
behind. Round 3, with the parts of a split check taking turns (228 s, 103 s,
129 s) and each start line saying the host's state, read: no swap in use at
any start, 8 WebKit and 4 node processes throughout, 0.6 to 2 GB free, and a
load average of 10 to 33 on three cores. So nothing is left behind and the
runner is short of processor, not of memory. The bound stays because it is
cheap; it is not known to have fixed anything.

### Flaky tests seen on these runs

| Test | Seen | What it said |
| --- | --- | --- |
| `machine_host::security_tests::a_caller_from_a_public_address_is_refused_under_every_listen_choice_unless_allowed` | #1515, Linux | `EOF while parsing a value` at `security_tests.rs:362`: the refusal file read while still empty (read from the log, not reproduced). PRO-513. |
| `pairing::tests::a_phone_starts_sessions_and_changes_settings_only_as_its_scope_allows` (child `phone_router_child_fixture`) | #1515, Linux | the child's call refused with `person_required` at `pairing/mod.rs:2337`. Cause not known. |
| `finished-toast` (WebKit check, new with #1499) | `main`, #1515 rounds 2 and 3, #1517, the Linux trial | 10 s waiting for the notice at `finished-toast.mjs:61`. The fixture listed the tab as idle and the list read again on focus undid `in_progress`. Fixed in #1515. |
| `remote::git::tests::mention_lookups_read_the_workspaces_pull_requests_with_its_gh` | #1515, Linux | `gh: Text file busy`. Fixed in #1520. |

### #1518's second run (run 45288239288, head `92294332`)

Caches of the new shape existed (this pull request's own, from the first run).

| Job | Result | Time |
| --- | --- | --- |
| `linux-rust-tests` parts 1, 2, 4 (nextest) | pass, 1,444 / 1,443 / 1,443 tests | 6 min 37 s, 6 min 28 s, 7 min 28 s; tests 121 s, 115 s, 146 s; build about 3 min 35 s |
| `linux-rust-tests (3)` | pass, 1,443 tests | 15 min 53 s |
| `linux-rust-tests (binaries)` | pass | 10 min 11 s |
| `serve-tests` | pass | 9 min 8 s |
| `linux-rust` (Clippy) | pass | 2 min 45 s |
| `frontend` | pass | 1 min 27 s |
| `phone-app` | failed on `main`'s two `setup-routes` tests of 1,685 | 51 s |
| `macos-native`, selected pull request | pass, 1,875 passed and 14 ignored | 44 min 7 s |
| `webkit-layout` | cancelled by a 35 minute limit this branch had set; 116 of 128 done, none failed | 35 min 32 s |

Every Linux job was done 16 minutes after the push.

Part 3 was slow for two reasons, neither the partition: its `apt-get` step
took 466 s (24 s on part 2), and its tests took 214 s because it holds the
two slowest tests (the socket-capacity test and the 112 s privacy test, both
shortened in #1520, which this branch does not have).

`macos-native` with Clippy in front: Clippy 6 min 40 s and 5 min 55 s, the
library's test build 9 min 53 s, and then the test step still compiled the
crate again, 11 min 9 s, before `running 1889 tests` (457 s). So the second
compile did not move to Clippy; which input changes is still not found.

nextest reported no flaky test and two leaky ones:
`action_runner::tests::a_running_non_concurrent_action_is_returned_and_restart_replaces_it`
and
`action_runner::tests::a_restart_whose_old_run_will_not_stop_starts_nothing_and_holds_up_no_other_action`.

Linux WebKit, second sample: part 3 passed; the others failed
(`sidebar-extras`, `file-tab`, `review-threads` in one part; the other two
parts' lists were not read).

Two more flaky results seen that night, neither fixed here:

| Test or check | Seen | What it said |
| --- | --- | --- |
| `bots::calendar::tests::a_duty_deleted_mid_run_ends_its_run_then` (`src/bots/calendar_tests.rs:669`) | #1515's macOS rerun | 5,844 passed, 1 failed |
| `agent-dashboard` on `main` (one check, seven layouts) | #1520's WebKit rerun | cut off at `run-all`'s 600 s; #1515 splits it into three entries |

### #1518's third run (head `3456d0c3`): the package mirror

`linux-rust-tests` parts 1, 2 and 4 failed in "Install Linux build
dependencies" at that step's ten minute limit. The mirror
(`us-east-2.ec2.archive.ubuntu.com`) served packages at seconds per small
file, so the 30 s stall option never fired and nothing was retried; the same
step took 24 to 26 s in other jobs of the same run. The step's own limit is
gone (`main` never had one there); the job's limit bounds it, and the retry
and stall options stay. A cache for the packages is a later piece.

### The slow package installs are one mirror (24 November 2026)

In #1523's run (45338978657) the same 91.3 MB of packages took:

| Job | Runner region | Mirror | Fetch |
| --- | --- | --- | --- |
| `linux-rust` | `us-west-2` | `us-east-2.ec2.archive.ubuntu.com` | 23 min 34 s (64.6 kB/s) |
| `linux-rust-tests (1)` | `us-west-2` | the same | 24 min 13 s (62.9 kB/s), then cut off at the job's 30 minutes |
| `linux-rust-tests (2)` | `eastus` | `azure.archive.ubuntu.com` | 5 s (18.9 MB/s) |
| `linux-rust-tests (4)` | `eastus` | `azure.archive.ubuntu.com` | 5 s (18.3 MB/s) |

`serve-tests` in that run was on a `us-east-1` runner and the EC2 mirror too.
The mirror comes from the image's `/etc/apt/apt-mirrors.txt`, which differs
by where the runner is. `infra/ci-runners/apt-mirrors.sh` now writes that file
before every install (Azure first, `archive.ubuntu.com` behind it) and prints
what it replaced.

What the file held, as the script printed it (#1525's run 45344630294):

| Runner region | priority 1 | priority 2 | priority 3 |
| --- | --- | --- | --- |
| `westus3`, `centralus`, `westus2` (Azure) | `http://azure.archive.ubuntu.com/ubuntu/` | `https://archive.ubuntu.com/ubuntu/` | `https://security.ubuntu.com/ubuntu/` |
| `us-west-2` (AWS) | `http://us-east-2.ec2.archive.ubuntu.com/ubuntu/` | the same | the same |

With the script, in that run:

- Jobs on AWS-region runners were fast from the Azure mirror:
  `webkit-layout-linux (2)` on `us-west-2` fetched 140 MB in 20 s
  (7,094 kB/s) and `vitest (1)` on `us-west-2` 4,988 kB in 1 s. The same
  region got 64.6 kB/s from the EC2 mirror.
- Every install took 9 to 43 s across `eastus`, `centralus`, `westus`,
  `westus2`, `westus3`, `southcentralus` and `us-west-2`; the 91.3 MB set took
  5 to 25 s.
- Every Linux job was done 11 min 37 s after the push, with waits of up to
  4 min for a runner.

The case without it, the same morning: #1526's run at 07:28 UTC
(45348218412) lost `linux-rust-tests (1)` and `(binaries)` to the 30 minute
limit, with the install at 29 min 27 s and 26 min 56 s.

A cache of the package files was tried and left out. apt does not check a
file that is already in its archive folder: with apt 2.8.4 in an
`ubuntu:24.04` container, a cached `.deb` with one byte changed and its size
kept was "Need to get 0 B" and went to dpkg unread, and `--print-uris` gives
only an MD5 for each file. A cache would need its own SHA-256 check of every
file against `apt-cache show` before apt runs as root.

### The first run of the new workflow with an empty queue

A manual run on `main` at 06:09 UTC (45338347689); every job waited 2 s.

| Job | Time |
| --- | --- |
| Every Linux job but `linux-rust` | done 12 min 14 s after the start |
| `linux-rust` | 27 min 57 s: the install 25 min 34 s (30 s in the other jobs), Clippy 2 min 7 s, cargo cache a hit |
| `linux-rust-tests`, four parts | 6 min 0 s to 9 min 48 s |
| `linux-rust-tests (binaries)` | 8 min 43 s |
| `serve-tests` | 12 min 14 s: tools 3 min 12 s, building the runtime 1 min 28 s, tests 7 min 14 s |
| `vitest`, four parts | 2 min 45 s to 3 min 26 s |
| `frontend` | 1 min 44 s |
| `phone-app` | 57 s |
| `webkit-layout` (macOS) | 33 min 33 s: 129 of 129, 3 at once, 1,906 s for 5,644 s of checks |
| `macos-native` (full suite) | Clippy 11 min 46 s and 8 min 31 s; the test build still running at 38 min when this was written |

### #1523's first run (45338978657)

Pull request jobs: `frontend` 1 min 38 s, `vitest` 2 min 24 s to 3 min 22 s,
`phone-app` 1 min 3 s, `serve-tests` 10 min 55 s, `headless-serve` 5 min 42 s,
`machines-e2e` 3 min 56 s, `machine-compat` 4 min 27 s, `linux-rust-tests`
parts 2 to 4 7 min 21 s to 7 min 57 s and the binaries 8 min 27 s,
`webkit-layout` 29 min 38 s. `linux-rust` 27 min 19 s and part 1 (cancelled
at 30 min 16 s) were the slow mirror. `macos-native` was cancelled at
32 min 9 s. The Linux WebKit trial failed in all four parts.

### Seen on #1525's run (45344630294, head `a51b839f`), neither from that change

| Test or check | Where | What it said |
| --- | --- | --- |
| `machine_host::security_tests::the_listen_choice_decides_what_is_bound_and_relay_only_opens_no_port` | `linux-rust-tests (3)`, `src-tauri/src/machine_host/security_tests.rs:567` | "the port is closed": the test connects to the old port number after the listener closed and expects a refusal; under nextest another test's process can be given that port. On PRO-513, with a retry entry. |
| `setup check coach (dark): the coach mark sits wholly above the composer` | `webkit-layout` on macOS | 128 of 129 in 538 s, on a runner that ran 4 at once. |

`macos-native` on that head (a pull request that selects it): Clippy took
21 min 39 s for its two steps and the library's test build 32 min 54 s
(07:31:38 to 08:04:32); the job was still running when this was written.

## Step 2: the WebKit layout checks become required Linux jobs (2026-11-24)

The Linux trial workflow (`webkit-linux.yml`, not required) on draft pull
request #1530, whose two WebKit pieces fixed the checks that failed only on
Linux. Times are each job's start to its end, from `gh run view`.

| Run | Head | Part 1 | Part 2 | Part 3 | Part 4 |
| --- | --- | --- | --- | --- | --- |
| 45361220945 (pull request) | `0350c08a0` | 8 min 3 s, failed | 5 min 28 s, failed | 5 min 1 s, failed | 4 min 13 s, failed |
| 45362750128 (by hand, next) | `0350c08a0` | 7 min 11 s, failed | 5 min 30 s, ok | 4 min 55 s, failed | 6 min 59 s, failed |
| 45372204285 (pull request) | `880f19ca4` | 8 min 36 s, ok | 6 min 33 s, ok | 4 min 14 s, failed | 6 min 42 s, failed |
| 45373848579 (by hand, next) | `880f19ca4` | 9 min 23 s, ok | 5 min 18 s, failed | 5 min 6 s, failed | 5 min 37 s, failed |

The macOS `webkit-layout` job on the same runs: 33 min 28 s (job
138331629037, CI run 45361221006) and 35 min 42 s (CI run 45372204348), each
ending "126 of 129 checks passed".

Every check the two pieces changed passed in both trial runs of its piece and
on macOS (the pieces' reports: sidebar-order, sidebar-extras, file-tab,
editor-toolbar, review-threads; command-palette, quick-open, chat-controls,
dictation-edits, dialog-lists, machine-session, cloud-setup). What failed in
the parts was not theirs:

| Check | Where | Cause, as far as known |
| --- | --- | --- |
| `repository-scripts`, `review-tab`, `composer-controls` | the Linux runs (45372204285 parts 3 and 4, 45373848579 parts 3 and 4) and macOS | main's own at `45280a95` (run 45358840151, job 138324967922): #1529 merged before its CI had a result; fixed on main by a separate worker |
| `organization-roster` | 45372204285 part 4 | once; being fixed on `raccoon/webkit-linux-flaky` |
| `sparse-checkout`, `agent-dashboard:3`, `create-project` | once each on 24 November, by the lead's count (the run of each not read here) | being fixed on `raccoon/webkit-linux-flaky` |

The failed parts of 45361220945, 45362750128 and 45373848579 part 2 were not
read check by check for this table.

So no run above had all four parts green. The gate below is not yet shown
green on Linux in CI; the step 2 pull request goes to the owner after five
full Linux runs in a row on the final branch with every check green, and one
green macOS run of the mac-only checks.

What changed in `ci.yml`: the four parts became `webkit-layout-linux`, counted
in `check`; `webkit-layout` became a Linux job that passes only when every part
did (its limit 10 minutes, down from 50); the macOS job became
`webkit-mac-only`, six checks, run on main, nightly, by hand and on a pull
request the selector's new `mac-webkit` answer picks. `run-all.mjs --list`
lists 130 checks: 124 run in the Linux parts, 6 on macOS.
