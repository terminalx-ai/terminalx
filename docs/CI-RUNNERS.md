# CI runners (PRO-267)

This is the preparatory Linux split, integrated with the three required statuses
introduced by #882: **`check`, `frontend`, `webkit-layout`**. It does not provision
or activate Hetzner. No repository settings, rulesets or variables are changed.
The latency target and both ten-run comparisons remain unproven; see
[measurements](CI-RUNNERS-MEASUREMENTS.md).

## What runs where

| Job | Runner | Checks |
| --- | --- | --- |
| `frontend` | GitHub-hosted Ubuntu | Desktop/mobile TypeScript, full Vitest, frontend build, portable icon tests, CI policy/selector/measurement tests. |
| `webkit-layout` | GitHub-hosted macOS | All WebKit layout checks and permission-details check, after the frontend build. |
| `linux-rust` | GitHub-hosted Ubuntu on **every PR** | Full default-feature `cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings`; GTK/WebKit/audio dependencies installed. Main push/nightly/manual runs alone may use the owner-approved `CI_LINUX_RUNNER` label; unset/empty falls back to Ubuntu. |
| `macos-native` | GitHub-hosted macOS | Full Apple/source/packaged/compiled icon checks, Swift tests, helper build, macOS Clippy, and selected full macOS Rust suite below. |
| `desktop-platforms` | GitHub-hosted Ubuntu | Existing platform build, computer contract, input safety, local UI control, Linux renderer/launcher tests. Disabled Windows steps retained. |
| `headless-serve` | GitHub-hosted Ubuntu | Existing headless build, dependency exclusions, Clippy, integration tests and self-test. |
| `legacy-runtime-probe` | GitHub-hosted Ubuntu/macOS | Existing legacy AppImage diagnostics. |
| `macos-rust-changes` / `check` | GitHub-hosted Ubuntu | Coverage selector / aggregate status requiring **every** other job to succeed. Failure, cancellation or any skipped dependency fails `check`. |

Every command from main's split is retained. `check` becomes the aggregate so
its existing required status still gates Rust and native checks. The separate
required `frontend` and `webkit-layout` names stay unchanged; no ruleset edit is
needed. All auxiliary Linux jobs also use GitHub-hosted runners, replacing
`instabox-medium`. No tests are dropped or newly ignored. Portable source icon
tests run on Linux; macOS retains all source and Apple decoder checks.

The Linux build also exposed unused macOS-only secure-dialog and dictation
code. Those implementations and real-model evaluation types now compile only
on macOS. Audio resampling, live transcription logic and scoring still compile
under `cfg(test)` and run on Linux; microphone device enumeration remains
available in production on all platforms. These platform gates do not remove
any Rust tests.

Two test assumptions exposed by Linux are corrected: the device-login fixture
reads mode bits with GNU or BSD `stat`, and the cloud-mirror test verifies the
existing conservative case-folding rule on both filesystem types, including
preservation of the person's own files. A shell-test fixture permits directory
traversal for its sudo install step even in Linux containers where root lacks
`CAP_DAC_OVERRIDE`; it contains only synthetic files. Assertions and timeouts
are retained, with no new ignored or macOS-only tests.

The full Linux run also exposed a session-watcher lifetime leak: each manager
left a polling thread retaining its own manager clone after its callers were
gone. The watcher now waits on a channel held only by caller clones, preserving
the five-second interval and exiting when the last caller drops. A regression
test verifies release of the retained observer after the last clone is dropped.

The Linux PTY test exposed late readiness from `poll`: a writable result arriving
after the stall deadline could permit progress and renew the wait for another
ten seconds. Input now checks both deadlines after polling, preserving the
existing timeout bounds. Its real-process test waits for fixture readiness
before timing input; all original timing and independent-pane assertions remain.
The unread-input watcher test also waits for the written byte to reach the
slave's line discipline before exercising the nudge. Linux can finish the
master write before that byte is visible to `FIONREAD`; the test still requires
unread input and proves that neither nudge adds another byte.

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

## Threat model and enforced controls

Assume a fork author controls all PR source, dependencies and workflow YAML,
including `runs-on`, cache keys and job names. A compromised dependency or action
can execute arbitrary code. Main is trusted only after normal protected-branch
review and required checks. A runner is disposable hostile compute once a job
starts. Public source is not confidential; controller credentials, production
access, future jobs and repository integrity are the assets to protect.

