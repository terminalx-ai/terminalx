# CI runners (PRO-267)

This is the preparatory Linux split, integrated with the three required statuses
introduced by #882: **`check`, `frontend`, `webkit-layout`**. It does not provision
or activate Hetzner. No repository settings, rulesets or variables are changed.
The latency target and both ten-run comparisons remain unproven; see
[measurements](CI-RUNNERS-MEASUREMENTS.md).

## Instabox was tried and dropped (21 November 2026)

For a few hours on 21 November 2026 every Linux job ran on Instabox machines
(`runs-on: instabox-medium`, 4 vCPU and 8 GiB; pull requests #1448 and #1458).
It was taken back the same day, for cost and because it was not faster:

- GitHub's runners cost nothing for a public repository. Instabox bills compute
  by the second ($0.004 a vCPU-hour and $0.00225 a GiB-hour when this was
  written); at that week's volume, about 1,100 CI runs of some 79
  machine-minutes each, that came to roughly $200 a month.
- Jobs started within 10 seconds of being queued, against a median of 15
  seconds and a worst case of 9 minutes on GitHub's runners, and the four
  Vitest parts took about 2 minutes against 3. The Rust jobs were slower on
  `instabox-medium`: the longest, `linux-rust-tests (rest)`, took 17.4 and 21.1
  minutes in two runs against a hosted median of 14.5, and Clippy 6.1 and 6.2
  against 4.1.
- On `instabox-large`, at twice the price a minute, Clippy took 4.8 minutes in
  the one run made (#1458): still not faster than GitHub's runner.

Instabox's larger sizes are `instabox-large` (8 vCPU, 16 GiB), `instabox-xlarge`
(16, 32) and `instabox-2xlarge` (32, 64), on its paid plans. Its machines are
Ubuntu 24.04 with Docker and passwordless `sudo`, one fresh machine a job. The
`instabox-cloud` GitHub App is installed on the organisation, not in this
repository: while it is, a workflow that names an Instabox label gets a
machine, a pull request's edited workflow included.

## What runs where

| Job | Runner | Runs | Checks |
| --- | --- | --- | --- |
| `macos-rust-changes` | Ubuntu | always | The selector: what this change needs (next section). |
| `frontend` | Ubuntu | always | Portable icon tests and the CI policy, selector and measurement tests, whatever changed. `tsc` and `vite build` when the frontend changed. The one place `tsc` runs. |
| `vitest` | Ubuntu, four at once | frontend | The full Vitest run in four parts (`--shard=N/4`): every test file is in exactly one. |
| `webkit-layout-linux` | Ubuntu, four at once | frontend | The WebKit layout checks after `vite build`, in four parts (`run-all.mjs --shard N/4`): every check is in exactly one part, and on Linux a part leaves out the checks in run-all's `macOnly` list. The machine-screen scripts are among them. |
| `webkit-layout` | Ubuntu | always | The required WebKit status. Passes only when every Linux part succeeded, or all were skipped because the selector succeeded and answered "false" for the frontend; a part that failed or was cancelled fails it. Keeps the parts' machine screens as one artifact, `machine-screens`, and fails when there are none. |
| `webkit-mac-only` | **macOS** | mac-webkit | The checks in `macOnly` alone (`run-all.mjs --only mac-only`), each listed with what Linux lacks. |
| `phone-app` | Ubuntu | phone | The phone app's `tsc` and its Vitest run (`pnpm --dir mobile test`). |
| `linux-rust` | Ubuntu on **every PR** | Rust | `cargo clippy --locked --all-targets -- -D warnings`; GTK/WebKit/audio dependencies installed. Main push/nightly/manual runs alone may use the owner-approved `CI_LINUX_RUNNER` label; unset/empty falls back to Ubuntu. |
| `linux-rust-tests` | Ubuntu, five at once | Rust | The library's tests under cargo-nextest in four parts, and a fifth with the other test binaries, the doc tests and the local owner path without desktop features (below). Part 1 also runs a secret through a real system keyring (GNOME Keyring on a session bus of its own). |
| `headless-serve` | Ubuntu | Rust | Headless build, dependency exclusions, Clippy, the named integration tests and the self-tests. |
| `serve-tests` | Ubuntu | Rust | Every other test binary under `src-tauri/serve/tests`, under cargo-nextest (below). |
| `macos-native` | **macOS** | macOS | Icon checks, Swift tests, helper build, one build of the library's tests. On a pull request the Apple-only and system-dependent tests; on main, nightly and manual runs macOS Clippy and the full suite. |
| `machine-compat` | **macOS** | machines | This build against the previous two released runtimes (PRO-354). |
| `machines-e2e` | Ubuntu | always; decides in a step | Two machines end to end (PRO-358). |
| `desktop-platforms` | Ubuntu and Windows | always | Off-macOS helper build, Linux renderer and launcher tests. No Rust on Linux: that is `linux-rust` and `linux-rust-tests`. On Windows: the build, the library's tests under cargo-nextest without the desktop feature, the frontend's tests, and the Windows-only pipe, process and renderer tests, with `core.autocrlf` off. |
| `legacy-runtime-probe` | Ubuntu | always | Legacy AppImage diagnostics. Its tests set the operating system themselves, so one runner covers Linux and macOS. |
| `check` | Ubuntu | always | The aggregate. Every other job but `macos-native`, `machine-compat`, `webkit-mac-only` and `check-macos` must succeed. A job in the "Runs" column's frontend, phone, Rust or machines rows may be skipped instead, and only when the selector succeeded and answered "false" for it. |
| `check-macos` | Ubuntu | main, nightly, manual | Needs `check`, `macos-native`, `machine-compat` and `webkit-mac-only`; fails unless all four succeeded. Not a required status: a pull request is not held to the macOS Rust suite, the build against the released runtimes or the mac-only WebKit checks ("macOS Rust coverage"). |

All runners are GitHub-hosted. The WebKit checks run in `ci.yml` alone: the
trial workflow `webkit-linux.yml` that first ran them on Linux is gone.
`test_workflow_security.py` runs `run-all.mjs --list` for each Linux part
(as on Linux) and for `webkit-mac-only`, and fails when a check the suite
lists runs in neither or in both.

## What a pull request runs

`infra/ci-runners/macos-rust.py` reads the paths a pull request changes, from
both sides of its merge base, and answers five questions. `check` accepts a
skipped job only on its answer. Pushes to `main`, nightly and manual runs
answer "true" to all five.

| Answer | True when the change touches | Jobs |
| --- | --- | --- |
| `rust` | `src-tauri/`, `native/`, the toolchain, and each path outside them that a Rust test or build script reads (`packages/portable/src/`, the shared fixtures under `src/lib/`, `scripts/remote-runtime/`, `skill-guides/`, `schemas/` and others) | `linux-rust`, `linux-rust-tests`, `headless-serve`, `serve-tests` |
| `frontend` | `src/`, `packages/`, `scripts/`, `mobile/src/` (a desktop test imports from it, and the root Vitest run includes its tests), the package and Vite files, and each Rust or other file a frontend test reads by path (`src-tauri/src/remote/protocol.rs`, `src-tauri/src/fixtures/` and others) | `tsc` and the build in `frontend`, `vitest`, `webkit-layout-linux` |
| `mac-webkit` | a mac-only check's script, `run-all.mjs`, every file in `scripts/webkit/` one of them names by a `./` path (`harness.mjs` and the stubs it reads), the app's shell and styles (`MAC_WEBKIT_SHELL`), and what each mac-only check renders (`MAC_WEBKIT_RENDERS`) | `webkit-mac-only` |
| `phone` | `mobile/`, `packages/`, the package files, the desktop types the phone app imports | `phone-app` |
| `required` | the macOS rules ("macOS Rust coverage" below) | `macos-native` |

A change to `.github/workflows/ci.yml` or `infra/ci-runners/` answers "true" to
all five. A documentation-only pull request runs `macos-rust-changes`,
`frontend` (the policy tests and the icon check), `machines-e2e` (which decides
in a step), `desktop-platforms`, `legacy-runtime-probe` and `check`.

The lists are written by hand and tests hold them to the source:
`test_macos_rust.py` fails when a Rust source names a tracked path outside
`src-tauri` that `rust` does not cover, when a frontend test names a tracked
path that `frontend` does not cover, and when an Apple-only module or a file
with an Apple `cfg` is missing from the macOS rules. A path built at run time
from parts (`root.join("..")` and then a name) is not found by that check;
`schemas/` is such a one and is listed. Of the last 400 commits on `main`, 8
would have run none of the selected jobs, 94 the frontend jobs alone, 44 the
Rust jobs alone, 2 the phone app alone, and 118 the macOS job.

**What a skipped job leaves to `main`:** a pull request that changes no Rust
input runs no Rust job before merge, and one that changes no frontend input
runs no Vitest or WebKit check. One that changes the frontend but none of the
`mac-webkit` paths runs every WebKit check but the mac-only ones ("macOS runner
time" below). A dependency the rules do not name (a test
that reads a file through a path the check cannot see) is first tested on
`main`, where every run is whole.

`check` is the aggregate, so its required status gates Rust and native checks.
The separate required `frontend` and `webkit-layout` names stay unchanged; no
ruleset edit is needed. `webkit-layout` is never skipped: it runs on Linux on
every pull request and reports what its parts did. GitHub reports a job skipped
by its `if` as passing, so `check` is what refuses a skip the selector did not
ask for. No tests are dropped or newly ignored.
Portable source icon tests run on Linux; macOS retains all source and Apple
decoder checks.

What a selected pull request ran on macOS before 23 November 2026 and now
runs there on `main`, nightly and manual runs only (all of it still runs on
Linux on the pull request):

- the library's tests outside the 51 filters (3,982 of 5,871);
- the other test binaries: `--bins` and the three in `src-tauri/tests/`;
- the doc tests.

macOS Clippy still runs on a selected pull request, both invocations. `tsc`
runs in `frontend` alone (it ran four times). The serve crate's test binaries
run for the first time (`serve-tests`). The phone app's tests have a job of
their own (`phone-app`); the root Vitest run already ran the phone's
`.test.ts` files and still does, so those run twice.

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

## Tests that failed now and then

`.github/workflows/repeat-flaky-tests.yml` (PRO-334, PRO-488) runs five tests
that used to fail by timing or shared state, many times in a row on the kind
of runner CI runs each on: the large-tab send cost and the cloud sections'
search 20 times, the far-behind terminal view and the checkpoint undo 20
times, and the Codex capability tests 300 times with every core busy. It runs
only when one of those tests or the workflow changes, and by hand
(`gh workflow run repeat-flaky-tests.yml -f runs=50`). It is not a required
status, and it takes one macOS runner for the search.

The send test no longer holds a time in milliseconds. It measures a send in
units of a reference workload timed beside it in the same run, so the figure
is the same on a laptop and a hosted runner, and a second test fails if a send
made twice the work would still pass. The job prints what each run measured;
set `SEND_COST_LOG` to a file to get the same locally before changing the
budgets in `src/components/session/TabView.send.test.tsx`.

## macOS runner time

GitHub runs only a few macOS jobs at once for the whole account, and a job
that needs one waits behind all the others. Measured 16 to 19 November 2026,
CI used 6,000 to 6,500 macOS minutes a day, close to all there is, and a macOS
job waited a median of 13 to 18 hours: a run that takes 21 minutes on Linux
reported a day later. `macos-native` was 70% of those minutes and
`webkit-layout` 23%. The hosted macOS runner also has 7 GB of memory and one
compiler on this crate needs more, so a build that takes under four minutes on
Linux takes 20 to 33 there.

**The crate is compiled once per kind of build.** `tauri::generate_context!`
writes the app's compressed assets into the crate's `OUT_DIR` while the crate
compiles, and the crate embeds them, so to cargo they are inputs newer than
the build: every cargo command after the first compiled the crate again (11 to
23 minutes on a pull request; on `main` it ran beside the ordinary library
build and the runner swapped, an hour before the first test). Cargo -v names
it: "Dirty raccoon: the file `target/debug/build/raccoon/<hash>/out/<checksum>`
has changed". The build step dates the files in that folder back to 2000, as
tauri-codegen 2.7 does itself (the lock file has 2.6.3), and then fails, with
cargo's reason, unless a second `cargo test --no-run -v` finds every unit
fresh. The folder is the `out_dir` cargo reports for the crate's build script,
not a path searched for: cargo 1.100 keeps every unit's output, the test binary
among them, under `build/raccoon/<hash>/out`, and dating those back makes them
stale.

The commands are one script, `infra/ci-runners/cargo-build-once.sh`, which
takes cargo test's target arguments and sets pipefail itself: `macos-native`
calls it with `--lib`, and the `binaries` part of `linux-rust-tests` with
`--bins --test '*'`. On Linux the same cause compiled the crate a second time
in `binaries`, 190 s of a 10.4 minute job (run 45442275413), between the build
step and the step that runs the tests. The other jobs that build the crate
build it without the desktop features, so `generate_context!` does not run in
them and they do not call the script. The policy tests pin the script's
commands and the call in both jobs.

A cold run of `macos-native` on a manual run (45448416407, 24 November 2026,
every dependency built) took 1 h 52 min: Clippy 15 min 41 s and 15 min 6 s,
the test build 34 min 52 s (the freshness check in it 2 s), the cache save
30 s, and the full suite 41 min 39 s (the ordinary library, the binary and the
integration tests built in 8 min 27 s, the library's 5,886 tests in 1,969 s,
the doc-tests, of which there are none, 17 s). The limit is 150 minutes. Before
this, main's job reached its limit during the doc-tests, after an hour of the
second compile. `main`'s `cargo test --locked` still builds the ordinary
library once, which the binary, the integration tests and the doc-tests need.

No macOS runner is taken on a pull request unless the selector asks for one.
Three jobs take one only when they are selected:

- `macos-native`: pushes to `main`, nightly, manual runs, and pull requests
  selected by `infra/ci-runners/macos-rust.py` ("macOS Rust coverage"). An
  unselected pull request runs no Swift tests or Apple icon checks before
  merge, and no pull request runs macOS Clippy: they run on `main` after it.
- `machine-compat`: the same events, and pull requests that touch the machines
  (`scripts/machine-e2e/relevant.py`, the list `machines-e2e` uses).
- `webkit-mac-only`: the same events, and pull requests the `mac-webkit` answer
  selects (below).

`macos-rust-changes` decides all three, and `check` waits for none of them.
On `main`, `macos-native` and `machine-compat` each keep the run in progress
and the newest waiting commit: an older commit still waiting when a newer one
arrives is cancelled, and its `check-macos` fails. The newest commit of a burst
of merges is always tested.

### The WebKit layout checks

They run on Linux, in four parts (`webkit-layout-linux`), whenever the frontend
changed, and `webkit-layout` is the required status that stands for the parts.
On the hosted three-core macOS runner the whole suite took 30 to 37 minutes,
the longest required job on every frontend pull request; on Linux a part took
4 to 10 minutes (docs/CI-RUNNERS-MEASUREMENTS.md, "Step 2").

They were first tried on Linux on 19 November 2026, in the WebKit build
Playwright ships there: 40 of the 107 failed, against 6 on macOS that day. The
fixtures used macOS paths (`/private/...`), the app showed Ctrl where the
checks read ⌘, and others timed out. Since then the harness gives every page
the macOS platform, the checks press `Meta` for the app's own keys and the
host's key for the engine's editing keys, read layers and layout once they have
settled, and `run-all.mjs` names the checks it leaves out on Linux, each with
what Linux lacks:

| Check | Why Linux cannot make it |
| --- | --- |
| `chat-scrollbar` | measures macOS's overlay scrollbars; WebKit on Linux draws GTK's own |
| `app-resources` | compares rendered pixels and WebGL output for equality, which Linux's software rendering does not reproduce |
| `run-sidebar` | part of it checks the Mac's glass sidebar (backdrop blur), which WebKit on Linux does not composite the same |
| `readable-panels` | measures text contrast through the Mac's glass panels, likewise |
| `pr-conversation` | samples frame times against the Mac runner's frame rate |
| `dictation-hold-to-talk` | holds Right Option (the Mac's key, `hold:AltRight`) and presses Option+Backspace; WebKit on Linux has no editing key while Alt is held, so the edit is never made |

The first five are judgements made on a Mac, not seen failing on Linux
(`WEBKIT_MAC_ONLY_TOO=1` runs them there to find out). `dictation-hold-to-talk`
was split from `dictation-edits` on what a Linux run showed.

`webkit-mac-only` runs those checks alone (`run-all.mjs --only mac-only`), on
every push to `main`, nightly, by hand, and on a pull request whose `mac-webkit`
answer is "true": one that changes a mac-only check's script, `run-all.mjs`,
`harness.mjs` or the stubs it reads, the app's shell and styles (`src/App.tsx`,
`src/main.tsx`, `index.html`, `src/styles/`, `src/lib/glass.ts`, `theme.ts`,
`platform.ts`, `src/components/layout/`, `src/components/ui/`), the build (the
Vite config, the package and lock files, `patches/`, `.nvmrc`), or what one of
the checks renders: `src/components/chat/` (the scrollbars, the panels over the
chat, dictation), `src/components/terminal/` (the resource popover over a live
terminal), `src/components/orchestration/` and `src/components/session/` (the
run sidebar), `src/components/changes/` (the pull request conversation), and
dictation and its shortcut in `src/lib/` (`dictation*.ts`, `shortcuts.ts`,
`shortcutMigration.ts`, `hotkeys.ts`). `macos-rust.py --list` prints the whole
list. The answer fails closed: a check in `macOnly` with no entry of its own in
`MAC_WEBKIT_RENDERS`, or a `run-all.mjs` whose `macOnly` cannot be read, selects
the job on every frontend change, and `test_macos_rust.py` fails when an entry
is missing or names a path that is not in the tree.

**A pull request is not held to the mac-only checks** (the owner's decision,
24 November 2026). On #1530's three runs the job ran 3.0 to 3.4 minutes but
waited 9, 20 and 24 minutes for a macOS runner, and the selector picks it on 23
of the last 60 pull requests merged into `main`. So `check` does not need it:
a selected pull request shows its result for the reviewer, red or green, and
can merge either way. `check-macos` holds every push to `main`, nightly and
manual run to it, as it holds them to `macos-native` ("macOS Rust coverage").

**What is left to `main`:** a break in one of the six mac-only checks is found
on `main` after the merge, by `webkit-mac-only` on the push and `check-macos`.
That is any pull request the answer does not select (a product file outside
those paths that changes what a mac-only check measures, such as a component
the transcript renders from another folder), and a selected one merged with
its `webkit-mac-only` red. Every other WebKit check runs on every frontend pull
request.

#### One rerun, alone, on the Linux parts

A Linux part runs its checks several at once, and a check can fail there only
because the others hold the processor. So, by the owner's decision (#1514,
item 21), each check that failed runs once more after the part's other checks
have ended, by itself, with nothing else running in that part. The part passes
only if every such check passes alone; one that fails again fails the part.
There is exactly one rerun: `reruns` in `run-all.mjs` is 1, `rerunFailed`
refuses any other number, and `infra/ci-runners/test_webkit_reruns.py` fails
when either allows a second (or a retry loop is added around the one). The
macOS job (`--only mac-only`) and runs on a Mac make none.

A check that passed only alone is not hidden. The log prints `<name> FAILED
under load, passed alone` with the output of its first run, the part's last
lines name it again, and the job summary (`GITHUB_STEP_SUMMARY`) lists it under
the heading "FAILED under load, passed alone", with that output. A check on
run-all's `alone` list ran by itself the first time too, so it is said to have
"failed, passed when run again", in the same list. It is a check to fix: it
failed once, on a runner like the next one.

Nobody opens the summary of a green job, so each such check also gets one
warning annotation, titled `WebKit check passed only when run again: <name>,
part <i>/4`. It shows on the run's page and among the pull request's checks,
and the API returns it without the log.

**The list is read with `node scripts/webkit/rerun-tally.mjs`.** For the last
completed CI runs (20 by default, `--runs N` up to 100, `--branch main` for
one branch, `--json` for JSON, `--help` for these), it reads those annotations
for every attempt of every Linux part, through `gh api`, and prints each check
that passed only when run again, with in how many runs and which (link,
branch, commit, part). A run counts once for a check, however many of its
attempts said so. It sends four requests at once and says each run on stderr
as it is read: 20 runs take about 20 seconds, 100 about 70. A request GitHub
answers with a 5xx is sent again, up to four times, backing off.

A rerun takes the check's own time again, after the part. A check that timed
out (ten minutes) and is rerun can take the part past its 25-minute limit; the
part then fails, as it would have without the rerun.

The legacy runtime diagnostic's macOS leg is gone: its tests patch
`platform.system` to Linux and to Darwin themselves.

## The suites in parts

Linux runners start at once, so the two long suites run in parts on several:

- **Vitest**, four parts: `pnpm vitest run --shard=N/4`. Vitest deals each test
  file to exactly one part.
- **The Linux Rust suite**, five parts. Four are the library's tests under
  [cargo-nextest](https://nexte.st), `cargo nextest run --locked --lib
  --profile ci --partition count:N/4`: nextest sorts the tests and deals them
  out in turn, so every test is in exactly one part and the parts are the same
  size (on Linux 1,443 a part: 5,791 tests are listed there and 18 are
  `#[ignore]`d; a Mac lists 5,871 with 26 ignored). The fifth, `binaries`, is the rest of `cargo test
  --locked`: the other test binaries (`--bins --test '*'`) and the doc tests
  under `cargo test`, then `control::issue_tests` built without the desktop
  features. A new or renamed test moves tests between runners; it cannot leave
  one out.

nextest runs each test in a process of its own. About 2,000 of the library's
tests take `store::temp_home()`'s lock, which is one per process: under `cargo
test` they ran one at a time whatever the thread count, and here they do not
wait for each other. A test that relied on sharing a process with another
would fail here; none of the 85 tried did, the ones that run the test binary
again among them.

The `ci` profile is `src-tauri/.config/nextest.toml`: every test runs after a
failure, a failed test fails the run, a test is stopped at ten
minutes, and the JUnit report is kept as the `rust-junit-N` artifact. No
profile leaves a test out, and a policy test fails if one is made to.
The only retries are the file's overrides: one known flaky test each, by its
exact name, run again up to twice, with its ticket on the line above; a policy
test fails on any other override, and on a workflow that sets a `NEXTEST_`
variable or `--retries`. A test that passed on a retry, or left a process
open, is named in the job's summary. Two global retries would have let a new
race that fails half the time pass seven runs in eight.
nextest is installed as one release by version, its archive checked against a
SHA-256 in the workflow before it is opened.

**The serve tests** (`serve-tests`) run under the same `ci` profile: `cargo
nextest run --locked --profile ci --bins` with a `--test` for every file under
`src-tauri/serve/tests` but the four other jobs run (`machine_compat`,
`machines_e2e`, `machine_routes`, `local_issue_start`). Under `cargo test` the
binaries ran one after another, 433 s in run 45442275413, 186 s of it
`scheduled_run`; nextest runs them side by side, so the slowest test is the
floor. The job installs the same nextest release, checked the same way, keeps
its JUnit report as `serve-junit` and names flaky and leaky tests in its
summary. `local_supervisor` is built without libtest's harness (`harness =
false`) and cannot answer nextest's `--list`, so it runs under `cargo test` in
a step of its own; a policy test takes the binaries without a harness from
`src-tauri/serve/Cargo.toml` and requires that step for each.

With every test in a process of its own, a reservation one process keeps is no
longer one: `free_port()` (`tests/common/machine.rs`), which hands a test a
port no other test got, takes it by creating
`<temp dir>/terminalx-test-ports/<port>` exclusively with its process id, and
takes over a file whose process is gone.

The Rust jobs on Linux do not install or build the frontend. `tauri-build`
needs the folder the frontend builds into, so a step writes a one-line
`dist/index.html`; no Rust test reads what is in it.

`infra/ci-runners/test_workflow_security.py` holds the suites to these shapes.

## Cargo caches

A cache holds the built dependencies and nothing of this crate: before a job
saves, `cargo clean -p raccoon -p terminalx-serve` removes the crate's own
output, which is rebuilt on every checkout whatever is restored. Its key is
the job, the trust scope, the platform, the compiler version and then
`Cargo.lock`, not the commit.

A job restores, in order: its own scope's cache for this lock file; `main`'s
for this lock file; `main`'s newest for the same job, platform and compiler.
The last is new: a pull request that changes the lock file used to build every
dependency, and now builds the ones that changed. A job saves only when what
it restored was not built from its lock file, so `main` keeps one per job and
lock file and a pull request writes its own only when it changes the lock
file. A job whose build was whole saves even when a test then failed.
`macos-native` saves before its tests, as soon as the library's tests are
built: a suite that fails, or runs out of time (every macOS job on `main`
from #1521 to #1535 did, and so no `main` cache existed and each pull request
built every dependency), still leaves the cache. Its tests need the crate's
output, so it moves the build aside, cleans an APFS clone of it with the same
`cargo clean`, saves the clone and puts the build back. Which runs may write
`main`'s scope does not change: a save still uses the run's own primary key.
`serve-tests` builds what `headless-serve` builds: it restores that job's
cache and saves none. In `linux-rust-tests` the `binaries` part saves, and
the four library parts restore what it saved.

A save runs only once its clean step succeeded: its `if` is
`steps.<id>.outcome == 'success'` on the step just before it (`clean`, and
`aside` in `macos-native`), with `!cancelled()` in front where the clean step
runs after a failed test. The save used to repeat the clean step's own `if`,
so a clean that failed still saved the crate's output. A policy test holds
every job that saves to this, and rejects the clean step's `if` copied.

Keyed by commit, every run saved a new cache, the repository's 10 GB limit
evicted them within hours, and the macOS jobs, which failed and so never
saved, built every dependency on every run.

## The Rust toolchain

**Rust is pinned to one release** (the owner's decision, 25 November 2026):
`rust-toolchain.toml` names `channel = "1.100.0"`, not `stable`, with the
components `clippy` and `rustfmt` and the target `aarch64-apple-darwin`. Every
job, and every developer's machine, builds with the release `rustup` installs
from that file. So a new stable release, with its new Clippy lints, no longer
fails every pull request at once with no change of ours. No workflow installs
or picks a toolchain of its own: each runs `rustup show && cargo --version`,
which installs the pinned release and prints it in the log. To bump it, open
a one-line pull request that changes `channel`, with any Clippy fixes the new
release needs. The cache keys carry `rustc --version`, so a bump starts new
caches by itself. `test_rust_toolchain.py` fails unless the channel is an
exact `x.y.z` and no workflow picks another toolchain (a toolchain action,
`rustup default`, `install`, `override` or `run`, `cargo +<toolchain>`,
`RUSTUP_TOOLCHAIN` or `RUSTC`).

## macOS Rust coverage

**A pull request is not held to the macOS Rust suite** (the owner's decision,
24 November 2026). `check`, the required status, does not need
`macos-native`, so it reports as soon as the Linux jobs and `webkit-layout`
have, without waiting the 45 to 90 minutes the macOS job takes. On a pull
request the selector still starts `macos-native` when the change needs it
(below), and its result shows as its own job; a red one there is information
for the reviewer, not a block. Pushes to `main`, nightly and manual runs are
held to it as before, by `check-macos`, which needs `check`, `macos-native`
and `webkit-mac-only` and fails unless all three succeeded; `release-serve.yml`
follows that run's conclusion. The mac-only WebKit checks follow the same rule
("The WebKit layout checks"). So an Apple-only failure can now first fail on `main`,
and the policy tests pin that `check` never needs `macos-native` or
`webkit-mac-only` again (either would hold the required status for its run and
its wait for a macOS runner), that `check-macos` needs both, and that it runs
on every event but a pull request.

**A pull request is not held to `machine-compat` either** (the owner's
decision, 25 November 2026). The job builds this tree against the previous two
released runtimes on a macOS runner. In run 45418009203 it waited 37.4 minutes
for that runner and then ran 2.6, while the rest of the run had finished by
minute 10, and `check` waited for it. Now `check` does not need it: a pull
request the selector picks for it (the paths in
`scripts/machine-e2e/relevant.py`) still runs it and shows its result for the
reviewer, red or green, and can merge either way. `check-macos` holds every push
to `main`, nightly and manual run to it, beside `macos-native` and
`webkit-mac-only`. **What is left to `main`:** a change that breaks the build
against a released runtime is found on `main` after the merge, by
`machine-compat` on the push and `check-macos`, and is fixed there. The policy
tests pin that `check` neither needs `machine-compat` nor names it in its gate,
that `check-macos` needs it and fails unless it succeeded, and that it still
runs when selected.

The full macOS suite runs on pushes to `main`, nightly at 02:23 UTC and on
manual workflow dispatch. A selected pull request runs the filtered part of it
(below).

**Not every commit on `main` gets a macOS result.** Each run of the workflow
has a concurrency group of its own, but the two macOS jobs share one group for
all pushes to `main` (`ci-macos-native-main`, `ci-machine-compat-main`), with
`cancel-in-progress: false`: one job runs, one waits, and a newer push replaces
the one that waits. GitHub cancels the replaced job ("Canceling since a higher
priority waiting request for ci-macos-native-main exists"), and that commit's
`check` is red although nothing failed. The rule is older than step 1. What it
means since 23 November 2026:

- The full macOS suite, the other test binaries and the doc tests on macOS run
  nowhere before merge, so `main` is the first place a failure in them shows.
  When pushes arrive faster than the suite runs (about 90 minutes), only the
  commit that was running and the last one waiting are tested; the commits
  between them are not, on macOS, by any run.
- A failure found on the last commit of such a burst belongs to any of the
  commits since the previous macOS result. Finding which takes a manual run on
  each (`gh workflow run ci.yml --ref <commit>`), or the nightly run, which
  tests the head only.
- A red `check` on `main` therefore means "failed" or "replaced while waiting".
  Read the macOS job's own conclusion (cancelled, with that message) before
  treating it as a failure.
- `release-serve.yml` publishes from a green run only. A replaced commit is not
  published; the next green commit is a descendant and carries its changes, so
  the runtime release is later by one macOS cycle, not lost.

`infra/ci-runners/macos-rust.py` selects a pull request, from **both** the
merge base and its head, when it changes:

- an Apple-only module: a file or folder behind `#[cfg(target_os = "macos")]
  mod …`, a file holding such a module inline, or one named for macOS
  (`APPLE_ONLY` in the script, 13 today);
- any Rust file that holds an Apple `cfg`, before or after the change. A
  change anywhere in such a file can break its Apple branch, which Linux never
  compiles. File names are git's own, and a file that cannot be read on either
  side selects the job;
- a path dependency Cargo builds for an Apple target alone
  (`transcription/native-detector`), the scripts the job runs and the ones
  those import, `.nvmrc` and `src-tauri/capabilities/`;
- `native/`, the Tauri configuration, entitlements and property lists, the
  icons, `Cargo.toml`, `Cargo.lock`, `build.rs`, the toolchain files and the
  crate roots;
- the approval wrapper and its tests (`harness/read_only*`), because shell and
  loader semantics differ even without an Apple `cfg`;
- `.github/workflows/ci.yml` or `infra/ci-runners/`.

Deletions and renames are checked at their old paths too. Before 23 November
2026 a file in the same folder as one with an Apple `cfg` selected the job as
well, and so did everything under `scripts/` and `.github/`. Of the last 400
commits on `main` this rule selects 152.

On `main` a Clippy failure fails the job and the suite still runs after it.
`release-serve.yml` publishes only from a green `main`, so a red macOS Clippy
holds back the runtime release until it is fixed, as a red suite does.

A selected pull request runs the Swift tests, the icon checks, the helper
build, Clippy over every target (so every Apple-only line of the library, the
binaries and the integration tests is checked), one build of the library's
tests, and the tests of the Apple-only and system-dependent modules:
`cargo test --locked --lib -- $(macos-rust.py --filters)`, 51 name filters
that match 1,889 of the 5,871 tests. They are the modules with any Apple
`cfg`, and the ones whose behaviour is the system's without one (terminals,
process groups, the keychain, sockets). A test fails when a file with an
Apple `cfg` is under none of the filters.

Print the rules and the filters:

```sh
python3 infra/ci-runners/macos-rust.py --list
python3 infra/ci-runners/macos-rust.py --filters
python3 infra/ci-runners/macos-rust.py --base origin/main --head HEAD
python3 -m unittest discover -s infra/ci-runners -p 'test_*.py'
```

**Coverage no longer provided on a pull request:** frontend-only,
documentation-only and shared Rust changes outside those rules take no macOS
runner before merge: no macOS Rust tests, Clippy, Swift tests or Apple icon
checks. A selected pull request does not run, on macOS, the other 3,982 of the
library's tests, the other test binaries (`--bins` and the three in
`src-tauri/tests/`) or the doc tests. All of it runs on `main` after the merge, nightly and on manual
dispatch; use manual dispatch on the branch when a platform difference in
shared Rust code is the risk. `src-tauri/serve/tests/local_platform.rs` is
compiled only for macOS and no job builds the serve crate's tests there, so
its two tests run in no workflow, as before.

## Runs of a closed pull request

A pull request's runs stop when it is closed, merged or not
(`.github/workflows/stop-closed-pr-runs.yml`). Before, a merged pull request's
runs went on to the end: 13 minutes after one merge, its WebKit and macOS jobs
still held two of the five macOS runners while three runs on `main` waited.

How: a concurrency group is shared by every workflow in the repository, and a
job that joins a group with `cancel-in-progress: true` cancels the run or job
in progress that holds it, "regardless of the workflow" (GitHub's
documentation, "Control the concurrency of workflows and jobs"). The stop
workflow has one job per pull request workflow; each joins that workflow's
group for the closed pull request, prints it, and ends. It has no token
(`permissions: {}`), no checkout and no action, and reports as `stop <group>`,
never as `check`, `frontend` or `webkit-layout`.

- **The group is built from the pull request's number.** The other workflows
  name their pull request groups after `github.ref`, which for a pull request
  is `refs/pull/<number>/merge`. On the `closed` event that holds only when it
  was closed without a merge; when it was merged, `github.ref` is the branch
  it went into (GitHub's documentation, "Events that trigger workflows",
  `pull_request`). So the stop workflow writes `refs/pull/<number>/merge`
  itself.
- **It cannot reach a run on `main`.** Every group it names contains
  `refs/pull/`. A push, nightly or manual run's workflow groups end in its run
  id, and the macOS jobs' groups in `main` or a run id. The policy tests fail
  when a workflow that runs on a pull request has a group the stop workflow
  does not name, or when a workflow that does not run on a pull request, or a
  job's own group, could be one it names.
- **Opened again, a pull request runs again:** `reopened` is one of the
  default activity types the pull request workflows run on.
- **A pull request with a merge conflict** starts no `pull_request` workflow,
  this one included (GitHub's documentation). Its runs from before the
  conflict are not stopped when it closes.
- **No new way to cancel someone else's run.** A pull request can already put
  a workflow file of its own on its branch that names any group, including
  another pull request's, and that workflow runs on that pull request. The stop
  workflow only does, for the pull request that closed, what any pull request
  could already do to any group.

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
| Action tag changes after review | All `uses:` actions pinned to full 40-character commit SHAs, including GitHub actions; policy tests reject mutable references. The one downloaded tool, cargo-nextest, is a named release whose archive is checked against a SHA-256 in the workflow. | Review SHA updates and snapshot/toolchain upgrades. Lockfiles remain enforced; pins do not certify dependencies as harmless. |
| One job persists into the next or escapes through host privileges | Self-hosted job preflight rejects root, passwordless sudo and standard Docker/Podman sockets. No shared disk cache configured. | Fresh VM and runner registration for exactly one job; non-root user, no sudo rights/capabilities/privileged sockets or host mounts. Controller deletes VMs on all outcomes and reconciles orphans. Preflight is diagnostic, not a sandbox. |
| Runner steals cloud, controller or release credentials | CI references no secrets; release/notarization/signing workflows are not moved here. | Long-lived GitHub/cloud tokens only on a separate controller, never in runner images, environment, user-data or checkout. No deploy keys or operator SSH keys on runners. |
| Cache poisoning crosses a trust boundary | Job + PR-number/main/run namespace + OS + architecture + compiler + lockfile write keys. Restores try the run's own namespace, then main's for the same lock file, then main's newest for the same job, OS, architecture and compiler. No other-PR fallback, none across jobs or platforms, and no implicit pnpm cache. | No shared volumes or writable object-store caches. Native GitHub merge-ref cache write scope must remain in use. All cached content must be public and credential-free. |
| Runner reaches production, metadata or controller | No network/cloud setup performed by this PR. | CI-only cloud project, no private network, no inbound firewall rules, external egress controls denying private/link-local/metadata/controller destinations. Allow only required build/GitHub traffic. |
| Resource abuse, failed deletion or controller compromise | Default remains GitHub-hosted. | Controller concurrency/cost/lifetime caps, bounded deletion grace, independent cleanup reconciliation, patched separate controller with minimal credentials and private operational logs. |
| Security policy regresses in a later edit | `test_workflow_security.py` exercises violations, and is run by required `frontend` in a step no selector answer skips. `check` gates every job and accepts a skip only on the selector's answer. | Normal branch protection and review of workflow/runner changes. PR-authored policy tests cannot authorize access to private runners. |

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

Caches use `ci-v5-<job>-<scope>-<os>-<arch>-<rustc>-<lock>`. Scope is
`pr-<number>`, `main`, or `run-<id>` for a manual non-main run. A job may save
only to its own scoped key; a PR cannot overwrite a main cache under GitHub's
native cache write rules. There is no shared local Cargo/pnpm directory
between VMs. Every Cargo job first restores its own namespace, then falls back
to `main` with the same job, OS, architecture, compiler and lockfile hash, then
to `main`'s newest with the same job, OS, architecture and compiler. The last
fallback is a prefix of `main`'s keys only: it never names another pull
request's scope, another job or another platform, and policy tests reject one
that does. Saving always uses the original scoped primary key, never the
matched fallback key. GitHub stores PR writes under the PR merge ref: main and
other PRs cannot read them, even if a fork changes the YAML to name its key
`main`. Main runs restore only main-scoped keys. Cache reuse is one-way across
the trust boundary. The `ci-v5` names need a successful main run to populate
them after merge: until then every job builds its dependencies once.

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
