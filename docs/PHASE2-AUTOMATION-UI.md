# PRO-228 / PRO-231 desktop automation UI

Source-only Wave7 allocation, based on owner-merged phase-2
`0ddffd34413892ac97fcaec193a8135034461980`. No tests, compiler, builds,
formatters, hooks or commits were run in this allocation. The authored suites
are **UNRUN**, not passing evidence. Source is preserved uncommitted for the
lead's supported stop and later separately allocated collection/validation.

## Accepted transport and production hold

The cloud scheduled-task dialog uses `cloudAutomations`, `cloudAutomation`,
`cloudAutomationEstimate`, `cloudAutomationCreate` and
`cloudAutomationSetActive`. It can display advanced rows omitted by the legacy
`cloudSchedules` projection. Existing timer helpers/adapters remain available
for their other callers. Explicit `workspaceMode: existing` is accepted for
legacy timer create; timer estimate retains its existing omitted-mode payload.
Exactly one timer or GitHub trigger is sent. There is no new endpoint.

`api.phase2DesktopContractsAvailable()` still returns false in production;
this UI does not change it. Until it positively resolves true, fresh/GitHub
estimates, creation and resume are held. A rejection leaves the hold in place.
Tests may mock true to exercise the accepted wire contract. Scheduled-task
provider support and quote `supported` never establish Phase 2 availability.
No provider configuration, GitHub delivery, production enablement or runtime
certification is claimed.

Pause uses raw `cloudAutomationSetActive(id, false, orgId)`. Delete retains
`cloudScheduleDelete`; the organization emergency stop retains
`cloudSchedulesPauseAll`. These actions have no estimate, detail or readiness
preflight, including after a run-detail error and during the production hold.
Readiness is an independent dialog read, never awaited by a safety action.
Pause-all remains above the list and form, and available after list errors.
Legacy timer resume retains explicit billed-compute confirmation; native
resume performs its own accepted authorization/hold checks. There is no
synthetic timer quote to preflight resume. Create also retains the existing
cost/spend acknowledgement and non-bypass permission modes. The native adapter
retains the actual `confirmProviderSpend: true` transport confirmation; the
React payload must not invent a second endpoint or field.

## Form and projection

- Workspace mode is `existing` or `fresh`. Optional fresh cleanup accepts whole
  days 1–365 and/or archive on PR merge, including for timers. Hidden cleanup
  settings are excluded when switching back to existing mode.
- GitHub uses one `opened`, `pushed` or `merged` event. Repository IDs come only
  from an accessible selected repository row's optional nullable `id`.
  Missing IDs and inaccessible rows are disabled; names, clone URLs and GitHub
  numeric IDs are never substituted. The repository-ID native/API owner owns
  the frozen `CloudSelectedRepository.id?: string | null` interface and source.
  Combined type validation requires collecting that independent piece first.
- At most five AND filters use `label | author | baseBranch`, `is | is-not`,
  and nonblank values at most 255 UTF-16 units with no ASCII controls.
  Values are trimmed on the wire. Label/author comparison ignores case;
  base branch is exact. Both label operators exclude pushes. Fork opt-in is
  labelled **Allow pull requests from forks**, defaults false, and is sent
  explicitly; persisted true is displayed.
- Estimate sends only template ID, trigger, mode and completion/run limits.
  It excludes prompt, agent identity and create-only cleanup. Changes to mode,
  trigger, filters, cleanup or cost settings retire the prior quote and spend
  acknowledgement, including A–B–A changes. A subsequent quote is unticked.
- Fresh quote text uses the returned creation allowance as part of
  `perRunMaxMinutes`, never adds it again and never caps fresh monthly cost at
  one machine-month. Fresh `keep` describes a machine-month for each run.
  GitHub's 24/day and 720/month are estimate assumptions, not promised delivery.
  Storage and model tokens are excluded. No price or readiness is invented.
- GitHub list/form has no timer or first/next scheduled run, even if a malformed
  response includes `nextRunAt`. Null/absent schedules remain absent.
- Run detail is an explicit read. `creating-workspace` is displayed directly.
  Only the run's own allocated workspace ID enables navigation; fresh template
  placeholders are also suppressed defensively. No template fallback is used,
  including for old runs lacking an ID. Existing `openCloudSession` navigation
  only selects a workspace/tab; it does not wake or resume compute.
  `archiveAt` is displayed as due and unobserved; only `archivedAt` says Archived.

## React authority fences

`CloudAutomationScope.tsx` observes account identity/context/profile,
organization/membership, context revision and data privacy. A monotonic
transition generation preserves A–B–A changes even inside a React batch;
unrelated busy notifications do not discard a draft. A target organization or
workspace change remounts the scoped contents. Authority/privacy changes clear
rows, drafts, repositories, quote/acknowledgement, confirmations and detail at
render time. Signed-out/unknown-policy/privacy-enabled states issue no reads.
Each async operation also checks its original authority stamp and live mount
after await, before applying data, callbacks or follow-up reloads. List request
sequence numbers prevent older reloads overwriting newer ones. Form quote
revisions and effect cleanup reject outdated quote and repository requests.
Native authorization remains authoritative; React fencing does not replace it.