| Risk | Control in this change | External control required before activation |
| --- | --- | --- |
| Fork edits YAML to target a private runner | Every PR uses literal GitHub-hosted labels; the sole custom-runner expression accepts only main push/schedule/dispatch. Regression tests reject unguarded labels, including matrices. | **GitHub runner-group workflow access restriction**, detailed below. YAML guards, obscure labels and maintainer approval alone cannot enforce this routing against an edited workflow. |
| Approved PR or another workflow steals a newly registered runner | PRs never opt into the pool, including same-repository PRs. | Selected repository **and selected protected-main workflow** in the runner group; no unrestricted matching runners. Controller admission rejects PRs/other refs/workflows, but is defense in depth: it does not bind a registered runner to one queued job. |
| Job writes repository state or steals checkout credentials | Top-level `permissions: contents: read`, no job permission overrides, no secret expressions, every checkout has `persist-credentials: false`; no `pull_request_target` or `workflow_run`. | Owner sets read-only workflow default; do not opt into fork write tokens/secrets. Negative token-write canary must return 403. |
| Action tag changes after review | All `uses:` actions pinned to full 40-character commit SHAs, including GitHub actions; policy tests reject mutable references. | Review SHA updates and snapshot/toolchain upgrades. Lockfiles remain enforced; pins do not certify dependencies as harmless. |
| One job persists into the next or escapes through host privileges | Self-hosted job preflight rejects root, passwordless sudo and standard Docker/Podman sockets. No shared disk cache configured. | Fresh VM and runner registration for exactly one job; non-root user, no sudo rights/capabilities/privileged sockets or host mounts. Controller deletes VMs on all outcomes and reconciles orphans. Preflight is diagnostic, not a sandbox. |
| Runner steals cloud, controller or release credentials | CI references no secrets; release/notarization/signing workflows are not moved here. | Long-lived GitHub/cloud tokens only on a separate controller, never in runner images, environment, user-data or checkout. No deploy keys or operator SSH keys on runners. |
| Cache poisoning crosses a trust boundary | Job + PR-number/main/run namespace + OS + architecture + lockfile keys; restore prefixes stay in that namespace. No implicit pnpm cache. PRs do not restore main caches or other PR caches through this workflow. | No shared volumes or writable object-store caches. Native GitHub merge-ref cache write scope must remain in use. All cached content must be public and credential-free. |
| Runner reaches production, metadata or controller | No network/cloud setup performed by this PR. | CI-only cloud project, no private network, no inbound firewall rules, external egress controls denying private/link-local/metadata/controller destinations. Allow only required build/GitHub traffic. |
| Resource abuse, failed deletion or controller compromise | Default remains GitHub-hosted. | Controller concurrency/cost/lifetime caps, bounded deletion grace, independent cleanup reconciliation, patched separate controller with minimal credentials and private operational logs. |
| Security policy regresses in a later edit | `test_workflow_security.py` exercises violations and is run by required `frontend`. `check` gates every job. | Normal branch protection and review of workflow/runner changes. PR-authored policy tests cannot authorize access to private runners. |

