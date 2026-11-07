# Two-account regression harness (PRO-249)

This is a **source checkpoint, not completed two-desktop E2E coverage**. The
entry point currently records a failing preflight. It does not start desktops or
run scenarios. Contract tests, SQL fixture validation and WebKit layout checks
must never be reported as successful two-person execution.

```sh
pnpm test:team-e2e
pnpm e2e:team --preflight --artifacts artifacts/team-e2e
```

The second command exits **2 (incomplete)** and writes an immutable
`team-<UUID>/result.json`. The same is true without `--preflight`: missing native
bindings and missing features cannot be bypassed by configuration. Exit 1 means
failure; exit 0 is reserved for a complete real run. A skipped/not-run required
scenario, missing deliberate break, cleanup failure, stale identity, or a failed
first attempt followed by a successful retry cannot produce a green report.

## Existing infrastructure and boundaries

The paired server change extends `apps/api/scripts/cloudLocalE2e/run.ts` rather
than introducing another API, provider or product model. `--team-fixture` creates
the existing disposable Postgres/Redis/API/relay/worker stack. It adds account B
and an unconsumed invite addressed to B to the one organization owned by A.
B initially has no membership; accepting the invite through the application is
the first required scenario. The invite seed sends no email. No migration is added.

Each account gets its own loopback authorize proxy. Only the development callback
`terminalx-dev://auth/callback`, S256 and the native local profile are allowed.
The existing API exchanges and validates PKCE codes, issues sessions, and applies
all membership, capability, privacy and workspace permissions. No desktop state,
Keychain entry, read marker, presence, or notification is injected by the harness.
The fixture readiness manifest contains IDs and origins, never bearer tokens.

The server fixture command, **after recovery and local fixture review**, is:

```sh
CLOUD_TEAM_RUN_ID=team-<UUID> \
CLOUD_TEAM_READY_PATH=/absolute/owned/run/fixture.json \
TERMINALX_DIR=/absolute/desktop-checkout \
TERMINALX_SERVE_BIN=/absolute/linux/terminalx-serve \
bun apps/api/scripts/cloudLocalE2e/run.ts --team-fixture
```

Run it from the server repository. It retains private server logs, binds proxies
to loopback, bounds fixture lifetime to 30 minutes, refuses a remote Docker
context and existing local-provider workspace resources, and collects workspace
IDs from its own database before cleanup. It uses a unique runtime image tag.
Its `.closed.json` is a **fixture lifecycle result**, with zero desktop scenarios,
not an all-scenarios result. SIGTERM/INT stops only the owned fixture processes;
the existing process list and workspace-ID cleanup are reused. Never kill by
process name, prune Docker globally, or reset a shared database.

`scripts/webkit/harness.mjs` serves the built application with Tauri/runtime
stubs. Keep using it for layout regressions, but it cannot prove native auth,
transport, identity, permissions, two machines, or notifications.

## Real-machine integration gate

The installed TerminalX local-VM guide describes a **Linux XFCE container**.
That VM is not a second macOS TerminalX desktop. Configure a genuine second Mac
or supported macOS VM with the actual native runtime before certification.
Both debug application binaries must correspond to recorded exact source heads.
Record machine identifiers as run-local hashes, application PID, binary SHA-256,
account ID, organization ID, workspace/tab IDs and exact desktop/server heads.
Two windows or two browser profiles on the host do not satisfy this gate.

Use separate run-owned `TERMINALX_HOME` directories and the existing debug-only
`RACCOON_DEV_KEYCHAIN_SERVICE=dev.terminalx.<runId>.<A|B>` override, which also
namespaces workspace keys. `TERMINALX_DEV_API_BASE_URL` must be the appropriate
loopback proxy. Released builds ignore these overrides and must never be used.
`desktopEnvironment` constructs this restricted environment and drops inherited
coordinator socket/token and provider credentials. It does not launch a process.

The second Mac needs reviewed SSH forwarding for the B API, relay director and
cell ports named in the fixture manifest, loopback on both ends. Its installed
TerminalX controls its development app using `terminalx computer`; the host does
the same for A. Read each installed guide. Respect `own_app_protected`,
`confirmation_pending`, privacy, capability refusals and person-only controls.
Do not use an alternate helper, OS scripting, private RPC/state injection, or
programmatically grant permissions. A click acknowledgement is not an assertion.
Capture fresh accessibility state and screenshots after each observable effect.

**Still required source/integration work:** implement and verify actual native
launch/login/navigation/action bindings on these recovered machines, connect
the fixture lifecycle to the entry point, and implement remote transport and
owned remote cleanup. `native.mjs` currently provides only environment isolation
and the supported snapshot/click primitives. It is not a complete scenario driver.
No hidden external adapter or configurable command can report fabricated success.

## Scenario contracts