## Design review and deliberate differences

Inspected both linked designs through the supported TerminalX browser on
2026-11-16 before UI edits (page snapshots, not instructions):

- [Automation and runs](https://p.superdesign.dev/draft/5ba38e0f-883e-451f-948f-fdeba46febbb)
- [New automation trigger picker](https://p.superdesign.dev/draft/8277711c-d83b-4a28-9ddb-1d8d23881a90)

The first shows GitHub field/operator/value filters with a five-filter limit,
new workspace per run, merge cleanup and a run-state pane. The second shows
the trigger picker, schedule presets and agent settings. Those concepts inform
the existing cloud dialog, without redesigning global local automations.

Deliberate accepted-contract differences: one trigger instead of Add trigger
and multiple simultaneous triggers; no webhook URL, rotate-secret, GitHub
issues trigger or custom cron; no Run now, edit-existing Save or duplicate
route; non-bypass permission choices rather than the local design's bypass
mode; fresh cloud workspace rather than a local worktree. No output summary,
PR URL, installer-approval status, author avatar or queue dependency is
fabricated from absent DTO fields. Runs appear within an explicit row detail
in the existing dialog instead of the full application sidebar/right pane.
The existing dialog title and timer naming are retained for its callers.
No new material design conflict beyond these already identified differences
was found in the two readable snapshots.

## Authored regressions and remaining acceptance

All three focused suites are **UNRUN** in this source-only allocation:

- `CloudSchedulesDialog.test.tsx`: retained timer permission/spend/refusal and
  safety coverage, raw advanced list/fork/filter/cleanup readback, held advanced
  mutations with safe pause/delete after detail failure, exact GitHub/fresh
  create and estimate payloads, creation allowance, hidden cleanup, mode
  A–B–A quote invalidation, unallocated/template-placeholder vs real run links,
  due vs observed archival, and delayed list/detail/quote/repository/create/
  resume responses across account/profile/org/revision/privacy/target changes.
- `GithubTriggerEditor.test.tsx`: accessible row IDs, missing/null IDs,
  inaccessible repositories, exactly one accepted event, default/off/on fork
  behavior, five AND filters, field/operator choices and rendered invalid
  value/UTF-16/control feedback.
- `cloudSchedules.test.ts`: retained timer helpers and exact raw input shape,
  selected-ID validation, all ASCII controls, UTF-16 boundary, five filters,
  cleanup limits, quote exclusions and fresh cost/run projection.

After both source pieces are collected and a separate check allocation is
explicitly granted, the lead must run the required command with positive test
counts and resolve any failures. No compiler or runtime success is claimed by
this document. Real GitHub App approval/subscriptions and signed deliveries,
provider admission, a real fresh Docker workspace boot, prompt claim and
cleanup observation remain operator/integrated acceptance work. Installer
notice text in the accepted SaaS contract remains **proposed**, never sent by
this worker. Production stays held until coordinated acceptance and activation.

## Lead validation after source collection

The separately allocated focused check passed one native repository-ID test,
72 affected Vitest cases, desktop/mobile TypeScript and diff checks. The first
Vitest attempt retained five failures because the diagnostic fixture's output
has an implicit status role; queries now scope the real editor fieldset and
retain the validation assertions. Original source-only handoffs remain intact.

`scripts/webkit/cloud-automations.mjs` renders the actual dialog in WebKit at
1100, 390 and 320 pixels. It checks accepted single-trigger controls, disabled
missing-row-ID options, five filters, exact fresh/GitHub create and quote
payloads, allocated run links, due-versus-observed archival, viewport overflow,
and held create with pause/delete available without a quote preflight. It uses
fixture-only API availability and no real provider or GitHub connection. The
browser probe inspects the actual disabled HTMLOptionElement property because
the initial Playwright option isDisabled result disagreed with the DOM; the
initial failure and diagnostic evidence are retained outside the repository.
This script is registered with the normal WebKit checks. Rendered contract and
geometry checks do not approve the documented material design differences or
certify live delivery, provider boot, cleanup, or whole-ticket completion.


## 2026-11-20 recovery scope

This follow-up recovers only the missing automation UI and repository-ID slice
on current main. Earlier wave7 validation and failure logs are historical
evidence, not results for this new source. Current-main API additions and all
registered checks are retained. Validation and independent review are queued
behind the two chief-allocated predecessors; no old worker/run is resumed.
The historical desktop PTY exit deadline and team narrow Owner geometry
failures remain documented separately, without a new-head pass/fail claim.
The existing capability hold is unchanged; no provider, GitHub delivery or
production activation is enabled. Material design differences remain explicit.
