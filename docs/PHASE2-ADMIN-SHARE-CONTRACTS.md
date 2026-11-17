# Preserved Admin integration checkpoint (wave6)

This integration copies the lead's CURRENT `src-tauri/src/cloud_workspaces.rs`
and `src/lib/api.ts`, retaining ALL133/137 presence, following, reassignment,
projections and inbox errors. It then selectively applies the three-file
`f749d73c` / `0bbfb272` transport change from `phase2-presence-client-prep`.
The later `28fb260b` host test-fixture repair is outside this piece and is not
copied. `cloud_workspace_last_admin` remains exactly once in each language's
allowlist; `cloud_workspace_share_unavailable` is added once.

Accepted server branch/source `e9f619fb` is available; production activation
remains held. Existing native v1 refuses manager plus false locally before HTTP;
manager plus true still passes through the existing production-false phase2 gate.
No new route, error code, approval protocol or runtime negotiation is invented.

The ten transport tests passed only in the earlier standalone `28fb260b`
validation. **THIS COMBINATION IS UNRUN**, including its authored display tests.
The prior TypeScript run reported missing `marked` in mobile; future validation
must use the lead's root dependency context. No dependencies are changed here.
Only a fresh explicit serial allocation plus
`~/phase2-orch/wave6-admin-integration-checks-granted` permits the requested
focused cargo command. No tests, builds, typechecks, installs, hooks or verifiers
have run for this integration. Source remains uncommitted pending allocation.

The narrow display compatibility is described in
`PHASE2-ADMIN-DISPLAY-COMPATIBILITY.md`. Broader new Admin grants and Save versus
autosave remain PENDING owner decisions. No general-access or activation work
is included. The historical transport handoff below records its original scope
and is superseded by this integration checkpoint's allocation and status.

---

# PRO167 explicit Admin share transport — source checkpoint only

This private transport-T slice starts at `58fd569d` (origin/phase-2 plus
origin/main). It does not collect wave5/root `2261c844`, activate Admin controls,
or certify server availability. All Cargo, Vitest, typecheck, build, donecheck
and verifier execution remains held. Tests below are authored and **UNRUN**.

The exact accepted server source is merged SaaS `81aede2e83ea268c2b8f13eecd10e297e86b9f99`,
`docs/phase2/roles-share-contract.md`. Its integrated correction and desktop
handoff supersede historical `a83b93ce` manager-false acceptance. The preparation
`root-source-audit.md` and `code-site-audit.md` identify the existing UI label and
selection gaps; this checkpoint does not resolve or approve those designs.

## Existing wire contract

All three existing routes use Bearer machine0 account authentication and the
current user's owned profile. Explicit shares require current target organization
membership, independently of the active organization and CS-18 multi-org flag.
Membership grants no visibility into another person's private workspace. The
server remains authoritative for visibility, implicit authority, and mutations.

The prefix is `/v1/desktop/orgs/:orgId/cloud-workspaces/:workspaceId`:

| Method | Suffix | Request body | Response |
| --- | --- | --- | --- |
| GET | `/shares` | absent | `{shares,you}` |
| PUT | `/shares/:userId` | exactly `{v:1,role,canApprove}` | `{share,created}` |
| DELETE | `/shares/:userId` | absent (existing client behavior) | `{share}` |

`role` is exactly `manager`, `viewer`, or `driver`; `canApprove` is a required
boolean. Unknown roles are rejected rather than coerced. `share` retains
`userId,email,name,role,canApprove,createdBy,createdAt,updatedAt`, with nullable
name and millisecond timestamps. `you` retains effective
`manager/driver/viewer/none`, `canApprove`, and `canManageShares`. PUT's
`created:false` is an accepted update receipt. DELETE's receipt can contain a
manager row. PUT and DELETE reject a foreign response userId; GET rejects invalid
row userIds. Existing command input and command registration are inspected only.

## Local holds and unchanged legacy behavior

Manager plus approval true is supported by the accepted server source. This
client still refuses a production manager PUT **before HTTP** through the
existing private `phase2_enabled:false` gate. The native local error is
`cloud_workspace_runtime_not_ready`, status null, retryable true, without a
Retry-After or mutation-context flag. Tests may explicitly enable the existing
private service field; there is no new public readiness switch or handshake.

