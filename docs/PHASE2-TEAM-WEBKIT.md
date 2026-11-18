# PRO-133 / PRO-137 rendered WebKit regressions

Source authored, **UNRUN**, 2026-11-16. Worker base/head is
`26080f13d9b1e1426a3754ef2a5bb774f9aef312`, branch
`raccoon/team-webkit-pro133-137-rendered-overview`.
No install, build, WebKit, test, typecheck, hook, commit or verifier was run.
No rendered acceptance, visual inspection of the application, timing guarantee,
or ticket completion is claimed. The explicit heavy-slot hold takes precedence
over the original done-check/commit instructions; edits stay uncommitted.

## Prerequisite inspected read-only

The actual root copy is the sibling worktree
`phase-2-pro-120-orchestration-lead`, including its current
`docs/PHASE2-PRESENCE-UI.md`, `TeamOverview.tsx`, `AgentDashboard.tsx`,
`SessionTable.tsx`, `WorkspaceFollowing.tsx`, `WorkspaceActions.tsx`,
`WorkspaceFollowingSection.tsx`, `WorkspaceReassignedNotices.tsx`,
`cloudPresence.ts`, `desktopInbox.ts`, `cloudInbox.ts`, `cloudCatalog.ts`,
`api.ts`, account/privacy/roster/visibility modules, and portable dashboard sort.
The 17:35 accepted decisions were read from the actual
`~/phase2-orch/decisions.md` and `PRO-133-ui-decisions-needed.md`.
The chief's recorded focused Vitest and desktop/mobile TypeScript exit-zero
results are prerequisite evidence, not results of this worker's regressions.

The lead must integrate its CURRENT 27-file UI prerequisite and accepted
transport dependencies, then produce `dist/` from that composition in a future
allocated slot. This worker's base lacks those components and must not be used
to build the acceptance composition. Nothing was copied from root into this
worker, and no production source, native/API/Admin/provider file was edited.

## Authored browser coverage

`team-presence-following.mjs` serves built assets with the existing `serve` and
`launch` WebKit harness. It loads existing bridge/runtime/local-sharing stubs
plus the opt-in `teamOverview` fixture in `dashboard-stub.js`. Every application
store, controller, table, menu, popover and dialog is the real built UI. The
fixture changes only browser-local native answers. Its readiness answer does
not change native constructors or enable any production route. All external
HTTP requests are aborted before initial navigation; assets use localhost.

At 1360, 390 and 320 CSS pixels, the authored scenarios cover:

- Everyone/Mine/Shared with me/Following/Active now actual rows and counts over
  the same visible session set, with local rows counted as yours. By multi-select
  searches real people, retains two checked choices, writes only the account/org
  filter key, and resets through Anyone. Search and workflow filters narrow
  counts and rows together. Organization visibility alone is not a share;
  running compute with zero people is not Active now.
- Owner/status/Last active menu ordering and `aria-sort`, keyboard header toggle,
  unknown cloud activity remaining last and without a fabricated `<time>`,
  and Display hiding/restoring the actual Owner header. Table headers may be
  reached by horizontal scrolling; menus must fit all clipping ancestors.
- Deduplicated active avatars and org count, real profile popover geometry,
  online profile state, known-empty presence becoming offline, failed presence
  becoming unavailable, disabled unknown Active count, and no profile last-seen
  ages. The empty response simulates the authorized server projection after TTL
  expiry; this does not claim a real 45-second TTL timer acceptance run.
- Following sidebar selection and header state, unfollow removal, a deliberately
  deferred follow mutation with no optimistic sidebar grant, and authorized
  catalog refresh after acknowledgement.
- Reassign search/no-match disabled submit, empty-team invitation action,
  optional note, server busy refusal and an explicit retry preserving the exact
  request UUID, expected owner, target and note. Successful reassignment uses
  refreshed catalog ownership and previous-owner Following. Private cross-owner
  handover remains disabled and invokes no reassignment command.
- Account switch while a dialog holds private context hides names, note and
  inputs. Reassigned inbox notices require fresh live-catalog target ownership;
  non-targets see no note. Target notes render as text and disappear on account
  switch or native privacy-policy refresh.

Geometry checks finish animations, measure viewport and every overflow ancestor,
then hit-test controls. Playwright performs the actual clicks, typing, radio
selection, keyboard actions and horizontal scrolling. There are no screenshot
baselines, goldens or DOM-string-only stand-ins for rendering.

