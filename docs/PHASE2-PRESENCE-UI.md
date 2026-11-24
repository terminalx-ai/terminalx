# PRO-133 / PRO-137 desktop source continuation

## PRO-133 desktop wave 2 (2026-11-24)

The owner’s Linear audit compared main at `38989a54` with screens 02.01 and
02.05. It recorded missing Owner and Active now avatars, the local Owner cell
showing “This Mac,” and missing filter presence states. On the current base,
the account-and-organization-scoped By menu coexisted with a second global
People picker. The latter used agent state and recent session timestamps as
presence. The overview now has one By menu and uses current workspace presence
for the header and filter when presence is ready. The held dashboard retains its
existing People chip, Active now faces and named Owner cells.

- **02.01 and 02.15.** Owned cloud rows show the current owner’s profile avatar.
  The table offers Owner, Status, and Last active sorting. Owner and Status
  extend the screen per the chief’s decision. Unknown cloud activity stays
  unknown. This Mac’s local rows show You. Paired-machine rows have no cloud
  owner and do not count as Mine.
- **02.04.** Where appears for a presence-ready visible organization even with
  no paired machine. Named sidebar workspace rows expose the teammate profile
  as its own button, up to three faces followed by a count of the rest. The organization header obtains its online count from the
  authorized aggregate.
- **02.05.** By is a searchable multi-select with Anyone reset and per-account,
  per-organization persistence. Each option can show Active when the selected
  organization’s current projection includes the member. Cached workspace ownership
keeps the filter and Owner column usable when the catalog is offline. The five Views use
  the same filtered dataset for rows and counts. Following continues to use
  its independent readiness and current catalog preference.
- **13.25 and 13.14.** The profile dot distinguishes online, known offline,
  and unavailable. The idle and last-active ages and the profile’s named
  activity line are omitted. The presence response supplies current visible
  attachments and has no activity history.

The per-organization `team.presence.v1` readiness remains off by default. The
enabled and held UI tests use the same projection and change only readiness
at the hold. Live acceptance still needs two authorized accounts with
readiness enabled, appearance within 2 seconds, disappearance within 60
seconds of departure or quit, and a private-workspace visibility check. The
design observations above are from the owner's review and current source.

## Earlier source continuation (2026-11-15 and 2026-11-16)

Source only, 2026-11-15. Base `26080f13`. The current owned modified and
untracked files from `team-ui-pro133-137-combined-presence-own-2` were copied
selectively into `team-ui-pro133-137-combined-presence-own-3`; both older
worktrees and the saved wave6 patches remain untouched. The original
`team-ui-pro133-137-combined-presence-own` had no current changes.

The 17:35 decisions in `~/phase2-orch/decisions.md` and
`PRO-133-ui-decisions-needed.md` resolve all six UI differences. They are
implemented here and are not outstanding approval blockers. Exact presence and
follow/reassign contracts in `saas-wave3-accepted-handoff` remain authoritative.
The separate PRO-167 admin transport/UI is not imported or expanded.

## Current flow

The existing dashboard has a searchable multi-select By menu, Anyone reset,
Owner display, current presence in Where, active-member profile triggers, and
Everyone/Mine/Shared with me/Following/Active now views. Owner and status sorts
extend the screen deliberately. Last active for cloud rows uses only
`workspace.lastActivityAt`; absent/invalid values stay unknown. Heartbeats,
workspace update time and TTL expiry never become last-active history.

By choices are stored on this Mac under account + organization keys. Choices
are read from the new key immediately on a scope change and pruned only after
an authorized live catalog response. Local rows count as You in Mine/By only;
remote rows without an owner say Owner unavailable. Local activity never
contributes to cloud presence or the organization count.

Rows and counts share the same search/project/status-filtered authorized
session dataset and By selection. View predicates:

- Everyone retains that dataset, including the existing offline catalog view.
- Mine includes local rows and live-catalog rows whose current `createdBy`
  equals the native catalog's authenticated `viewerUserId`.
- Shared with me includes non-owned live rows with an actual viewer/driver
  `workspace.you` projection. Organization visibility alone does not invent a share.
- Following requires the independent per-account catalog `following === true`.
- Active now requires a live presence response with members on that workspace.
  Running compute and local sessions cannot imply presence.

