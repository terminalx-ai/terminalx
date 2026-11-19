# CI runners (PRO-267)

This is the preparatory Linux split, integrated with the three required statuses
introduced by #882: **`check`, `frontend`, `webkit-layout`**. It does not provision
or activate Hetzner. No repository settings, rulesets or variables are changed.
The latency target and both ten-run comparisons remain unproven; see
[measurements](CI-RUNNERS-MEASUREMENTS.md).

## What runs where

| Job | Runner | Checks |
| --- | --- | --- |
| `frontend` | GitHub-hosted Ubuntu | Desktop/mobile TypeScript, frontend build, portable icon tests, CI policy/selector/measurement tests. |
| `vitest` | GitHub-hosted Ubuntu, four at once | The full Vitest run in four parts (`--shard=N/4`): every test file is in exactly one. |
| `webkit-layout` | GitHub-hosted Ubuntu | All WebKit layout checks, permission-details among them, after the frontend build, in Playwright's WebKit build. `scripts/webkit/run-all.mjs` runs several at once. |
| `linux-rust` | GitHub-hosted Ubuntu on **every PR** | `cargo clippy --locked --all-targets -- -D warnings`; GTK/WebKit/audio dependencies installed. Main push/nightly/manual runs alone may use the owner-approved `CI_LINUX_RUNNER` label; unset/empty falls back to Ubuntu. |
| `linux-rust-tests` | GitHub-hosted Ubuntu, three at once, on **every PR** | Full default-feature `cargo test --locked` in three exact parts (below). |
| `macos-native` | GitHub-hosted macOS, **when selected** | Full Apple/source/packaged/compiled icon checks, Swift tests, helper build, macOS Clippy, and the full macOS Rust suite. |
| `machine-compat` | GitHub-hosted macOS, **when selected** | This build against the previous two released runtimes (PRO-354). |
| `desktop-platforms` | GitHub-hosted Ubuntu | Off-macOS helper build, local UI control, Linux renderer/launcher tests. The platform build, computer contract and input safety steps run off Linux only: on Linux they are `linux-rust`'s Clippy and full suite and `frontend`'s Vitest run. Disabled Windows steps retained. |
| `headless-serve` | GitHub-hosted Ubuntu | Existing headless build, dependency exclusions, Clippy, integration tests and self-test. |
| `legacy-runtime-probe` | GitHub-hosted Ubuntu | Existing legacy AppImage diagnostics. Its tests set the operating system themselves, so one runner covers Linux and macOS. |
| `macos-rust-changes` / `check` | GitHub-hosted Ubuntu | Coverage selector / aggregate status requiring **every** other job to succeed. Failure, cancellation or a skipped dependency fails `check`; the two macOS jobs alone may be skipped, and only when the selector succeeded and did not select them. |

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

The merged main also exposed a Linux loader bug in the read-only approval
wrapper: assigning an empty `LD_TRACE_LOADED_OBJECTS` made glibc print loader
information and return success before `env` could run the directory guard or
command. The wrapper no longer reads or tests that variable: even a presence
expansion can evaluate a startup-defined Bash nameref's array subscript.
Instead, the existing loader-masked `/usr/bin/env -i` launcher first starts a
clean `/bin/sh` that only exits 9, discarding the launcher's stdout. A tracing
glibc loader exits 0 without starting that shell. Before the real launch, the
wrapper saves stdin, closes descriptor 0, opens descriptor 9 on `/dev/null`, and
tries to duplicate the probe's exit status as a descriptor. Status 9 succeeds;
status 0 fails before command dispatch. It restores stdin and closes the
working descriptors before execution. The only outer-shell expansion is `$?`,
a shell-owned special parameter that cannot be a startup-defined nameref.
All named values passed to the clean shell are literal, quoted arguments.

Unexported loader flags never reach the launcher; Darwin does not interpret the
glibc flag. In those cases `env -i` removes the flag and the real command and
directory guard execute. Exported flags on glibc, including empty and readonly
values, fail closed without leaking loader output. Tests require actual command
output or status 125 for the wrong directory whenever execution is allowed.
They also reproduce the nameref write with both unset and populated targets,
then require no marker in either directory with the approved wrapper. Linux
requires nameref-capable Bash; macOS's system Bash 3.2 lacks that feature.