Assertions in `scripts/team-e2e/scenarios.mjs` use observed values, not a generic
success boolean. Every real scenario needs a clean setup, successful baseline,
then a controlled break in an independent setup. Keep the baseline and failed
attempts; never rewrite them when retrying. A fault must be restored in `finally`,
and restoration/cleanup failures fail the run. Faults must be scoped to owned
fixture traffic or a specific action; never relax application permissions.

| Scenario | Required distinguishing evidence | Controlled real break to certify |
| --- | --- | --- |
| Invite accept | B absent, matching invite visible; B becomes member in the exact org; invite consumed; A stays owner | Suppress B's accept action |
| Share | B initially denied; viewer grant allows the run's unique transcript marker; no approval right | Suppress A's grant |
| Viewer read-only | Actual B send, terminal and approval attempts denied; disabled composer; unchanged transcript and no queued command | Proposed isolated proxy fault: change the response status of the already-denied viewer probe to 202; keep the authoritative denial and assert no queued command or mutation |
| Presence appear | A absent then appears as the right identity on the right tab on B | Keep A disconnected |
| Presence clear | A present then absent while B remains connected | Keep A attached |
| Follow | B follows A to another tab; unfollow prevents the next change | Suppress the follow action |
| Mention + notification | Exactly one new event to B from A for the run's marker/workspace; destination opens; reconnect does not duplicate | Suppress mention submission |
| Reassign | Owner/assignee transitions A → B on both surfaces; viewer permissions unchanged | Suppress reassignment |
| Nudge | Exactly one matching nudge to B; correct destination; no duplicate after reconnect | Suppress nudge submission |
| Unread sync | B's read sequence synchronizes to another authenticated B surface; stale update cannot regress it; A's marker unchanged | Suppress B's marker update |
| Unshare | Previously visible content disappears; existing attachment and subsequent reads/sends denied; A retains access | Suppress revoke |

The read-only proxy fault still needs implementation and review before live
certification: mutating observations in `corruptObservation` is only a unit-test
of assertion sensitivity, **not** a demonstration of broken product enforcement.
The same distinction applies to every contract-test mutation. Real breaks and
their evidence remain a release gate for all rows.

## Peer integration inventory

Observed desktop base: `0656e725da564ba1f1838dd79a2d96b52f96192e`.
Observed server base: `b05ddb86d16b68fded09d951a7390532af1bd099`.
No peer implementation was cherry-picked.

| Peer | Read contract / current implication |
| --- | --- |
| PRO125 | Unmerged inbox SSE/long-poll, receipts, `workspace.reassigned` and per-user monotonic read markers; `team.events.v1`. These are unavailable at the pinned base. |
| PRO128 | Unmerged roster `createdAt`, cache invalidation and `team.roster.v1`; current basic roster is available. |
| PRO163 | Unmerged authorized workspace links `/o/:org/w/:number`; cannot use unlanded deep links as setup. |
| PRO171 | Current direct sharing exists; group sharing/effective grants are unmerged. Do not copy that implementation. |
| PRO175 | Existing native invite API exists; welcome UI is in progress with its new owner. Verify the landed UI before native bindings. |
| PRO191 | Unmerged setup/computer-color contract and `organization.setup-flow.v1`. |
| PRO244 | Unmerged privacy policy must be integrated and obeyed before final native execution. |
| PRO252 | Feature rollout foundation unmerged; feature absence/off must be incomplete, never skipped-green. |

No landed person-follow, person-mention, reassignment or person-nudge action was
found. Agent transcript following, file mentions, driver leases and runtime
mailbox nudges are different operations and cannot substitute for these features.
`capabilities.mjs` keeps this inventory explicit until actual landed contracts
and native bindings are reviewed.

## Nightly configuration and release gates

`.github/workflows/team-e2e-nightly.yml` uses the existing GitHub Actions
infrastructure, a dedicated self-hosted macOS runner, protected environment
`team-e2e-local`, and a single non-cancelling concurrency group. It accepts only
main, never PR code. It is inactive until repository variable `TEAM_E2E_ENABLED`
is set to `true`; `TEAM_E2E_CONFIG` names the reviewed machine-local configuration.
No global schedule or daemon is installed or activated on this development Mac.

The nightly posts its result to `GITHUB_STEP_SUMMARY` even on failure and uploads
run artifacts for 14 days. Local retention keeps at most 30 finished owned runs
for 14 days, preserving unrelated and active directories. The result sink tests
use local memory/files and send no external messages. A posting failure fails the
job. Activation and a real nightly run with a posted result are **unfulfilled
acceptance criteria**, not inferred from the workflow's presence.

Before publication: recover the host; finish the native/remote driver against
actual landed peer contracts; validate all real baselines and deliberate breaks
with screenshots/logs and verified cleanup; activate the reviewed nightly and
retain its posted result; complete normal hooks and final exact-head independent
review, native/security/current-head CI, and paired server gates. The coordinator
owns publication/auto-merge and existing production-poller observation. Never
start a duplicate deployment.
