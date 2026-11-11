# CI job split validation (#880)

The frontend checks now run independently on Linux, while WebKit layout checks
and the Rust/native suite run in separate macOS jobs. The job timeouts are 20,
35, and 60 minutes respectively. `check` keeps its job ID and cargo cache key.
The four #786 tests now run in `desktop-platforms` on Linux, after its computer
contract tests, using the existing Linux setup and cargo cache.

The cargo cache configuration is unchanged. Per the updated issue, the
24m 48s compiling the test build is code generation for the `raccoon` crate,
not a dependency-cache miss. Compilation optimization is outside this change.

The active [CI required checks ruleset](https://github.com/terminalx-ai/terminalx/rules/26943162)
requires `check`, `frontend`, and `webkit-layout` from GitHub Actions on `main`.
GitHub reported no required status checks before this change; the existing
deletion and non-fast-forward rules were retained.
Review 1 found that the live ruleset had subsequently been reduced to `check`.
The two missing requirements were restored and the effective branch rules
were read back to verify all three GitHub Actions checks (integration 15368).
Recheck the live requirements with:

```sh
gh api repos/terminalx-ai/terminalx/rules/branches/main \
  --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks'
```

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

## Additional Linux validation

The exact #786 command builds and passes in TerminalX's Linux ARM64 VM:

```sh
cd src-tauri
cargo test --no-default-features --features local-ui --lib control::issue_tests
```

Rust 1.99.1, with the Linux native development libraries installed, completed
the cold test-profile build in 11m 46s. All four tests passed in 0.53s, with
zero ignored tests; total command time was 707 seconds. This proves the step
can leave macOS. The cold VM build duration is not an estimate of the cached
`desktop-platforms` runner's duration.

The first hosted frontend run found two differences from the local VM:

- `instabox-medium` did not have `zsh`. The workflow now installs it after the
  TypeScript checks and before Vitest, preserving both shell round-trip cases.
- The hard-link cleanup test assumed removed directories consumed no disk
  blocks. On the hosted filesystem they added 8 KiB. Its expected bytes now
  use the fixture's actual file and directory allocation and still require
  the hard-linked data to be counted exactly once. Cleanup code is unchanged.

All 23 tests in the affected cleanup and terminal-drop files pass on macOS
and Linux after these changes; TypeScript and workflow lint pass too.

## Hosted acceptance evidence

[PR #882](https://github.com/terminalx-ai/terminalx/pull/882) first ran
[CI 42832678810](https://github.com/terminalx-ai/terminalx/actions/runs/42832678810)
on head `69cd9368`, before the additional Linux fixes and the #786 move.
Checkout tested merge commit `00029643`, including 18 newer tests from `main`:
4,937 passed, two failed, zero skipped (4,939 total in 423 files).

The frontend reported failure at 14:21:55 UTC, before `check` started at
14:23:10 UTC. Both TypeScript checks had passed by 14:18:46 UTC. This is hosted
evidence that frontend failures are reported independently of the Mac job.

Durations in minutes; unfinished jobs and whole-run duration remain pending:

| Job | First hosted split run | Result |
| --- | ---: | --- |
| `frontend` | 3.73 | Failed; both Linux issues fixed above |
| `webkit-layout` | Pending | Running |
| `check` | Pending | Running |
| `legacy-runtime-probe (instabox-medium)` | 0.15 | Passed |
| `legacy-runtime-probe (macos-latest)` | 0.22 | Passed |
| `headless-serve` | 5.22 | Passed |
| `desktop-platforms (instabox-medium)` | 10.30 | Passed |
| Whole run, including queueing | Pending | Running |

After TerminalX pushes the follow-up commit, record the following on the pull
request before merging:

- Three consecutive successful `frontend` runs on `instabox-medium`, with the
  same test cases and zero additional skips.
- A disposable type-error demonstration showing `frontend` fails independently
  of the macOS jobs.
- Each job's duration and the whole-run duration after the split, using the
  same timestamp definitions as the baseline above. Include run links and
  report measured values separately from the expected 42–48 minute Rust job.

Read the completed run and its jobs with:

```sh
gh api repos/terminalx-ai/terminalx/actions/runs/RUN_ID
gh api --paginate repos/terminalx-ai/terminalx/actions/runs/RUN_ID/jobs
```

The full after-split run timing and three successful hosted frontend runs
remain pending; the first hosted run above is not a successful acceptance run.
