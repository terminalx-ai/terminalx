# CI runners (PRO-267)

This change is **Step 1: split CI on GitHub-hosted runners**. The Hetzner
controller, snapshot, provisioning and live isolation tests belong to a separate
Step 2 change. Step 3 is a person’s activation decision after those tests pass.
Neither repository settings nor `CI_LINUX_RUNNER` are changed by this work.
The target of roughly 20 minutes is not a measured result yet.

## What runs where

| Job | Runner | Checks and reason |
| --- | --- | --- |
| `linux-frontend` | `vars.CI_LINUX_RUNNER` or `ubuntu-latest` | Desktop/mobile TypeScript, full Vitest suite, frontend build, portable source icon tests, CI helper tests. These do not require Apple tools. |
| `linux-rust` | Same variable/fallback | `cargo clippy --locked --all-targets -- -D warnings` and **full** `cargo test --locked`, with the default desktop feature and WebKit/GTK/audio build packages. No test filter or `--no-default-features`. |
| `macos` | `macos-latest` | Full source/packaged/compiled icon checks (`iconutil`, `xcrun`, `actool`), frontend build for WebKit, all WebKit layout checks plus permission details, Swift tests, computer-use helper app build, macOS Clippy. |
| `macos-rust` | `macos-latest`, selected below | Helper build and full macOS `cargo test --locked`. |
| `desktop-platforms` | Existing Ubuntu matrix | Existing platform build, computer contract, input safety and Linux renderer/launcher tests. Windows steps remain in place for when Windows runners return. |
| `headless-serve` | `ubuntu-latest` | Existing headless build, dependency-tree exclusion, Clippy, integration tests and self-test. Keep this on a clean runner without GUI packages. |
| `legacy-runtime-probe` | Ubuntu and macOS | Existing legacy AppImage diagnostics on both systems. |
| `macos-rust-changes` / `check` | `ubuntu-latest` | Coverage selection / aggregate required status. |

Every pre-split command remains. The source icon test is separated into portable
and Apple decoder classes: Linux runs all five portable tests; macOS still runs
all eight source tests plus all packaged/compiled icon tests. No Rust tests have
been ignored or removed by the split.

`check` keeps its original name so existing required-check rules continue to
work. It requires success from every job, accepting a skipped `macos-rust` only
when the successful selector explicitly returned `false`. Failure, cancellation,
and unexpected skips fail this aggregate check.

## macOS Rust coverage

The full macOS suite runs on pushes to `main`, nightly at 02:23 UTC, manual
workflow dispatch, and selected pull requests. The nightly trigger takes effect
once the workflow is on the default branch. Non-PR runs have unique concurrency
groups, so rapid main pushes and nightly runs cannot replace pending push runs.

`infra/ci-runners/macos-rust.py` derives the PR path set from **both** the merge
base and PR head, including files containing `target_os = "macos"` or
`target_vendor = "apple"`, macOS-named Rust files, and `native/`. It includes
companion module directories conservatively (for example `computer/`,
`transcription/`, `local_runtime/`, `browser/`, `pairing/`, `status/`, and
`harness/codex/`). Rust manifests/locks, build scripts, toolchain/configuration,
crate roots, workflow and helper scripts also select the suite. Deletions and
renames are checked at their old paths too. Adding a new macOS cfg automatically
adds its file to coverage; no hand-maintained file list can silently go stale.

Print the exact current list:

```sh
python3 infra/ci-runners/macos-rust.py --base HEAD --list
python3 -m unittest discover -s infra/ci-runners -p 'test_*.py'
```

**Coverage no longer provided on every PR:** frontend-only, documentation-only,
and shared Rust changes outside those paths no longer execute Rust tests on
macOS before merge. They still run the full Linux Rust suite, macOS Clippy, Swift,
WebKit and Apple icon checks. Platform differences in otherwise shared Rust code
can therefore be detected only by main/nightly macOS tests; use manual dispatch
on the PR branch when that risk is relevant. macOS-selected PRs retain the full
suite, so their latency can exceed the ordinary PR target.

## Permissions and caches

`ci.yml` has top-level `permissions: contents: read`, no repository secrets, and
no privileged PR trigger. All checkouts disable persisted credentials. Keep
release, notarization and updater-signing workflows on their separate trusted
runners; never send their credentials to CI runners.

