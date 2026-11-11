# Prepared PR publication text

Title: `ci: move Rust checks to Linux and gate private runners (PRO-267 Step 1)`

## Description

Main's #882 split left Clippy and the full Rust suite on macOS. This change merges
current main and moves the full portable Rust suite to a parallel Linux job,
while preserving required statuses **check**, **frontend**, **webkit-layout**.
`check` becomes an aggregate that requires every job to succeed. All existing
WebKit, Swift, icon, desktop and headless checks remain.

Mac Clippy and native checks still run on every PR. The full macOS Rust suite
runs on every main push, nightly, manual dispatch and PRs selected from both
sides of the change for macOS/Apple cfgs, `native/`, build inputs and companion
modules. Ordinary frontend/docs/shared-Rust PRs outside that set no longer run
macOS Rust tests before merge; Linux runs the full default-feature suite.
No tests are dropped or newly ignored. Earlier Linux portability, watcher
lifetime and PTY deadline fixes are retained through the merge. Linux testing
also caught a false-success bug in main's approval wrapper: an empty loader
tracing flag prevented both command and directory guard execution. A clean-shell
startup probe now detects loader tracing without expanding any startup-defined
parameter or invoking cleanup functions. A descriptor guard rejects tracing
before the real command starts. Conditional execution suppresses inherited zsh
error traps; regressions cover poisoned functions/aliases, strict modes, stdin,
exit statuses and Bash nameref writes in both correct and wrong directories.
Approval-wrapper changes always select the macOS suite as well. A cache fixture
also sets its rewrite timestamp explicitly so same-size writes remain observable
on Linux; its assertions and the production cache are unchanged.

## Security

- Every PR, including internal PRs, uses GitHub-hosted runners. Only main
  push/schedule/dispatch may select `CI_LINUX_RUNNER`; unset means Ubuntu.
- Read-only workflow token, no PR secrets, no privileged PR trigger, no checkout
  credential persistence, full-SHA action pins, and PR/main/job cache write
  isolation. PRs may restore matching public main caches; main cannot restore
  PR caches. Policy regression fixtures run in CI.
- **Do not activate a repository-only runner pool.** Forks can edit workflow YAML.
  Before registration, the owner must enforce GitHub runner-group access to this
  repository's protected-main CI workflow only, and verify denial canaries. If
  that control is unavailable, keep GitHub-hosted CI. Labels, controller job
  filters and fork approval alone are not substitutes.
- The runbook maps threats to controls and requires one fresh unprivileged VM
  per job, external deletion/reconciliation, no controller/cloud/release tokens
  on the guest, isolated networking, restricted egress, short-lived registration
  material, token rotation and incident shutdown. These infrastructure controls
  are prerequisites, not claims about an existing deployment.

[Runbook and owner steps](CI-RUNNERS.md).

## Validation and measurements

Passed locally: desktop/mobile type checks, frontend build, Swift (123) and icon
checks (18). After the first two review corrections: Clippy on Linux/macOS, the full Linux
suite (3,373 unit + 14 integration tests), 18 macOS approval-wrapper tests plus
the session-directory regression, actionlint and 28 CI policy/helper tests.
The merged macOS baseline passed its full suite (3,426 + 14); no second full
macOS pass is claimed. Desktop TypeScript and all 5,392 Vitest tests passed
again in a single run with two workers and unchanged assertions/deadlines.
After the third review correction: Clippy and all 19 approval-wrapper tests
plus the session-directory regression (**20 total**) passed on both macOS and
Linux. The new nameref payload was exercised on Linux Bash 5.2; macOS's system
Bash 3.2 has no namerefs. No new full-suite or frontend rerun is claimed for
that correction. Hosted AMD64 CI and independent review remain required.
No new tests are ignored or removed.
See [dated validation and reproducible observations](CI-RUNNERS-MEASUREMENTS.md).
The historical ten-run unsplit baseline is 59.0 minutes median / 74.1 p90.
Today's #882 baseline has only **6/10** successful first attempts using the exact current workflow: 52.2 median /
62.3 p90. PRO-267 post-change and Hetzner samples are **0/10** at preparation.
No ten-run improvement or 20-minute result is claimed.

| Phase | Successful first attempts | Whole-run median | Whole-run p90 |
| --- | ---: | ---: | ---: |
| Historical unsplit PR baseline (November 6) | 10 | 59.0 min | 74.1 min |
| Current main's exact three-job workflow | 6/10, incomplete | 52.2 min | 62.3 min |
| PRO-267 Linux Rust split | 0/10, pending | — | — |
| Hetzner main-only pilot | 0/10, not activated | — | — |

These are separate cohorts. The measurements document contains per-job tables,
public run links and sanitized input; the current-main and after samples are
still insufficient for the required comparison.

## Still required from the owner

Approve/set external-contributor approval and read-only defaults; verify protected
main and restricted workflow access; supply dedicated machine-account and cloud
project credentials on the controller; approve a separate infrastructure change;
complete admission, isolation, deletion, network and token-write canaries; then
explicitly decide whether to set `CI_LINUX_RUNNER`. None of those settings,
credentials, servers or registrations is changed by this PR. Main-only Hetzner
acceleration cannot be reported as PR acceleration. Both ten-run comparisons
remain open; keep PRO-267 open for these acceptance criteria.

Related: [PRO-267](https://linear.app/procyonlabs/issue/PRO-267/run-cis-linux-tests-on-our-own-hetzner-runners-securely).
