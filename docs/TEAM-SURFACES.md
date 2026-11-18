# Shared team surface foundation (PRO-248)

Phase 2 wave 1 is a standalone presentation handoff, proposed for review. It is
not full ticket completion or owner-approved design. Selectively reconciled from
`origin/raccoon/pro-248-team-design-components` via the owned files on
`raccoon/pro-248-pro-248-shared-team-ui-component`; no branch merge or cherry-pick.

## Scope and use

- `ui/avatar.tsx`: passive Avatar, AvatarStack and PresenceDot. Names/statuses
  remain accessible when faces overflow. Photos are optional, use no-referrer,
  fall back on failure, and disappear when the caller stops supplying a URL.
- `ui/chip.tsx`: passive Chip and ref-forwarding native ChipButton, defaulting to
  `type=button`. Separate mention removal from the profile trigger.
- `ui/popover.tsx`: Radix popover with required visible name, close control,
  collision padding, bounded scrolling and existing menu-layer token. Close is
  first in focus order; Escape/Close return focus; outside focus dismisses.
- `ui/SurfaceState.tsx`: section anatomy and empty/loading/error/no-access/offline
  messages. Status updates are polite, errors are alerts, retry is explicit and
  disabled during loading. Actions are outside the live region.
- `demo/TeamSurfaceExamples.tsx` and `teamSurfaceStates.ts`: ten ready recipes
  and fifty unavailable-state messages. Data, state and action admission are
  explicit inputs. No store, credentials, transport or production integration.
- `team-design.html` and `demo/teamDesign.tsx`: development fixture using the
  existing app CSS, tokens and body theme attributes. It is not a build entry or
  product navigation item. Inputs stay in memory and callbacks report preview
  actions; they do not copy, save, navigate, connect or launch paid work.

Run `pnpm dev --port 1428`, then open `/team-design.html`. Choose a state and
light/dark mode. Enter local review labels to populate ready examples, four names
for stack overflow, and long Unicode labels to review wrapping. Optional details
supply returned profile, billing and schedule values. Ports require distinct
workspace/local numbers and a forwarding state. An empty plan never implies Free.

Components reuse current `bg-well`, card/popover, foreground/muted foreground,
semantic presence colors, hairlines, button sizes and `--z-menu`. There are no
new global styles, dependencies or theme values. Presence is also conveyed in
words; dot colors alone never carry status. Motion uses `motion-safe` variants.

## Authority and privacy contract

The caller must gate reads, subscriptions, photo URLs and actions by current
account, organization, privacy policy and feature availability. These primitives
cannot establish authorization. Do not derive online status from a photo, billing
access from a plan badge, sharing from organization visibility, or desktop input
from presence. Explicit unavailable state takes precedence over supplied ready
data. The owning feature must also clear old data when changing account/scope.

`canAct` gates every example callback, including workspace navigation, automation
runs/history/organization selection, reconnect and retries. Controls reflect the
current value with native disabled semantics, and the callback boundary also
checks it. Local preview disclosure, filtering, tab changes, focus and dismissal
remain usable without action authority. This single fixture flag does not replace
the separate read, send, approval and desktop-input permissions in production.

Profile, mention, presence, billing, automation, ports and desktop recipes remove
protected ready content on offline/no-access. An open profile whose focused action
is removed moves focus to Close. No unavailable state automatically retries work.

The local Share example keeps an unsaved draft through error/offline with edits
disabled, confirms dirty dismissal, clears on revocation or organization/workspace
change, and binds choices to recipient ID across reorder. A confirmed removed
recipient clears choices and requires explicit reselection; transient loading does
not transfer permissions. This illustrates a draft lifecycle, not server rights.
No Share save or rollback behavior is implemented. General access and Admin remain
disabled pending owning contracts. Sending and permission approval are separate.

## Surface handoff and deliberate limits

| Surface | Foundation recipe | Integration/design work remaining |
| --- | --- | --- |
| Presence | Stack, full list and status words | PRO-133 authoritative presence/typing, privacy and refresh; existing CloudCollab untouched |
| Profile | Provisional compact details, permitted returned fields | Owner must choose full page versus popover; PRO-128 integration untouched |
| Mention | Named chip trigger, separate remove, detail preview | Picker, notification/refusal and composer focus belong to PRO-141 |
| Following | Named workspace row and unfollow callback | PRO-137 confirmed follow state, access and removal focus |
| Share | Levels, separate approval, disabled general access, review/discard lifecycle | Existing CloudShareDialog remains owner; PRO-167/171 server rights, general access and batch save |
| Onboarding | Ordered shell, current step, Back/next actions | PRO-191 actual six-step Cloud setup; fixture uses three illustrative steps |
| Billing | Returned plan, seats, payer, next charge | PRO-178/182 real payer/seat rules, checkout and capabilities |
| Automations | Organization/filter, metadata card, local menu | PRO-225 real page, table/responsive review, delete/run-failed notifications and execution contracts |
| Ports | Workspace/local address, forwarding state, disabled automatic toggle | Existing CloudPorts and PRO-223 transport/watcher/actions |
| Desktop | Local tab shell, viewport slot, explicit Escape focus exit | PRO-206 actual VncView, viewer transport, remote capture and input authority |

### Outstanding profile decision

The ticket requests a profile popover, while its 2026-11-10 review says screen
13.14 is a full page (`Overview / Aisha Khan`) with activity charts. This changes
what gets built. The inherited compact profile recipe is retained only to exercise
the generic popover primitive and privacy transitions, visibly labelled provisional.
Affected production layout/activity work is stopped pending the design owner and
PRO-128 owner decision. Do not treat this example as a decision or replace the
existing profile integration. No owner approval was obtained in this work.

### Screen parity and approval

The supplied references are 13.01 presence, 13.14 profile, 13.03 mention, 13.07
Share, 12.01 Cloud setup, 12.15 Billing, 08.08 Automations, 14.10 Ports and 14.13
Desktop. Direct reads of all nine references were inaccessible through the web
tool. No visual match to these screens is claimed. The table
above records intentional foundation simplifications, including profile container,
three-step onboarding, card-style automation row, disabled general access and a
placeholder desktop viewport. Exact spacing, labels and states require design
review against accessible originals before integration; they are not approved.

## Acceptance and validation boundaries

`pnpm vitest run src/components/ui/teamPrimitives.test.tsx src/demo/TeamSurfaceExamples.test.tsx`
checks labels/semantics, DOM focus and dismissal, explicit retries, draft binding,
privacy transitions, all ten surface state recipes, and token contrast. Contrast
uses the repository color conversion against current token values: normal text
at least 4.5:1 and foreground focus at least 3:1 on page/card/well/muted surfaces
across every supported theme mode. It is not computed browser contrast evidence.

Before accepting the full ticket, owners still need approved designs for every
surface/state, the profile decision, screen comparison, real keyboard Tab and
Shift+Tab paths, 200% zoom and 390×844/1280×800 light/dark layout review, computed
contrast including control boundaries, reduced-motion review, integrated privacy
and authority tests, and native certification. jsdom cannot certify those. No
saas, CloudCollab, existing profile integration, global CSS, package.json or
MacBook PRO-128 files are modified. See TEAM-SURFACES-EVIDENCE.md for this run.
