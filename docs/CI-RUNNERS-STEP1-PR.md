# Step 1 PR publication text

Use the title below and copy the body between the marked boundaries into
TerminalX's manual PR form. Base: `main`. Select **Draft**. The publication
steps are in [the measurement record](CI-RUNNERS-MEASUREMENTS.md#supported-manual-publication-route-2026-11-07).

## Title

Split portable CI checks from macOS

## Body — copy from here

**What this changes, and why**

The single macOS `check` job dominates PR latency. This change runs portable
frontend and Rust checks on Linux in parallel with the Apple-specific checks,
while retaining `check` as the aggregate required status. It is **Step 1 only**
of [PRO-267](https://linear.app/procyonlabs/issue/PRO-267/run-cis-linux-tests-on-our-own-hetzner-runners-securely).
PRO-267 remains open for the CI measurements and separate Hetzner rollout.

| Job | Checks and reason |
| --- | --- |
| `linux-frontend` | Desktop/mobile TypeScript, Vitest, frontend build, portable icon checks and CI helper tests; none require macOS. |
| `linux-rust` | Linux Clippy and the full default-feature Rust suite, with GTK/WebKit/audio build dependencies. |
| `macos` | WebKit layout checks, Swift tests, computer-use helper build, Apple icon checks and macOS Clippy. |
| `macos-rust` | Full Rust suite on every main push, nightly, manual dispatch and PRs selected for macOS coverage. |
| Existing platform/headless/probe jobs | Retained; their previous checks still run. |

Both Linux jobs use `${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}`. The variable
is not activated by this PR. CI has top-level read-only permissions, no secrets,
and checkouts do not persist credentials. Cargo caches are separated by job
and architecture and saved only on main pushes.

Linux validation exposed GNU/BSD `stat` and case-folding fixture assumptions,
a session-watcher lifetime leak, and PTY input waits that could renew an elapsed
deadline. Those are fixed with regression coverage. PTY fixtures synchronize on
readiness/queued input before checking behavior. macOS-only production helpers
are gated while portable audio/transcription tests remain enabled. No Rust test
is removed, newly ignored or newly restricted to macOS.

**macOS coverage tradeoff**

The selector derives paths from both base and head using macOS/Apple cfgs,
macOS-named Rust files, companion modules and `native/`, plus build/toolchain,
manifest and workflow dependencies. Frontend-only, documentation-only and
shared Rust changes outside those paths no longer run Rust tests on macOS
before merge. They retain the full Linux suite and the macOS Clippy, Swift,
WebKit and icon checks. Platform differences outside the selected paths can
be caught by main/nightly macOS tests; manual dispatch is available when needed.

**Checks** — local validation on 2026-11-06:

- [x] `pnpm exec tsc --noEmit`, plus mobile type checking, on macOS and Linux.
- [x] `pnpm vitest run`: 4,129 tests in 339 files on each platform.
- [x] `cargo clippy --locked --all-targets -- -D warnings` on macOS and Linux.
- [x] Full `cargo test --locked`: Linux 2,821 unit + 8 integration tests;
      macOS 2,871 unit + 8 integration tests. Existing ignored tests unchanged.
- [x] Frontend build, portable/Apple icon checks, Swift helper tests/build,
      all WebKit layout checks including permission details, actionlint and
      11 CI-helper regression tests.
- [x] Headless server Clippy and all 43 relevant integration tests on macOS.

Linux validation used TerminalX's Debian 12 ARM64 VM with bounded concurrency
for its 4 GB memory limit. The final macOS full suite used one test thread while
other builds were active; earlier timing-sensitive failures and the final pass
are recorded in `docs/CI-RUNNERS-MEASUREMENTS.md`. Assertions and existing test
deadlines were retained. These results do not replace GitHub-hosted AMD64 CI.

**Measurements — incomplete after sample**

The frozen baseline contains ten successful first-attempt PR runs collected on
2026-11-06. p90 is nearest rank; whole-run time includes queueing.

| Phase | Qualifying runs | Whole-run median | Whole-run p90 |
| --- | ---: | ---: | ---: |
| Before split | 10 | 59.0 min | 74.1 min |
| Step 1 split | 0/10 at preparation | Pending | Pending |
| Hetzner | 0/10 | Pending deployment and activation | Pending |

| Baseline job | Runs | Median | p90 |
| --- | ---: | ---: | ---: |
| `check` | 10 | 58.9 min | 63.5 min |
| `desktop-platforms (ubuntu-latest)` | 10 | 7.4 min | 9.0 min |
| `headless-serve` | 10 | 3.1 min | 3.4 min |
| `legacy-runtime-probe (macos-latest)` | 10 | 0.2 min | 0.2 min |
| `legacy-runtime-probe (ubuntu-latest)` | 10 | 0.1 min | 0.1 min |

Sample links, sanitized input and the collection method are in
`docs/CI-RUNNERS-MEASUREMENTS.md` and `infra/ci-runners/baseline.json`. Update the
after sample with actual split-workflow runs. Do not mix old-workflow runs into
the sample, count rerun attempts as new observations, or claim the 20-minute
target from local timings. The ten-run Step 1 acceptance criterion is open.

**Remaining work**

- [ ] Publish this draft, obtain independent review and observe hosted CI;
      preserve existing review, security and merge gates.
- [ ] Record at least ten successful first-attempt Step 1 CI runs with median
      and p90 per job, distinguishing PRs that select macOS Rust tests.
- [ ] In a separate Step 2 change, implement and validate ephemeral Hetzner
      runners and the controller/snapshot/security controls in `docs/CI-RUNNERS.md`.
- [ ] A person supplies the CI-only Hetzner project and dedicated GitHub machine
      account. Tokens are entered directly on the controller, never in chat or
      committed files.
- [ ] A person approves any repository setting change, including approval for
      all external fork contributors. Read-only default permissions were
      already observed; recheck before activation.
- [ ] After security acceptance, a person decides whether to set
      `CI_LINUX_RUNNER`. Then collect ten Hetzner runs and compare them with
      Step 1. No provisioning or activation is part of this PR.

**Also**

- [x] No unfinished infrastructure implementation or mock production path is added.
- [x] No visual UI changes; screenshots are not applicable.
- [x] Added fixtures and committed measurement data carry no account credentials,
      private addresses, hostnames or keys.

## End of copyable body