Unavailable projections disable the corresponding view and show an unknown
count. An already-selected unavailable view shows its unavailable state. The
organization count deduplicates only the authorized aggregate's visible people;
no hidden-workspace count, device count, fabricated local actor or age is shown.
PRO-128's MemberProfile and current roster supply avatar/profile semantics.

Following uses the existing eye header action and a real sidebar section.
The UI waits for the exact preference mutation and authorized catalog refresh;
it never optimistically grants access or applies a historical reassign receipt
as a current owner. The menu admits only the current owner or an organization
owner/admin, not an explicit workspace manager alone. The picker uses the
existing fresh roster, with search, empty-team invitation action and optional
plain-text note. Each explicit retry retains the same request UUID, target,
expected-owner CAS and note. Server refusals are shown without automatic retry.
Private cross-owner transfer stays refused. All bootstrap/runtime grant handovers
remain server-refused; the UI never claims tabs, credentials or sessions moved.
The details card shows the current owner from the live catalog, with unavailable
fallback, without inventing immutable creator or transfer-age history.

Reassigned inbox payloads retain actorId, previousOwnerId and optional note.
Only the notified current owner's freshly reauthorized row may display the
bounded in-memory notice. Account/context/privacy changes clear pending and
visible notices. Notes render as text. Existing receipt/checkpoint, startup and
reconnect marker resync, share-removal purge and poll fallback remain in place.

## Presence lifecycle and transport

Production native constructors retain `phase2_enabled: false`. No setting,
activation header, capability, deployment or global cloud endpoint enablement
is added. The existing readiness mechanism gates desktop boot and preference
controls. Injected PresenceController and WorkspacePreferencesController
transports support local mocked enabled acceptance.

Catalog opts into `presence=1` only behind the existing native gate; exact
`workspace.creator`, item/organization presence and independent Following are
retained. Both gated inbox poll and SSE requests opt into `presence=1` and know
`workspace.presence-changed`, without changing checkpoint ordering. Native
account/profile/org/session fencing and current target membership checks remain
authoritative. Live presence and authenticated viewer identity are not persisted.

An attachment launch has a lowercase UUIDv4 and positive safe increasing
sequence. Heartbeats and watched authorized reads run every 15 seconds, with
immediate hint refresh. Reads/writes have a 10-second client deadline. A failed
read clears display to unavailable; an overdue read clears it to stale. A
successful empty response means known offline, distinct from unavailable,
loading or stale. A changed authorized workspace set clears old visible presence
before a new read. Cached/errored catalogs do not drive watches or attachments.

Disconnect and target switches leave the old launch. Once attempted, a leave
remains pending through errors/Retry-After even if the same target is selected
again; an acknowledged leave retires its UUID. Another attachment starts a new
UUID. Scope generation fences discard late A-B-A reads/writes. Scope loss never
retries old-account authority; undelivered graceful leave uses the server's
45-second TTL. Display refresh/staleness removes expired information without
inventing a last-seen timestamp. Multi-batch reads remain sequential and bounded
at 100 distinct workspace IDs per request.

## Design evidence and deliberate limits

All nine distinct linked screen URLs in `/tmp/phase2-wave6-claims.json` were
opened with the supported TerminalX browser. Several initially returned JSON
Internal Server Error; bounded retries eventually yielded readable content for
all nine. The By and Reassign screens were also inspected as screenshots
(`/tmp/team-ui-by.png`, `/tmp/team-ui-reassign.png`). These are reference reads,
not a rendered comparison or acceptance proof of the authored application.

Deliberate differences: owner/status sorts are ticket-required screen extensions;
there are no idle/last-seen ages, unsupported member eligibility/cap numbers,
profile usage charts or usage API, and no private handover confirmation that
pretends to grant access. The roster picker is an existing dialog flow, rather
than a hover submenu. Owner details have no fabricated “from you, just now”
history. Reassignment confirmation and target notice are UI status, not invented
transcript data; the accepted desktop contract supplies no transcript mutation
or activity-transcript projection. The server owns organization activity writes.
Transferred schedules may be paused for a non-admin run-as, so the UI does not
promise they will run as a plain member. Existing table column/display and
workflow-status semantics remain in use.

## Verification still required

All authored tests are UNRUN under the explicit source-only instruction. No
install, build, typecheck, formatter, test, hook or verifier has been executed.
Required Vitest checks must wait for fresh explicit serial allocation AND
`~/phase2-orch/wave6-team-ui-checks-granted`. The presence lifecycle and picker
regression files should additionally be included in that future allocation.
The native mock regressions are source only in this continuation as well.