The fixture deliberately exposes only three authorized cloud workspaces plus
one local session. It uses the exact native commands and DTOs from root:
`cloud_catalog_feed` authenticated `viewerUserId`, per-item `following`,
`desktop_presence_read` with TTL 45, existing roster commands,
`cloud_workspace_follow_put/delete`, `cloud_workspace_reassign`, and desktop
inbox pages/receipts. It never supplies a cloud owner for the local row.

## Registration and future execution

The exact existing `package.json` `test:webkit-layout` key now runs the existing
`run-all.mjs` list, then the dedicated scenario. It is a one-line edit, with no
second key. `run-all.mjs` is outside this piece's ownership and was not changed;
the dedicated script is therefore appended explicitly to the full package
suite rather than being silently omitted from it.

All commands below are **NOT RUN** and need BOTH fresh explicit serial allocation
and `~/phase2-orch/wave6-team-webkit-checks-granted`. A grant file alone is not
allocation. Build/install prerequisites also remain held until root authorizes
and schedules them. Once the integrated build and installed WebKit exist:

```sh
test -f "$HOME/phase2-orch/wave6-team-webkit-checks-granted" || exit 1
node scripts/webkit/agent-dashboard.mjs
node scripts/webkit/cloud-sidebar.mjs
node scripts/webkit/team-presence-following.mjs
```

The first two lines after the grant are the original piece's exact required
checks. The dedicated third command is additionally required to exercise the
new coverage. A later allocated full suite is `pnpm test:webkit-layout`; it
includes the dedicated script via the package command.

Potential integration issues must be fixed in root by the UI owner, never by
weakening these assertions. In particular the current fixed-width Views rail,
app sidebar and wrapping toolbar still need rendered narrow-width composition
validation. Source reading cannot establish whether their actual clipping and
hit targets pass. Existing dashboard layout assumptions also need execution
against the integrated UI. No confirmed rendered defect is claimed while the
execution hold is in force.

Exploratory reads found no standalone `WorkspaceReassignDialog.tsx`,
`workspaceReassigned.ts`, `cloudReassignmentNotice.ts`, `dashboardTable.ts`,
`components/Sidebar.tsx`, `components/ConversationList.tsx` or
`layout/CloudWorkspaceNode.tsx` in root. Their actual implementations were
located in the combined files listed above; none was treated as a missing
product prerequisite.


## Rendered startup repair source handoff (2026-11-16)

The `team-rendered-fix-pro133-137-authenticat` worker copied only its 31 owned
current-root paths from `phase-2-pro-120-orchestration-lead`. The earlier
worker/prerequisite paragraphs above describe the original authored suite.
This repair remains source-only and uncommitted; all checks are UNRUN under
the explicit serial allocation hold. Shared native session/harness files are
untouched. The copied native/API transport prerequisites remain held.

The recorded first failure is Mine 2 at startup, before width checks. The
5-second diagnostic showed Mine/Shared disabled with unknown viewer identity;
the later poll populated the exact expected counts. In source, inbox startup
resync increments `inboxRevision`, discards the early feed, and obtains fresh
per-org lists. Those lists do not carry authenticated `viewerUserId` and can
suppress another feed through the freshness gate. Resync now waits for the old
feed flight, then asks for a full feed under the captured account, revision,
generation, privacy and inbox fences. Overlapping resync calls share one task.
Full org lists still run for retention/read-marker recovery. Inbox reading and
receipts remain independent, and existing polling/fallback policy remains.

Authored catalog regressions cover a delayed old feed plus fresh org lists,
concurrent resync coalescing, full-feed viewer/Following/marker recovery,
non-persistence of viewer identity, account/revision/privacy changes, observed
A-B-A generation changes, and clearing a pre-reconnect feed cursor. Existing
retained-marker tests remain intact. They are all UNRUN.

The exact Mine 2 / Shared 1 assertions and acceptance timeouts are unchanged.
The failure catch retains real ARIA/DOM/call diagnostics but no longer invokes
the fixture feed function, which would itself change fixture state.

Source layout review found the 176px Views rail consumed the content width in
narrow main containers. Views now wrap above the table/board below 600px of
actual container width, and the toolbar flex child can shrink/wrap. The outer
268px sidebar also substantially reduces the main width at 390/320px when
left open. Its app-wide navigation behavior has not been rewritten without a
rendered failure; the allocated root window must check the actual clipping and
return concrete remaining failures. No narrow rendered success is claimed.
