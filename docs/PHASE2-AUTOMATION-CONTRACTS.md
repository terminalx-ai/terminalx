# Phase 2 automation native and typed contracts

Part of PRO-228 / PRO-231. Accepted reference: SaaS
`56c2253de7f0e68213c9854b36fe4b9f168de614`, as recorded in
`~/phase2-orch/automation-integrated-contract.md`. Historical branches are
not the accepted contract.

## Activation remains held

`CloudWorkspaceService.phase2_enabled` defaults false in production. Valid
fresh-workspace or GitHub-trigger **estimate and create** requests fail locally
with existing `cloud_schedule_runtime_unsupported`, without HTTP or compute.
Invalid input is validated locally first. Only the mock test service enables
these paths. Existing timer requests (omitted mode or `existing`) retain the
current API, authorization, provider handling and spend confirmation. Old
scheduled-task, provider or multi-organization support does not establish
fresh/GitHub capability. Future UI must wait for a confirmed coordinated
activation; these adapters do not enable the feature or establish readiness.

Resume is held at the shared native `cloud_schedule_set_active` boundary, so
both raw and legacy adapters receive the same protection. While the hold is
active, `active: true` first reads the existing GET `/:scheduleId` detail route
with the captured account/organization context. Only an existing-workspace timer
may proceed to the original resume POST and `confirmProviderSpend: true` body.
Fresh/GitHub targets return existing `cloud_schedule_runtime_unsupported` without
a resume POST; a detail refusal also prevents the POST. Account, profile and
organization/membership authority is checked after the read and immediately
before mutation against the captured context, and again after the mutation.
No readiness flag is inferred. Pause, delete and pause-all require no extra read
and remain available during the hold.

No endpoint, webhook subscription, provider configuration, runtime launch or
mailbox claim behavior changes here. Live webhook delivery, Docker boot and
native runtime certification remain outstanding; tickets stay open. The
multiple-trigger/webhook design mismatch remains an owner decision for the UI.

## Native transport

Existing Tauri commands and routes are retained:

| Command | HTTP under `/v1/desktop/orgs/:orgId/cloud-schedules` |
| --- | --- |
| `cloud_schedules` | GET `/`, optional `workspaceId` template filter |
| `cloud_schedule` | GET `/:scheduleId` |
| `cloud_schedule_estimate` | POST `/estimate` |
| `cloud_schedule_create` | POST `/` |
| `cloud_schedule_set_active` | POST `/:scheduleId/pause` or `/resume` |
| `cloud_schedule_delete` | DELETE `/:scheduleId` |
| `cloud_schedules_pause_all` | POST `/pause-all` (retained existing API) |

`CloudScheduleCreateInput` adds optional `workspaceMode`, `archiveAfterDays`,
`archiveOnPrMerge`, `githubTrigger`, and makes `schedule` optional.
`CloudScheduleEstimateInput` adds only `workspaceMode`, `githubTrigger` and
optional `schedule`; it rejects cleanup fields and never sends a prompt.

Exactly one timer or GitHub trigger is required. Mode is `existing` by default
or `fresh`. Create-only `archiveAfterDays` is an integer 1–365 and requires
fresh mode; `archiveOnPrMerge: true` also requires fresh mode and is valid with
a timer. An explicit false is permitted for existing mode.

`CloudScheduleGithubTrigger` is `{ repositoryId, event, filters,
allowForkPullRequests? }`. The repository identifier is the selected organization
repository **row ID**, not a GitHub numeric ID or a clone URL. Events are
`opened | pushed | merged`. At most five ANDed filters use exactly
`{ field: label | author | baseBranch, operator: is | is-not, value }`.
Repository IDs and filter values follow the accepted 255 UTF-16-unit bound;
filter values must be nonblank, contain no ASCII control characters and are
trimmed before sending. Nested unknown keys and nonboolean fork flags are
rejected. Omitted `allowForkPullRequests` becomes false and is sent explicitly;
true is retained on readback. UI label: **Allow pull requests from forks**.
The service remains responsible for repository visibility and event semantics.

Create always retains required non-bypass mode and `confirmProviderSpend: true`;
resume sends the same spend confirmation. Existing auth headers and owner/admin,
active-organization, private-template and connected-provider rules remain.
Server refusal/status handling and estimate-route fallback are retained.

## Public TypeScript API for dependent UI

All functions live on exported `api` in `src/lib/api.ts`; optional `orgId` is the
last argument, and list functions take optional `workspaceId` first. These are
internal desktop DTO adapters, not new HTTP endpoints:

