# Prepared PR publication text

Title: `ci: run portable Rust checks on Linux with a guarded runner rollout (PRO-267)`

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
tracing flag prevented both command and directory guard execution. It is now
unset before any executable starts, with fail-closed regression coverage.
Approval-wrapper changes always select the macOS suite as well.

## Security

- Every PR, including internal PRs, uses GitHub-hosted runners. Only main
  push/schedule/dispatch may select `CI_LINUX_RUNNER`; unset means Ubuntu.
- Read-only workflow token, no PR secrets, no privileged PR trigger, no checkout
  credential persistence, full-SHA action pins, and separate PR/main/job caches
  with no cross-scope restore fallback. Policy regression fixtures run in CI.
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

[Runbook and owner steps](docs/CI-RUNNERS.md).

## Validation and measurements

See [dated validation and reproducible observations](docs/CI-RUNNERS-MEASUREMENTS.md).
The historical ten-run unsplit baseline is 59.0 minutes median / 74.1 p90.
Today's #882 baseline has only **6/10** successful first attempts using the exact current workflow: 52.2 median /
62.3 p90. PRO-267 post-change and Hetzner samples are **0/10** at preparation.
No ten-run improvement or 20-minute result is claimed.

## Still required from the owner

Approve/set external-contributor approval and read-only defaults; verify protected
main and restricted workflow access; supply dedicated machine-account and cloud
project credentials on the controller; approve a separate infrastructure change;
complete admission, isolation, deletion, network and token-write canaries; then
explicitly decide whether to set `CI_LINUX_RUNNER`. None of those settings,
credentials, servers or registrations is changed by this PR. Main-only Hetzner
acceleration cannot be reported as PR acceleration. Both ten-run comparisons
remain open; keep PRO-267 open for these acceptance criteria.

Related: PRO-267.
