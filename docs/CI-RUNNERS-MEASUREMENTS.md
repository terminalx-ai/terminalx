# PRO-267 measurements

The before sample below was collected on 2026-11-06 from the latest ten
successful **first-attempt pull-request** CI runs. This differs from the issue’s
26-run mixed-event baseline (63 minutes median, 76 p90); event and sample size
are explicit to make later comparisons reproducible.

| Phase | Qualifying PR runs | Whole-run median | Whole-run p90 | Status |
| --- | ---: | ---: | ---: | --- |
| Before split | 10 | 59.0 min | 74.1 min | Observed below |
| Step 1, GitHub-hosted split | 0 | — | — | Pending publication and 10 successful runs |
| Step 3, Hetzner | 0 | — | — | Pending infrastructure, person’s activation and 10 runs |

No after result or 20-minute target attainment is claimed. Step 1’s measurement
acceptance criterion remains open until its after column has real observations.

## Method

Whole-run duration is `run_started_at` to the last successful job’s
`completed_at`, so it includes runner queue time. Each job’s duration is its
`started_at` to `completed_at`, including setup and cache post-steps. p90 uses
nearest rank (`ceil(0.9 * n)`, the ninth sorted observation for ten runs). Failed,
cancelled and rerun attempts are excluded; reruns can contain only some jobs.
A skipped optional job is not treated as a zero-duration success. The report
shows each job’s sample size; collect additional runs before comparing a job
with fewer than ten observations.

The read-only collector uses `gh api` locally, not in CI. It stores only public
run identifiers, commit hashes, timestamps and durations, without runner names,
addresses or credentials. Reproduce the committed baseline offline:

```sh
python3 infra/ci-runners/timings.py --label 'Before split: PR baseline' \
  --input infra/ci-runners/baseline.json
```

For each later phase, choose a non-overlapping creation-time window in GitHub’s
`START..END` date/timestamp syntax, then run:

```sh
python3 infra/ci-runners/timings.py --label 'Step 1: GitHub-hosted split' \
  --created "$CI_SAMPLE_WINDOW" --count 10 --output /tmp/ci-step1.json
```

Repeat after activation with a distinct window and label for Step 3. Copy the
resulting Markdown tables and public sample links into the PR and PRO-267. Keep
PR and main-push samples separate. Report the number of PRs that selected
`macos-rust`; compare ordinary PRs and Apple-related PRs separately if the mixes
differ. A macOS-selected PR still waits for the full macOS suite. Record cache
hits/misses and runner CPU architecture/type alongside Step 3’s results. The
collector refuses to claim a comparison with fewer than ten qualifying runs.

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

## Local validation of the Step 1 change (2026-11-06)

- Passed: workflow validation with actionlint 1.7.12; 11 coverage-selector/timing
  regression tests; aggregate-gate exercises for success, failure, cancellation
  and skipped dependencies; `git diff --check`.
- Passed on macOS: desktop and mobile type checking, `pnpm build`, all 18 icon
  checks, Swift helper tests/build, `cargo clippy --locked --all-targets -- -D
  warnings`, the full `pnpm test:webkit-layout` command and permission-details
  WebKit check.
- Passed on macOS: full `cargo test --locked`, with 2,870 unit tests and eight
  integration tests passing. The 24 existing ignored tests remain unchanged;
  this change adds no ignored Rust test.
- Frontend validation is **not green**: the default `pnpm check` run passed 4,126
  tests but timed out in three unchanged tests. A two-worker full retry still
  had two timeouts and a worker exit; an isolated one-worker retry passed 13 of
  14 tests but timed out in `TranscriptReducer > never changes a transcript it
  has handed out`. No assertions, test timeouts or CI checks were relaxed.
- Linux validation is **blocked before compilation**: the existing TerminalX
  Local VM failed dependency installation with `FATAL -> Failed to fork.`
  Subsequent VM commands failed or hung. A working TerminalX Linux VM is needed
  to execute the full desktop-feature Rust suite and Linux Clippy and fix any
  platform assumptions they expose. A macOS pass is not a substitute.

These local checks do not satisfy the Linux test acceptance criterion or either
post-change ten-run measurement requirement. No Hetzner runner has been
provisioned, activated or certified by this change.