Manager plus approval false always refuses **before HTTP**, with either setting
of that field: `cloud_workspace_runtime_unsupported`, status null, retryable
false, retryAfterSeconds null, retryWithSameIdempotencyKey false, and
requiresOriginalAccountContext false. This is the existing native local error
shape, not a synthetic HTTP 409. When received from the server the same code
retains the actual HTTP status. No boolean upgrade, fallback role, or automatic
retry occurs. Identifier validation remains local.

Viewer and driver PUTs remain available in production with exact false **and**
true approval serialization. Existing routes, GET/DELETE body absence, timeout,
response-body limit, authorization headers, and error capture remain in use.
Manager rows may be parsed from all three responses without enabling a manager
selection or changing runtime enforcement.

## Scoped account and membership fences

Only shares, share_put, and share_revoke call `run_share_in`. It reuses the
existing account `inbox_member_context`/`inbox_member_is_current` helpers and
bounded Client transport. Global `run_in`, provider behavior, CS-18 rules for
other routes, capabilities, and account helpers are unchanged.

The initiating account context comes directly from `account.context()`: an
explicit valid member target works even without an active organization. An
omitted target with no active organization retains local
`account_organization_unavailable`; malformed explicit targets retain
`cloud_workspace_request_invalid`.

Before and after HTTP, fences check the captured account generation, user,
profile, active organization, target membership, and access token. Token-only
session replacement without a generation change is fenced explicitly. A return
to the same identity after a new session generation (A-B-A) cannot release an old
answer. Both success and HTTP error results pass through the same late fence;
mutation fencing preserves requiresOriginalAccountContext. There is no actor
selector, cached success, authorization fallback, or local visibility inference.

## Safe errors and selective future integration

Rust's known-error match and TypeScript's safe-error union each add exactly one
`cloud_workspace_last_admin` (409) and `cloud_workspace_share_unavailable` (503).
Existing `cloud_workspace_runtime_unsupported` is retained. Existing 403
share-forbidden/manager-required, 401 invalid-token refresh/sign-out handling,
404 privacy/member failures, 422 validation, 429 share-limit with Retry-After,
and 503 dependency error handling are unchanged. Unknown error bodies remain
redacted through existing capture and fallback; no wire error format is changed.

Future integration must selectively reconcile this slice with ALL133/137,
including `52ac17d3`, `d4dc843d`, `d818e9b1`, and `ac570f05`, preserving both sides.
137 already supplies last_admin: retain one allowlist entry per language, not
duplicate match alternatives or union members. Do not import root/wave5 wholesale
or change any predecessor worktree, branch, checkpoint, or status file.

## Authored verification and release boundary

Ten mocked HTTP tests named `phase2_admin_share_contract_*` use the existing
fixtures. They cover mixed nullable manager/viewer/driver rows and effective
`you`; exact enabled manager PUT and bodyless manager DELETE receipts; both
manager-false settings and production manager-true holds with no HTTP; legacy
viewer/driver approval false/true over HTTP; strict IDs and unknown input/response
roles; non-active membership without multi-org and explicit targets with no
active org; omitted-target compatibility; nonmembership and private refusals;
late sign-out/account/profile/org/session/token-only/A-B-A/membership fencing for
success and errors on all three routes; foreign response users; safe errors,
status, redaction and Retry-After capture; bounded timeouts/body sizes; and no
automatic retries. These tests have not been executed or compiled.

Before any future SDK-pinned focused command, root must provide a fresh explicit
release **and both** `~/phase2-orch/pro167-client-focused-granted` and nonempty
`~/phase2-orch/pro167-client-prep/root-slot-confirmation.txt`. This checkpoint
creates neither. Rootfullgates remains exclusive; no blocked check command is run.
Only source inspection and `git diff --check` are permitted now.

No PR, push, UI activation, controls/labels, Everyone/general access, V2,
runtime, inbox, catalog, command/lib, SaaS, mobile, dependency, settings,
capability, or paid-cloud changes belong to this slice. The existing UI can
mislabel newly parsed manager rows; UI compatibility and design resolution are
required before any PR, push, or activation. This source checkpoint is not full
PRO167 completion or deployment certification.
