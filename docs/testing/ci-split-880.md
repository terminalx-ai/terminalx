# CI job split validation (#880)

The frontend checks now run independently on Linux, while WebKit layout checks
and the Rust/native suite run in separate macOS jobs. The job timeouts are 20,
35, and 60 minutes respectively. `check` keeps its job ID and cargo cache key.

The active [CI required checks ruleset](https://github.com/terminalx-ai/terminalx/rules/26943162)
requires `check`, `frontend`, and `webkit-layout` from GitHub Actions on `main`.
GitHub reported no required status checks before this change; the existing
deletion and non-fast-forward rules were retained.

## Before the split

Successful `main` runs on 2026-11-10:

- [Run A, 404ab1d](https://github.com/terminalx-ai/terminalx/actions/runs/42756614154)
- [Run B, 29e12af](https://github.com/terminalx-ai/terminalx/actions/runs/42739924487)

Durations in minutes, calculated from GitHub's job start/completion timestamps.
The whole-run duration uses `created_at` to `updated_at` for these completed
runs and includes queueing.

| Job | Run A | Run B |
| --- | ---: | ---: |
| `check` | 68.65 | 78.80 |
| `legacy-runtime-probe (instabox-medium)` | 0.17 | 0.23 |
| `legacy-runtime-probe (macos-latest)` | 0.17 | 0.17 |
| `headless-serve` | 4.02 | 4.40 |
| `desktop-platforms (instabox-medium)` | 8.50 | 7.85 |
| Whole run, including queueing | 68.73 | 78.88 |

## Local validation

Both TypeScript checks, `pnpm build`, and `actionlint` (with `instabox-medium`
registered as a custom runner label) pass. The initial full
Linux run exercised the same 4,921 tests in 421 files as macOS, with zero skips.
It exposed one fixture-permission failure: the Linux sandbox can become root
through `sudo` without being able to traverse a user's private temporary
directory. Making the generated fixture directory readable fixes that test;
all 14 environment-verification tests pass in the sandbox.

An intentional string-to-number assignment in a temporary Linux source file
makes `pnpm exec tsc --noEmit` report TS2322 and exit 2. The fixture is removed
after the demonstration. All three split jobs have no `needs` dependency.

The full macOS suite passes with `--maxWorkers=2`: 4,921 tests, zero skips,
219.83 seconds. Two earlier runs with default worker concurrency hit separate
timing assertions (login polling and transcript search).

After the fixture fix, one Linux run passed all tests in 428.79 seconds; the
next failed the transcript-search wall-time assertion at 116.81 ms against a
100 ms limit (495.61 seconds for the full run). The same assertion failed at
125.23 ms in an earlier macOS run. Five isolated Linux measurements took about
34 ms wall time and 37 ms CPU time each.

The search test now follows the existing `TabView.send` performance-test
pattern: the median of five queries must use less than 100 ms of CPU time and
less than 400 ms of wall time. Every query still checks all 4,000 matches, and
the broad-query result cap is still checked. No tests were skipped.
Both affected test files pass locally after these changes (20 tests), and
TypeScript passes again.

Three consecutive full Linux runs after both test fixes pass:

| Run | Files | Passed tests | Skipped tests | Seconds |
| --- | ---: | ---: | ---: | ---: |
| 1 | 421 | 4,921 | 0 | 449.77 |
| 2 | 421 | 4,921 | 0 | 423.79 |
| 3 | 421 | 4,921 | 0 | 420.30 |

The individual test identities match the macOS suite, accounting for the
renamed CPU-time description of the search test.

The validation environment is TerminalX's Linux ARM64 VM with two CPU cores,
Node 24.22.2 and pnpm 10.33.0; it is separate from `instabox-medium`.

## Hosted acceptance evidence

TerminalX owns pushing this branch and opening its pull request. After those
actions, record the following on the pull request before merging:

- Three consecutive successful `frontend` runs on `instabox-medium`, with the
  same test cases and zero additional skips.
- A disposable type-error demonstration showing `frontend` fails independently
  of the macOS jobs.
- Each job's duration and the whole-run duration after the split, using the
  same timestamp definitions as the baseline above. Include run links and
  report measured values separately from the expected 45–50 minute Rust job.

Read the completed run and its jobs with:

```sh
gh api repos/terminalx-ai/terminalx/actions/runs/RUN_ID
gh api --paginate repos/terminalx-ai/terminalx/actions/runs/RUN_ID/jobs
```

After-split hosted durations are pending the first pull-request CI run.