GitHub cautions against self-hosted runners in public repositories because PR
code can compromise them. Read-only tokens and ephemeral VMs reduce impact;
they do not make arbitrary code safe. See [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

### The external admission boundary is mandatory

Do **not** register repository-level runners under the original Free-plan
proposal. Before any self-hosted CI use, the owner must have a GitHub plan and
organization policy supporting a runner group restricted to:

- selected repository: `terminalx-ai/terminalx` only;
- selected workflow: `terminalx-ai/terminalx/.github/workflows/ci.yml@refs/heads/main`;
- no other workflows or refs, and no unrestricted/default-group runner carrying
  the same routing label.

This uses GitHub's [selected-workflow runner-group restriction](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access).
It is enforced by GitHub outside fork-controlled YAML. Verify the group's
`restricted_to_workflows`, `selected_workflows`, selected repositories and
public-repository access using the [runner-group API](https://docs.github.com/en/rest/actions/self-hosted-runner-groups)
and the owner UI before registration. A label, controller webhook filter,
ephemeral registration, or external-contributor approval is **not** a substitute.
If the owner cannot establish this boundary, **leave `CI_LINUX_RUNNER` unset and
keep GitHub-hosted CI**. An alternative isolation/admission design needs its own
review and evidence before use.

This deliberately means Hetzner does not accelerate PRs in this rollout. It can
accelerate main/nightly runs only. The PR benefit comes from the parallel Linux
split. Extending private compute to PRs is a separate security design, not a
variable change. Protect main and its workflow edits through the existing review
gates; this change does not modify those gates.

### Cache scope and limits

Caches use `ci-v3-<job>-<scope>-<os>-<arch>-<lock>-<sha>`, with restore prefixes
ending after the lock hash. Scope is `pr-<number>`, `main`, or `run-<id>` for a
manual non-main run. Successful jobs may save only to their selected key; a PR
cannot overwrite a main cache under GitHub's native cache write rules. There
is no cross-scope fallback and no shared local Cargo/pnpm directory between VMs.

Namespaces are not a confidentiality boundary: a malicious fork can request
other readable caches by modifying its YAML. GitHub permits PRs to read base
branch caches, so cached files must never contain secrets or private data.
See [GitHub cache restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
Purge legacy caches before private-pool activation. If object-store/sccache is
added later, main-only write authority must be enforced outside the guest and
PR-authored workflow, with no long-lived storage credential on a runner.

Read-only inspection on 2026-11-11 found `CI_LINUX_RUNNER` absent, default
workflow permissions already `read`, Actions PR approval disabled, and fork
approval still `first_time_contributors`. The last setting does not meet the
activation prerequisite. No setting was changed.

## Owner procedure: from no runners to a measured pilot

These are **owner-only actions**, not actions performed by this PR. Infrastructure
implementation and its pinned controller/image configuration still need a
separate change. Do not treat this checklist as a deployed or certified setup.

1. In repository **Settings → Actions → General**, choose **Require approval for
   all external contributors** for fork workflows and **Read repository contents
   and packages permissions** for default workflow permissions. Leave Actions
   PR creation/approval disabled and fork secret/write-token options disabled.
   Keep `CI_LINUX_RUNNER` absent. Confirm `check`, `frontend`, `webkit-layout`
   remain required; do not relax the ruleset to land this PR.
2. Establish and verify the selected-repository/selected-workflow group above.
   Confirm an approved fork with edited `runs-on` cannot use it, including while
   an eligible main job has caused the controller to create capacity. Confirm a
   different workflow, a manual non-main ref, and an internal PR are denied too.
   This is a **hard stop before registration** if the needed GitHub capability
   is unavailable. Use a disposable locked-down canary for the live deny tests
   only after the group configuration has been independently verified.
3. Create a dedicated Hetzner Cloud project used only for CI and a small separate
   controller VM. Supply its Hetzner token and a dedicated GitHub machine account
   (access to this repository only; minimal runner-administration authority for
   the restricted group). Enter secrets on that controller, never in chat or Git.
   If the chosen controller's classic-token permissions require broader access,
   stop and choose an acceptable design; do not silently widen account scope.
4. Select and pin a controller release. TestFlows is only a candidate, not an
   approved configuration. Its repository-only setup must not replace the group
   restriction. Reject workflow-supplied image/size/setup/network options, warm
   pools, recycling and persistent cache volumes. Admission must verify the
   repository, event, workflow path and main ref against GitHub. Set concurrency,
   cost, job timeout and deletion-grace limits outside the guest. Document actual
   controller service/config paths in the separate implementation before use.
5. Build a clean versioned image with Rust/Clippy from `rust-toolchain.toml`, Node
   from `.nvmrc`, pnpm from `package.json`, Git supporting
   `merge-tree --write-tree --merge-base`, and `ci.yml`'s GTK/WebKit/audio/compiler
   packages and zsh. Prepare an unprivileged runner user and writable tool cache
   local to this VM only. Bootstrap as root before accepting jobs; run jobs as
   that user with no sudo, capabilities, cloud identity or host sockets. The
   image has no registration, checkout, caches, tokens or SSH keys. Never create
   a snapshot from a used job VM. Start measurement with 16 dedicated vCPUs;
   choose the final type from data, not the projected speedup.
6. Attach a Cloud Firewall at creation with **no inbound rules**, for both IP
   families. No private network or path to other infrastructure. Bootstrap via
   outbound authenticated connections; do not temporarily expose SSH. Enforce
   egress outside the guest: approved DNS resolver, HTTPS to GitHub/API/Actions
   artifact/cache endpoints and required Rust/npm/pnpm/package registries; only
   necessary time synchronization. Derive and version the allowlist from the
   [GitHub communication requirements](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#communication-requirements)
   and observed builds. Deny private/link-local/metadata destinations and all
   controller administration/token endpoints, including redirects/DNS rebinding.
   Where a public bootstrap endpoint is necessary, permit only an authenticated
   one-time delivery operation; it must never expose controller/cloud tokens.
7. The controller creates one VM for one job, uses JIT configuration or an
   ephemeral registration in the restricted group, and never reuses its disk or
   identity. Mint registration material just in time; [registration tokens
   expire after one hour](https://docs.github.com/en/rest/actions/self-hosted-runners).
   Deliver it over an authenticated encrypted bootstrap channel, not command
   logs/user-data/snapshots. Remove bootstrap material before running a job.
   The per-runner identity is necessarily present while connected; scope it to
   this registration and destroy it with the VM. The long-lived API tokens stay
   on the controller. Never log tokens, even on error paths.
8. Have the external controller delete the VM and registration after success,
   failure, cancellation, timeout or guest crash; enforce a finite lifetime and
   reconcile orphaned VMs after controller restart. A guest shutdown hook is
   insufficient. Keep private evidence of VM identities, deadlines and deletion.
9. Complete every acceptance test below. Only then may the owner set the single
   string **Settings → Secrets and variables → Actions → Variables →
   `CI_LINUX_RUNNER`** to the restricted group's unique runner label. No JSON
   array is expected. Begin with main's Linux Rust job, not PR code. Verify the
   actual runner selected and collect ten comparable successful runs.

### Required acceptance evidence (still pending)

- External fork workflow waits for maintainer approval; after approval it uses
  GitHub-hosted compute. A fork that edits YAML to request the private label
  receives no private runner, even concurrently with a main job. Repeat for an
  internal PR, alternate workflow and non-main manual run.
- A runner's user has no root/sudo/capability/host-socket access. No long-lived
  secret appears on disk, in process environments, image metadata or cloud
  user-data. Inspect privately; never paste captured secrets into evidence.
- Job A writes a unique `$HOME` canary. A later job B has no such file and uses
  a different fresh VM. `hcloud server list` shows no runner beyond the declared
  grace period after success, failure, cancellation, timeout and controller restart.
- An external scan finds no inbound ports; egress tests cannot reach private
  networks, metadata or controller administration. Required builds still work.
- An isolated test attempts to create a unique Git ref with the job's
  `GITHUB_TOKEN` and gets HTTP 403. Any successful write fails acceptance and
  requires owner cleanup. Do not add this write attempt to ordinary CI.
- Trusted/main and untrusted/PR runs restore only their own configured cache
  namespace. Legacy caches are removed; no writable disk is shared.
- Removing/emptying the variable sends subsequent main Linux jobs to
  `ubuntu-latest`; all PRs use GitHub-hosted runners with either variable value.
- Ten successful runs per phase, plus median/p90 per job and whole run, are
  recorded. Keep main and PR samples separate; a main-only private-pool result
  must not be presented as a PR speedup.

## Rotate credentials or turn the pool off

Owner: delete or empty `CI_LINUX_RUNNER` in Actions variables first. New main jobs
fall back to Ubuntu without a code change. Already queued/running jobs retain
selection: cancel and rerun them if immediate fallback is needed. Stop controller
provisioning, drain/cancel jobs, delete all runner VMs and remove registrations.
Removing a variable does not remove runner access; revoke the group access too
for an incident. Retain the existing GitHub-hosted jobs and required statuses.

On the controller only, rotate the machine account's classic token in its
owner-only credential store, restart the controller service, verify restricted
registration/deletion with a disposable canary, then revoke the old token.
Repeat separately for the CI project's Hetzner token with create/delete checks.
For suspected compromise, revoke first and accept the interruption. Rebuild any
suspect controller/image; do not clone used runner disks. Record rotation date
and token identifier privately, never values. Re-enable only after the owner has
verified all admission/isolation controls again. Exact service/store paths and
pinned provider commands belong in the separate implementation; none is claimed
provisioned or tested by this preparatory PR.