Linux Rust, macOS Clippy and macOS tests use distinct Cargo cache namespaces.
The new Linux cache includes architecture. They restore on PRs and save only
from pushes to `main`; a failed job does not save. Existing desktop/headless
caches and pnpm caching retain GitHub’s cache scoping. No shared writable disk
cache is added. [GitHub documents that PR caches are scoped to their merge ref,
and that fork PRs can read base-branch caches](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
Never cache credentials. Any future object-store Rust cache must enforce main-only
writes outside PR-controlled workflow code.

Read-only inspection on 2026-11-06 found repository default workflow permissions
already set to `read`, PR-review approval by Actions disabled, no runner variable,
and fork approval set to `first_time_contributors`. **That fork policy is not
sufficient to enable Hetzner.** A maintainer must explicitly choose “Require
approval for all external contributors” under Settings → Actions → General.
Changing either setting requires the person’s approval as specified in PRO-267.

## Step 2: infrastructure acceptance contract

Provisioning has not been implemented or deployed in Step 1. Before its separate
change can proceed, the person supplies a CI-only Hetzner project and a dedicated
GitHub machine account with access to this repository only. Enter both API tokens
on the separate controller VM, never in chat, the checkout, runner user-data,
snapshot, Actions secrets, job environment or log. A controller classic token
must be the minimum required by the chosen provider; do not use a personal token
with access to other repositories.

The Step 2 implementation must provide and test this setup from scratch:

1. A small controller VM, with runner registration scoped to this repository.
   Its long-lived GitHub and Hetzner tokens stay in owner-only files there.
   Job labels cannot choose arbitrary images, scripts, networks or server sizes
   on the controller. Forks control their workflow YAML, including labels.
2. A versioned clean snapshot containing Rust/Clippy, Node from `.nvmrc`, pnpm
   from `package.json`, Python/Pillow and the Linux dependencies in `ci.yml`.
   It contains no registered runner identity, tokens, SSH keys, checkout, caches
   or user data. Build and scan it before registering any runners.
3. One newly created VM per job, starting with 16 dedicated vCPUs, with no warm
   pool, server recycling, shared volumes, private network or shared Docker
   socket. Destroy the VM after success, failure or cancellation. Controller
   reconciliation must remove abandoned/busy-too-long instances even if a job
   kills the runner process or suppresses guest shutdown. Establish a maximum
   concurrency, lifetime, deletion grace period and cost limit on the controller.
4. A Cloud Firewall attached **at creation** with no inbound rules, including
   IPv6, and no connection to production or other private networks. Provision
   through boot-time initialization/outbound registration without opening SSH.
   Do not assume a provider’s default SSH-based setup meets this requirement.
5. No unapproved fork job starts. Validate the **repository setting** with an
   external-contributor canary; a workflow `if:` or label is not a boundary.
6. Run isolation canaries: job A writes a unique file under its home; later job B
   asserts absence. Record distinct VM/runner identities in private operational
   evidence. Verify deletion with `hcloud server list` after the configured
   grace period, including failure/cancellation and controller restart.
7. Scan a runner externally during a job: no inbound port responds. In a
   disposable validation job, attempt to create a uniquely named Git ref using
   its `GITHUB_TOKEN` and require HTTP 403. Any successful write fails acceptance
   and requires cleanup by a maintainer. Keep this canary out of normal CI.

[TestFlows](https://github.com/testflows/TestFlows-GitHub-Hetzner-Runners/wiki)
is a candidate, not an approved configuration. Its documentation exposes server
recycling, standby pools, persistent caching volumes and workflow-controlled
setup labels; these require explicit restriction for this threat model. Verify
its boot/registration path against the no-inbound requirement before selecting
it. An equivalent controller is acceptable if all of the above holds.
[GitHub recommends against self-hosted runners for public repositories](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access),
and [fork approval requires maintainer inspection before running workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks).
Ephemerality limits persistence; it does not make malicious jobs harmless.

### Token rotation and incident shutdown

Before rotation, stop provisioning on the controller and remove the runner
variable so new runs use GitHub-hosted runners. Drain or cancel in-flight runner
jobs, destroy their VMs and remove stale repository registrations. On the
controller only, replace the GitHub machine-account token in its owner-only
credential file, restart the service, verify repository-scoped registration with
a disposable job, then revoke the old token. Repeat separately for the CI
project’s Hetzner token and verify create/delete in that project before revoking
the old token. For suspected exposure, revoke first and accept the interruption.
Never print either value. Destroy any image/VM that might contain a credential.
The Step 2 runbook must supply the actual service/config paths and pinned provider
commands; these cannot be claimed verified before that implementation exists.

## Step 3: enable, disable and measure

Only after Step 1 has a Linux pass and 10-run comparison, and Step 2 passes every
live canary, may a person set repository variable `CI_LINUX_RUNNER` to the
validated repository runner label. Both Linux jobs use the single label string;
JSON arrays are not accepted by this workflow expression. A person makes this
activation decision; no script in this change edits it.

To turn it off, delete or empty that variable in repository Actions variables.
The next run resolves both jobs to `ubuntu-latest` without changing code. Already
queued/running jobs keep their original selection: cancel and rerun those after
removing the variable if an immediate fallback is needed. Stop the controller
and reconcile/delete its remaining VMs; a variable is routing, not isolation.

[Measurement instructions, baseline data and pending comparisons](CI-RUNNERS-MEASUREMENTS.md)
are kept separately. Collect at least ten post-split PR runs before activation,
then at least ten Hetzner PR runs. Report actual median/p90 whole-run and job
latency, queue time effects and selected macOS-suite counts in the PR and PRO-267.
Do not substitute projected speedups for observed numbers.