Both probe and guarded execution occupy the conditional side of `&&`, which
suppresses inherited error traps (including zsh's function-style `TRAPZERR`)
and preserves failure status. Only on success, the same loader-masked
`/usr/bin/env -i` launcher runs without a payload to return zero silently.
There is no cleanup/status builtin, control keyword or ordinary assignment
that would resolve a startup function, alias or nameref. Tests retain poisoned
functions, aliases, null commands and error traps, and check normal output,
stdin and command/directory failure statuses. An outer subshell around the
whole `&&` list would re-expose failure to error hooks.
See [zsh trap semantics](https://zsh.sourceforge.io/Doc/Release/Functions.html).
CI installs/requires ripgrep and zsh so the security fixtures cannot take their
missing-tool fallback. The [glibc implementation treats the flag as enabled by
presence](https://sourceware.org/pipermail/glibc-cvs/2022q1/076642.html).
No test is suppressed to accommodate this behavior.

A cache-reconciliation fixture also assumed that immediate same-size writes
always receive different filesystem timestamps. A forced same-timestamp replay
reproduced its intermittent Linux failure. The fixture now explicitly advances
the rewritten file's mtime; the production cache and all cost/retention
assertions are unchanged.

## macOS runner time

GitHub runs only a few macOS jobs at once for the whole account, and a job
that needs one waits behind all the others. Measured 16 to 19 November 2026,
CI used 6,000 to 6,500 macOS minutes a day, close to all there is, and a macOS
job waited a median of 13 to 18 hours: a run that takes 21 minutes on Linux
reported a day later. `macos-native` was 70% of those minutes and
`webkit-layout` 23%. The hosted macOS runner also has 7 GB of memory and one
compiler on this crate needs more, so a build that takes under four minutes on
Linux takes 20 to 33 there.

So only two jobs take a macOS runner, and only when they are selected:

- `macos-native`: pushes to `main`, nightly, manual runs, and pull requests
  selected by `infra/ci-runners/macos-rust.py` (next section). An unselected
  pull request no longer runs macOS Clippy, the Swift tests or the Apple icon
  checks before merge: they run on `main` after it.
- `machine-compat`: the same events, and pull requests that touch the machines
  (`scripts/machine-e2e/relevant.py`, the list `machines-e2e` uses).

`macos-rust-changes` decides both and `check` accepts a skipped macOS job on
its word alone. On `main`, each of the two jobs keeps the run in progress and
the newest waiting commit: an older commit still waiting when a newer one
arrives is cancelled and its `check` fails. The newest commit of a burst of
merges is always tested.

The WebKit layout checks run on Linux, in the WebKit build Playwright ships
for every system. The legacy runtime diagnostic's macOS leg is gone: its
tests patch `platform.system` to Linux and to Darwin themselves.

## The suites in parts

Linux runners start at once, so the two long suites run in parts on several:

- **Vitest**, four parts: `pnpm vitest run --shard=N/4`. Vitest deals each test
  file to exactly one part.
- **The Linux Rust suite**, three parts of the library's tests, by name. A
  filter matches every test whose name contains it:
  `session::watch_tests::prompts`; the other names containing `session::` or
  `remote::`; and every name containing neither. The last part also runs the
  other test binaries (`--bins --test '*'`) and the doc tests. Together they
  are `cargo test --locked`. A renamed module moves tests between runners; it
  cannot leave one out.

`infra/ci-runners/test_workflow_security.py` holds both to these shapes.

## Cargo caches

A cache holds the built dependencies. Its key is the job, the trust scope, the
platform, `Cargo.lock` and the compiler version, not the commit: this crate
is rebuilt on every checkout whatever is restored. A job saves a cache only
when it restored none, so `main` keeps one per job and a pull request writes
its own only when it changes the lock file. A job whose build was whole saves
even when a test then failed. Keyed by commit, every run saved a new cache,
the repository's 10 GB limit evicted them within hours, and the macOS jobs,
which failed and so never saved, built every dependency on every run.

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
crate roots, workflow and helper scripts also select the suite. Approval wrapper
code/tests (`harness/read_only*`) always select it too, because shell and loader
semantics differ even without an Apple cfg. Deletions and
renames are checked at their old paths too. Adding a new macOS cfg automatically
adds its file to coverage; no hand-maintained file list can silently go stale.

Print the exact current list:

```sh
python3 infra/ci-runners/macos-rust.py --base HEAD --list
python3 -m unittest discover -s infra/ci-runners -p 'test_*.py'
```

**Coverage no longer provided on every PR:** frontend-only, documentation-only,
and shared Rust changes outside those paths no longer take a macOS runner
before merge: no macOS Rust tests, Clippy, Swift tests or Apple icon checks.
They still run the full Linux Rust suite, Linux Clippy and the WebKit checks. Platform differences in otherwise shared Rust code
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
| Cache poisoning crosses a trust boundary | Job + PR-number/main/run namespace + OS + architecture + lockfile write keys. Restores try the run's own namespace, then matching public main artifacts. No other-PR or broad fallback and no implicit pnpm cache. | No shared volumes or writable object-store caches. Native GitHub merge-ref cache write scope must remain in use. All cached content must be public and credential-free. |
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
is no shared local Cargo/pnpm directory between VMs. All four Cargo jobs first
restore their own namespace, then fall back to `main` with the same job, OS,
architecture and lockfile hash. This lets a fresh PR reuse warm main builds.
Saving always uses the original scoped primary key, never the matched fallback
key. GitHub stores PR writes under the PR merge ref: main and other PRs cannot
read them, even if a fork changes the YAML to name its key `main`. Main runs
restore only main-scoped keys. Cache reuse is one-way across the trust boundary;
its elapsed-time benefit remains unmeasured. The new job namespaces need a
successful main run to populate them after merge; this fallback does not restore
legacy unscoped caches.

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
   packages, zsh and ripgrep. Prepare an unprivileged runner user and writable tool cache
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
- A fresh PR can restore a matching main Cargo cache, saves only under its own
  merge ref/key, and cannot overwrite main or supply caches to main/other PRs.
  Legacy caches are removed; no writable disk is shared.
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