No production two-account/two-second rendering, real TTL acceptance, complete
visual parity, or whole-ticket completion is claimed. Older servers/fallback
catalogs without a native viewer identity keep ownership-dependent features
unavailable rather than inferring a user from an email or role. Missing
eligibility, usage/history and transcript contracts remain deliberately absent;
the six accepted UI decisions are not blockers.

## Preserved integration continuation (2026-11-16)

The actual clean prerequisite `3e7bdbecd3608099ed612419afa2b4e0a7002b3c`
in `team-ui-pro133-137-combined-presence-own-3` was inspected with `git show`.
Its exact 25 changed/new owned files were copied into
`team-ui-integration-pro133-137-preserved` at base `26080f13`; earlier worktrees
remain untouched. The root-released `src/lib/cloudInbox.ts` now imports the
canonical `DesktopInboxEvent` as a type and aliases `InboxEvent` to it. This
preserves presence events and the reassignment actor/previous-owner/note payload
through the existing subscriber without a second competing union.

Static review found and corrected these concrete continuation gaps:

- Departure now latches before the presence write's in-flight/backoff guard.
  Returning to the same target cannot cancel a queued leave. The old UUID is
  retired only after leave acknowledgement; the new attachment gets a new UUID.
  Added regressions cover both a pending heartbeat and heartbeat Retry-After.
- The real reassignment picker subscribes to the existing organization roster.
  A removed target disappears and cannot be submitted; roster errors suppress
  the initial member list. Added component regressions cover both paths.
- By selection no longer broadens to Anyone or overwrites the saved choice
  while the roster is loading. Only a successful roster plus live catalog may
  prune absent people. Actual hook/component regressions cover roster removal
  and account/org/A-B-A scope changes.
- Readiness keys include account plus revision. Reassign menu eligibility uses
  the current live catalog row, and unknown current creator identity cannot
  supply the expected-owner CAS, including for organization admins.

The design references were independently reopened in this continuation with
TerminalX's supported browser; all nine produced readable snapshots. By and
Reassign screenshots were inspected at `/tmp/team-ui-integration-by.png` and
`/tmp/team-ui-integration-reassign.png`. This is design-reference inspection,
not an application render or visual acceptance. Existing documented deliberate
screen differences remain: no eligibility/cap fiction, history, transcript or
profile usage API; current owner and current visible presence only.

`CLAUDE.md` is absent both from this worktree and the main checkout root. No
applicable repository-root AGENTS.md was found in the tracked-file listing.
No source outside the assigned owned paths was changed. No provider, native
PTY, shared-session/harness, Admin or production activation code was changed.

### Exact remaining commands — NOT RUN

The current grant name is **wave6-team-ui-integration-checks-granted**, replacing
the earlier continuation's historical grant name. BOTH fresh explicit serial
allocation and that file are required. A file alone is not an allocation.

Required done check, verbatim from this piece:

```sh
test -f "$HOME/phase2-orch/wave6-team-ui-integration-checks-granted" || exit 1
pnpm vitest run src/lib/cloudCatalog.test.ts src/lib/desktopInbox.test.ts src/components/dashboard/AgentDashboard.test.tsx src/components/cloud/WorkspaceActions.test.tsx
```

Supplemental meaningful source regressions, in the same future allocated slot:

```sh
test -f "$HOME/phase2-orch/wave6-team-ui-integration-checks-granted" || exit 1
pnpm vitest run src/lib/cloudPresence.test.ts src/components/cloud/WorkspaceFollowing.test.tsx src/components/dashboard/TeamOverview.test.tsx src/lib/cloudInbox.test.ts
```

Native source regressions also require a separately authorized native allocation:

```sh
test -f "$HOME/phase2-orch/wave6-team-ui-integration-checks-granted" || exit 1
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer cargo test --manifest-path src-tauri/Cargo.toml --lib phase2_presence
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer cargo test --manifest-path src-tauri/Cargo.toml --lib phase2_following_contract
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer cargo test --manifest-path src-tauri/Cargo.toml --lib phase2_desktop_contract
```

Every authored/imported regression remains **UNRUN** in this worktree. No test,
install, build, typecheck, formatter, hook or verifier was run, and no commit was
attempted or hook bypassed under the explicit hold. Source readiness is not
validated acceptance. Two-account timing, real runtime behavior, full rendered
composition and visual parity still require the lead's allocated validation.