| Function | Result |
| --- | --- |
| `cloudAutomations(workspaceId?, orgId?)` | `{ schedules: CloudAutomationDto[] }` |
| `cloudAutomation(scheduleId, orgId?)` | `CloudAutomationDetailDto` (`schedule`, newest `runs`) |
| `cloudAutomationEstimate(input: CloudAutomationEstimateInput, orgId?)` | `CloudScheduleQuote` |
| `cloudAutomationCreate(input: CloudAutomationCreateInput, orgId?)` | `CloudAutomationDto` |
| `cloudAutomationSetActive(scheduleId, active, orgId?)` | `CloudAutomationDto` |
| `cloudScheduleDelete(scheduleId, orgId?)` | `void` (shared existing delete) |
| `cloudSchedulesPauseAll(orgId?)` | `{ paused: number }` (shared existing emergency stop) |

`CloudAutomationTriggerInput` is a timer-or-GitHub exclusive union.
`CloudAutomationWorkspaceInput` restricts create cleanup settings to fresh mode.
Estimate input accepts only mode and trigger, with existing completion/run limits.
`CloudScheduleGithubTrigger` and `CloudScheduleGithubFilter` export exact field,
operator and event unions. Native validation remains authoritative for limits.

`CloudAutomationDto.schedule` is optional/nullable; no timer is fabricated.
GitHub automations have no next run time. Raw DTOs tolerate omitted/null new
fields from compatible responses. `workspaceMode` defaults to `existing` and
`archiveOnPrMerge` to false in native responses from older servers, for both
omitted fields and explicit null. Non-null values retain their strict string
and boolean types. Request fields may be omitted but explicit null is rejected
by the native request DTOs, matching the accepted SaaS parser.

Existing `cloudSchedules`, `cloudSchedule`, `cloudScheduleCreate`,
`cloudScheduleSetActive`, and timer input/result types remain available for the
current UI. The legacy list projects only existing-workspace timers, filtering
fresh/GitHub rows. Legacy detail/create/set-active reject a response requiring
the automation API instead of fabricating timer data. Use the automation
adapters for all future automation UI. `cloudScheduleEstimate` retains its
current timer signature. Delete and pause-all still apply to their original
server targets, including automation bookkeeping.

## Run identity and costs

`CloudScheduleRun` adds nullable/optional `workspaceId`, `workBranch`, `archiveAt`,
`archivedAt`; `state` includes `creating-workspace`. Link a run only by its own
allocated `workspaceId`, never by the schedule's template ID. Before allocation
that link is unavailable. The accepted server can return the template as an
internal placeholder: native detail/list/create/set-active normalize a fresh
run's matching template ID to null (including `lastRun`). No runtime claim or
launch behavior changes. `archivedAt` records observed archival, whereas
`archiveAt` is policy due time. A due timestamp does not establish archival.

`CloudScheduleEstimate.createPerRunMinutes` preserves the server's fresh
creation allowance (20 minutes), included in `perRunMaxMinutes` alongside the
claim budget, execution limit and reporting grace. Costs remain integer numeric
micro-units and epoch timestamps remain numeric milliseconds. No local ceiling
is invented: fresh monthly compute is per-run cost times monthly runs; `keep`
includes a machine-month for every fresh run. GitHub estimates use 24 runs/day,
720/month. Active-compute estimates exclude storage and model tokens.

## Focused verification

All automation regression tests use prefix `phase2_automation_contract`, including
retained timer HTTP/body/refusal/pause/resume/delete/pause-all regressions. New
mock tests cover held paths without HTTP, local invalid inputs, fresh timer
cleanup bounds, exact GitHub request bodies/default fork opt-in/persisted true,
nullable/absent timers, own run identity and nullable cleanup metadata, numeric
fresh cost ceilings, authorization/provider refusals and production hold. Resume
tests verify held fresh/GitHub targets never POST, legacy timers retain their
authorization and spend body, preflight errors prevent mutation, delayed reads
across account/profile/organization/membership changes never POST, and safety
controls remain available without preflight. Null-response regressions cover
list/detail/create/pause/resume, including the held resume preflight, and fresh
cleanup responses preserve run identity and persisted fork opt-in.

Run only after the lead grants the heavy-check slot:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
cargo test --lib phase2_automation_contract --manifest-path src-tauri/Cargo.toml
```

Verified try 2 continuation on 2026-11-15: selectively applied the three owned
files from checkpoint `c70d4dc4578b4ab003352a7488aae64df75f8776`, then retained
the resume preflight/fence and regressions from
`raccoon/automation-contracts-accepted-fresh-run-2`. No branch was merged.
Added explicit-null response defaults and two mock HTTP regressions while
preserving strict request parsing. After the lead's focused-check grant, the
required Cargo command and nonzero-test-count assertion exited 0 on the final
native source: **23 passed, 0 failed, 0 ignored**. No live compute or webhook
certification is claimed.

The existing primary-checkout TypeScript compiler's `--noEmit` check exited 2
because this worktree lacks the mobile `marked` dependency; diagnostics were
limited to `mobile/src/ui/markdown-blocks.ts` and `transcript-rows.ts`. A second
full TypeScript compiler check with only an in-memory `paths.marked` mapping to
the primary checkout's installed `mobile/node_modules/marked/lib/marked.d.ts`
exited 0 with zero diagnostics. No dependency files or UI files were changed.
