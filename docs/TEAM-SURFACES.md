# Organization and team surface handoff (PRO-248)

This is a concrete component and design handoff for the ten surfaces in
[PRO-248](https://linear.app/procyonlabs/issue/PRO-248/design-pass-for-the-new-organisation-and-team-surfaces).
It is **proposed for product/visual approval**, not a record of approval. Several
feature owners started before this work. The acceptance requirement that approval
precede every ticket start cannot be satisfied retroactively. Owners must reconcile
this handoff at integration; independent source review is not user design approval.

## Review artifacts and scope

- `src/components/ui/avatar.tsx`: Avatar, AvatarStack, PresenceDot.
- `src/components/ui/chip.tsx`: passive Chip and native ChipButton.
- `src/components/ui/popover.tsx`: named Radix popover with close/return focus.
- `src/components/ui/SurfaceState.tsx`: state messages and section anatomy.
- `src/components/ui/teamPrimitives.test.tsx`: meaningful interaction regressions.
- `src/demo/TeamSurfaceExamples.tsx`: executable composition recipes for all ten
  surfaces, with explicit data, state and action authority.
- `src/demo/teamSurfaceStates.ts`: all 50 non-ready state messages, typed by surface.
- `team-design.html` and `src/demo/teamDesign.tsx`: development-only review fixture,
  following the existing `demo.html` convention. Not linked from product navigation;
  Vite's production entry remains `index.html`. No customer data, remote requests,
  credentials, paid actions or persisted preview values.
- Existing `CloudCollab.tsx` adopts Avatar and Chip while retaining participant
  initials, typing rings, role descriptions and access decisions. No new presence
  source, permission rule or photo request is introduced there.

Run `pnpm dev --port 1428`, then open `/team-design.html` in the TerminalX browser.
Choose a state and appearance. Ready identity/list examples require labels entered
in the review controls; they otherwise show their actual empty design. Enter four
names on separate lines to inspect stack overflow; use a long name and workspace
label to inspect wrapping. These are local reviewer inputs, not shipped fake data.
Expand “Optional returned details” to supply profile, billing and automation fields.
Supply distinct workspace/local ports and choose the returned forward state. The
automation filter/menu and workspace tab shell are interactive local designs.
Share keeps local choices through offline/error, disables writes while disconnected,
confirms dirty dismissal, and clears choices on scope/access loss.
Enable “Caller allows preview actions” to inspect enabled controls. Every action
reports “Preview action”; it performs no copy, navigation, billing or access mutation.
The desktop viewport is an explicitly labelled integration slot, not a fake desktop.

## Inventory before implementation

| Existing foundation | Reuse and constraints |
| --- | --- |
| `styles/tokens.css`, `styles/app.css` | Geist/Geist Mono, body-scoped `data-theme`/`data-mode`, surface/ink aliases, `border-hairline`, `bg-well`, `text-muted-foreground`, semantic accent tokens. Do not invent hex colors or per-surface themes. |
| Typography and spacing | Existing 13.5px body; text-sm headings, text-xs descriptions, 11px chips/compact labels. Use gap-1/2/3/4, p-3/p-4; section rounded-xl, overlays rounded-lg, native Button sizes. Numbers/ports use mono or tabular numerals. |
| `ui/button.tsx`, `ui/controls.tsx` | Native buttons, labelled controls, existing sizes and variants. A disabled control needs an adjacent explanation; no tooltip-only refusal. |
| `ui/dialog.tsx`, `ui/menu.tsx`, `ui/tooltip.tsx` | Radix focus/dismissal; pinned dialog lists and bounded scrolling. Layer scale: overlay 90, dialog 91, menu/popover 100, tooltip 110, toast 120. New Popover uses `--z-menu`, collision padding 8, viewport max width and available-height scrolling. |
| `issues/People.tsx`, `IssueCommentThread.tsx`, `account/AccountAvatar.tsx` | Existing domain-specific avatars, fallback initials and `PeoplePicker`. Do not rewrite issue pickers or PRO-128's profile implementation. New neutral Avatar exposes explicit identity/photo/presence, no roster fetch. |
| `cloud/CloudCollab.tsx` | Existing ParticipantsBar/PresenceAvatars, current workspace `collab/1`, typing ring, AccessChip, locks and permission explanations. Being present does not imply approval authority. Organization-wide presence remains PRO-133. |
| `cloud/CloudShareDialog.tsx` | Existing server-refreshed sharing, creator/manager distinction, viewer/driver plus approval, private/organization visibility, stale requests and outcome-unknown handling. Keep these behaviors and saved user content. |
| `ui/Toasts.tsx` | Existing polite `role=status`, dismiss button, notices store and click-to-open. Reuse notification delivery; do not create another toast bus. Its existing clickable container does not provide a keyboard Open action: PRO-223 must add a real Open button for its actionable toast, not copy that limitation. |
| `account/RelayStatus.tsx`, issue popovers | Radix is already installed. The new shared wrapper standardizes bounded layout and keyboard close; hover-specific relay behavior stays with its owner. |
| `cloud/CloudPorts.tsx`, `computer/VncView.tsx`, `cloud/CloudSchedulesDialog.tsx` | Reuse the actual transport/viewport/schedule owners; this ticket does not implement another ports service, VNC stack or scheduler. |
| Preview/test conventions | Existing browser-only `demo.html` and `scripts/webkit/*`, React Testing Library, Vitest/jsdom. No Storybook/catalog framework found; add the smallest matching HTML entry. Real visual checks use TerminalX browser only in this workflow. |

## Shared component contract

All components are presentation only. A feature supplies **explicit data, state and
authority**, scoped to the current account and organization. Never substitute a plan,
role, online status, share default or capability when a response is missing.

```tsx
// The owner has already checked scope, privacy, rollout and access.
<Popover>
  <PopoverTrigger asChild>
    <ChipButton aria-label={`View profile for ${person.name}`}>
      <Avatar name={person.name} photoUrl={allowedPhotoUrl} decorative />
      <span>{person.name}</span>
    </ChipButton>
  </PopoverTrigger>
  <PopoverContent label="Profile">
    {profileState === "ready" ? permittedProfileContent :
      <SurfaceState {...profileMessage} />}
  </PopoverContent>
</Popover>
<Chip>{capabilities.planLabel}</Chip>
<AvatarStack people={authorizedParticipants} label="In this workspace" max={3} />
```

`Avatar` is passive; `decorative` removes duplicate names beside visible text.
`photoUrl` is optional and must already be allowed by the caller's privacy policy;
no photo URL is derived from email. Failed images fall back to initials; a different
URL is eligible to load. `presence` omitted means no claim; `unknown` is explicitly
“Presence unavailable”. Standalone PresenceDot has an accessible name. In a list,
show presence words next to it: color alone is insufficient. `AvatarStack` limits
visible faces but includes every authorized name/status in its accessible name.
For keyboard/sighted access to overflow names, pair it with an actual People
popover/list as in the presence composition; do not rely on the native title.

Chip is noninteractive. ChipButton is a real button, defaults to `type=button`,
forwards its ref for Radix, and accepts normal button/ARIA props. A mention's
removal control is a separate button, never a button inside a chip button. A plan
badge cannot grant billing authority. Labels wrap instead of hiding critical text.

PopoverContent requires a visible `label`, which names its dialog. It is nonmodal
unless its owning Root explicitly chooses otherwise. Its first focus target is
Close, followed by content actions. Escape/Close return to the trigger; moving
focus outside dismisses and retains the new focus. Radix manages placement and
portal focus. Do not override autofocus/dismiss handlers without a feature test.

SurfaceState owns no fetch, retry or permission calculation. `loading` is a polite
status with a reduced-motion-aware spinner; `error` is an alert with an optional
explicit retry; actions stay outside the live region. For initial loads use it in
place of unknown content. During refresh keep **still-authorized** content and its
focus in place, with a separate loading message. On revocation unmount protected
content immediately; never retain it as a dimmed disabled panel. For forms, keep
the local draft across recoverable error/offline states, clear sensitive state on
account/organization/authority changes, and never auto-resubmit on reconnect.

State precedence in owning features: revoked/no access → unavailable capability
or privacy gate → offline → loading/error → empty/ready. An empty list is only
empty after a successful authorized response. Never turn a forbidden/not-found
response into a “create your first…” invitation or expose counts/names from another
scope. Server refusals and unknown mutation outcomes override optimistic UI.

## Ready layouts, narrow layouts and keyboard paths

“Normal” review size is 1280×800; “narrow” is 390×844, with a second 200% zoom pass.
Both use the same body tokens in light and dark. No breakpoint changes permission
or drops an action. Rows wrap, then stack; labels/values break within min-w-0
containers. Long lists scroll inside the existing pinned-dialog area. Menus and
popovers flip within the viewport rather than extending outside it. No new fixed
pixel heights for user content. No hover-only essential content.

| Surface / owner | Ready anatomy and interaction | Narrow + keyboard path |
| --- | --- | --- |
| Avatar stack / presence — PRO-133 | Up to 3 faces, overflow count, typing indicator separate from online state. People list exposes full names and status words. Current workspace presence stays in CloudCollab. | Compact stack stays in header; details wrap in a bounded popover. Tab to People trigger → Enter/Space → Close → participant actions; Escape returns. Passive faces add no tab stops. |
| Profile — PRO-128 | Avatar/name, organization, permitted role/contact/join date only when returned, labelled copy controls. Never replace missing details with invented dates or emails. | Popover caps at viewport minus 16px. Close first, then copy and permitted profile actions; Tab can leave; Escape returns. Text remains readable for long/unicode names. |
| Mention — PRO-141 | People first, then files in existing composer picker; name/avatar chip in draft and transcript. Chip opens profile, separate Remove in editable draft. Person identifier metadata is distinct from plain text delivered to the agent. | Picker Arrow keys/Enter choose, Escape leaves draft unchanged. Tab reaches profile/remove; remove returns focus to composer insertion point. Unresolved identities retain plain-text attribution, not a broken button. |
| Following — PRO-137 | Named Following section; workspace title, existing access/lifecycle chips, explicit Unfollow. Header Follow toggle has `aria-pressed`. Reassign stays in workspace menu with target/access/cap confirmation. | Single-column rows; title/action wrap. Tab section header/toggle → workspace links → row actions. Removing focused row focuses next row or section header and announces removal. Following never grants access. |
| Share — existing + PRO-167/171 | Dialog title/workspace, individual/group rows, labelled levels, independent approval grant, General access, review footer. Batch draft and diff belong to PRO-171; only server-confirmed rights are presented as saved. | Use `DialogContent layout=pinned` + named DialogScrollArea for long rosters. Focus close/first control consistently, then rows/general access/review footer; Tab contained, Escape restores opener. Dirty close must confirm discard; refusal keeps draft and focuses inline error. |
| Onboarding — PRO-191 | Full-window shell, ordered step navigation with `aria-current=step`, one named task per page, preserved progress, Back and next meaningful action. Use the owner's actual step list; fixture is shell anatomy only. | Steps wrap to compact progress; actions stack without covering fields. On step transition focus heading; invalid submit focuses first invalid field. Back preserves input, closing an unsaved step asks before discard. No setup read starts paid compute. |
| Plan/billing — PRO-178/182 | Account plan chip from capabilities; billing page has organization, seats, payer and next charge only when returned. Format currency/dates with Intl and actual currency/period. Authorized console link is distinct from passive badge. | Label/value rows stack. Tab to billing link only if returned/authorized; native navigation supports keyboard. Return/refresh announces confirmed plan change. Missing/unknown is never Free. |
| Automations — PRO-225 (+228/231/233) | Organization selector/filter, rows with Run, Runs, Last run, Next run, Author, Created, Actions. Trigger kind visible in words; GitHub/webhook details remain with owners. Secondary menu: Edit, Duplicate, Copy link, pause/resume/delete as allowed. Runs need state/cost/readiness. | Wide table becomes named cards retaining every field/action; fixture uses the narrow-safe card anatomy. Tab filter → row links → Run/menu; menu arrows/Escape; edit uses existing form, Cmd/Ctrl+S only while form owns focus. Keep history on edit; duplicate paused. Re-consent before costs. |
| Ports — CloudPorts + PRO-223 | Header Forward ports trigger, local/remote port, forward state, Open and Stop, automatic forwarding toggle only when supported. Toast uses real Open and Dismiss buttons. No public preview URL. | Address wraps; row actions remain visible. Trigger Enter/Space, Close first, then toggle/Open/Stop; Escape returns. Cmd+Y scoped to workspace, never while text input owns it. A stopped forward cannot retain a working-looking link. |
| Cloud desktop — PRO-206 | Existing tab strip semantics; toolbar connection status, view-only/input authority, reconnect and exit-capture control; VncView fills remaining space. View-only status is visible; no pointer/keyboard forwarding without explicit runtime authority. | Toolbar wraps above viewport; fit/scale owned by VncView. Arrow keys in tab strip, Tab into local controls, explicit enter/exit remote capture. Local Escape exit path must work without trapping keyboard; return to exit-capture control. Stale frame must be cleared/covered on access loss. |

Every surface's five non-ready designs follow below. These are the exact strings
used in the executable fixture. Dynamic names should be interpolated only after
scope checks. Feature-specific recovery actions follow the text; the shared layer
does not invent an endpoint or retry an unknown mutation.

### Avatar stack and presence states

| State | Message | Explanation |
| --- | --- | --- |
| empty | No one else is here | Other participants appear when they open this workspace. |
| loading | Loading participants… | Checking who is in this workspace. |
| error | Could not load participants | Try again to refresh presence. Workspace content is unchanged. |
| no-access | Participants are unavailable | You no longer have access to this workspace. |
| offline | Presence is unavailable offline | Reconnect to see who is here. A previous connection does not mean someone is online. |

### Profile popover states

| State | Message | Explanation |
| --- | --- | --- |
| empty | Profile unavailable | This person may have left the organization. Their messages stay in the conversation. |
| loading | Loading profile… | Checking this person's details. |
| error | Could not load this profile | Try again. The conversation is still available. |
| no-access | You cannot view this profile | Only details shared with your current organization are available. |
| offline | Profile is unavailable offline | Reconnect to load current details. Previously loaded private details are not shown here. |

### Mention chip states

| State | Message | Explanation |
| --- | --- | --- |
| empty | No people match | Try another name, or continue writing your message. |
| loading | Loading people… | Your message stays in the composer while people load. |
| error | Could not check this mention | Your draft is saved here. Try again before sending a mention notification. |
| no-access | This person cannot watch this workspace | Share it with them first. No mention notification has been sent. |
| offline | Mention not sent | Your draft stays here. Reconnect to check access and send it. |

### Following states

| State | Message | Explanation |
| --- | --- | --- |
| empty | You are not following any workspaces | Follow a workspace to keep it in this section. Following does not change access. |
| loading | Loading followed workspaces… | Checking your following list. |
| error | Could not load Following | Try again. Your saved following list has not been changed. |
| no-access | Workspace access ended | It is no longer available here. Ask its creator or an organization admin for access. |
| offline | Following is unavailable offline | Reconnect to refresh the list. Follow and unfollow changes wait for a confirmed connection. |

### Share dialog states

| State | Message | Explanation |
| --- | --- | --- |
| empty | Only people with existing access | No additional people are invited. The creator and organization managers retain their existing rights. |
| loading | Loading access… | Checking who can see and change this workspace. Changes are unavailable until this completes. |
| error | Could not confirm access changes | Check the current access list before trying again. An unanswered request may already have changed access. |
| no-access | You cannot change access | Ask the workspace's creator or an organization admin. Existing access is shown only when the server allows it. |
| offline | Access cannot be changed offline | Your unsaved choices stay in this dialog. Reconnect, refresh access, then review them before saving. |

### Onboarding shell states

| State | Message | Explanation |
| --- | --- | --- |
| empty | Set up your organization | Connect the services you want to use. Starting a workspace is a separate step. |
| loading | Checking setup… | Reading the current setup. This does not start a workspace. |
| error | Setup could not be checked | Your completed steps are kept. Try this step again. |
| no-access | An organization admin needs to finish setup | You can return to your work while an admin connects the required services. |
| offline | Setup is unavailable offline | Keep this window open or return later. Completed steps are kept. |

### Plan badge and billing states

| State | Message | Explanation |
| --- | --- | --- |
| empty | Plan details are unavailable | No plan has been returned for this organization. This does not mean it is on a free plan. |
| loading | Loading plan… | Checking the current plan and billing details. |
| error | Could not load billing details | Try again. This does not confirm a change to your plan or payment. |
| no-access | Billing details are restricted | Ask an organization admin for help with billing. A plan badge does not grant billing access. |
| offline | Billing is unavailable offline | Reconnect to check the current plan before making a billing change. |

### Organization automations states

| State | Message | Explanation |
| --- | --- | --- |
| empty | No automations to show | Automations you can access appear here. Clear a filter if you expected to see one. |
| loading | Loading automations… | Checking runs and schedules. This does not start a run. |
| error | Could not load automations | Try again. Do not repeat Run now until the outcome of the previous request is known. |
| no-access | Automations are unavailable | Ask an organization admin for access. Private automation details are not shown. |
| offline | Automations are unavailable offline | Reconnect to check runs. Run, edit, pause and resume are unavailable until access is confirmed. |

### Ports popover states

| State | Message | Explanation |
| --- | --- | --- |
| empty | No ports are forwarded | Start an app in this workspace, then choose a listening port to forward. |
| loading | Loading ports… | Checking listening ports without starting the workspace. |
| error | Could not forward this port | Check the connection and local port availability, then try again. |
| no-access | You cannot forward ports | Forwarding needs permission to use a terminal: a manager, or a driver who can approve permissions. |
| offline | Port forwards have ended | They closed with the connection. Reconnect to the workspace before opening them again. |

### Cloud desktop tab states

| State | Message | Explanation |
| --- | --- | --- |
| empty | Desktop is not running | Open the desktop when you need it. The owning feature must explain any workspace start and cost before starting it. |
| loading | Connecting to the desktop… | Waiting for the workspace. You can leave this tab while it connects. |
| error | Could not connect to the desktop | Try reconnecting. The workspace's other tabs are still available. |
| no-access | Desktop access is unavailable | You need access to view this workspace. Input requires the desktop's separate edit authority. |
| offline | Desktop disconnected | Reconnect to continue. Keyboard and pointer input are stopped while disconnected. |

## Copy and recovery details

Use TerminalX's existing sentence case and direct second-person copy. Say what
happened and the next safe action. Use “Loading…”/“Connecting…” with an ellipsis;
never “Success!” for an unconfirmed write. Status and permission are separate:
“Connected” does not mean “Can send”; “Can send” does not mean “Can approve”. A
failure remains inline beside the control even if a toast also appears. Keep
user-authored prompts/names intact; do not normalize, translate or silently truncate
saved values. Technical identifiers/addresses remain selectable where useful.

- Presence refresh: do not announce every heartbeat or mark stale people online.
- Profile: no-access/offline removes cached contact fields and copy controls;
  retain only already-authorized transcript attribution outside the popover.
- Mention refusal: use `<name> can't watch this workspace. Share it with them
  first.` beside the draft, with Share only if actual sharing authority allows it.
  No message text goes to the server; metadata delivery awaits PRO-141's contract.
- Follow failure: keep the confirmed toggle state, explain refusal inline, do not
  move rows optimistically on an unknown result. Reassignment confirms private
  visibility, target access/cap, schedules' run-as, and loss of personal routes.
- Share failure: keep unsaved choices locally, mark changed rows and refetch before
  offering another save. Never claim failed rollback. Preserve last-admin refusal,
  credential restrictions and unknown-outcome copy in existing owners.
- Onboarding: retain completed steps and explain which step failed; credential
  entry/reauthentication stays in PRO-200's own flow. Do not echo secrets in alerts.
- Billing: pending checkout means “Checking plan…” until capabilities confirm it;
  a failed refresh is not a declined payment. Member-limit refusal preserves the
  pending invite. Proration copy appears only when the actual billing contract
  confirms that removal reduces a paid seat; no guessed prices or plan limits.
- Automations: readiness refusal uses `Automation isn't ready: <reason>`. Unknown
  run outcome disables repeat Run until a lookup resolves it. Never expose prompts,
  webhook secrets or private workspace identity in unauthorized rows/errors.
- Ports: error belongs to its port; retain other valid forwards. Reconnect does
  not resurrect an expired local address. Respect Connections strategy/range and
  PRO-223's ephemeral-port exclusion; no new watcher is implemented here.
- Desktop: loading/reconnect is announced once per phase. A viewer can watch only
  after PRO-206 supplies a distinct authorized viewing transport. Existing ports
  authority does not allow viewer access; do not relax it to fake the new design.

## Decisions and dependencies that remain explicit

| Decision / owner | Concrete options for product review | Safe integration boundary |
| --- | --- | --- |
| PRO-167 Everyone default | A: default Read (recommended); B: require explicit Read/Write choice every time. Both require explicit opt-in to Everyone. | Current organization visibility only reveals existence. Neither option is implemented by this handoff. Do not preselect Everyone or synthesize a default role. |
| PRO-167 unattended Write | A: disallow Everyone Write when tabs run without approval; B: allow only after a specific warning and confirmation naming the organization and ability to run commands. | Product/security review must choose. Keep Write disabled until the server supports and authorizes the chosen rule. Approval grants remain separate. |
| PRO-178/182 payer model | A: retain personal Pro and offer organization-paid seats; B: organization payer after explicit migration opt-in. | Requires billing-owner/Polar evidence on quantity, proration, cancellation and mixed-license migration. Render returned plan labels only, no invented checkout or plan limits. |
| PRO-206 viewer desktop | Separate view-only transport versus stricter existing ports authority. | Pending runtime/API contract; existing `ports.list/open` stays manager or approval-capable driver. No viewer write fallback. |
| PRO-252 / PRO-244 | Foundation rollout flags and privacy policy are authoritative and remain unmerged as of this handoff. | Owning feature gates its reads, photo loads, event subscriptions and actions; missing/off flags and privacy restriction fail closed. These presentation components do not start network activity. |

PRO-128 owns roster/profile, PRO-171 sharing groups and batch changes, PRO-191
onboarding, PRO-200 login, PRO-212 workspace details and PRO-215 SSH. Integrate these
shared presentation pieces in those existing modules after owner reconciliation;
this ticket does not edit their worktrees or replace their feature implementations.
PRO-231 and PRO-233 own trigger/API/console behavior; their pending source/contracts
are not assumed landed. Pending work: PRO-133 presence, PRO-137 Following,
PRO-141 mentions, PRO-167 sharing levels, PRO-178/182 billing, PRO-206 desktop,
PRO-223 ports and PRO-225 automation page. No server work or SQL is part of PRO-248.

## Accessibility and evidence checklist

Source intent is testable, but is not a rendered accessibility pass. Use the real
fixture and the integrated feature after actual host recovery. Record viewport,
mode, exact SHA/tree, test command, exit code, screenshot path and reviewer for
anything marked complete. Screenshots must come from rendered UI, never source.

| Check | Concrete verification |
| --- | --- |
| Names / semantics | Every button/control has a visible or accessible name. No nested interactive controls. Passive chip/avatar does not add focus stops. Profile and ports popovers have labelled dialogs. |
| Focus | Keyboard Enter/Space opens, Close is first, subsequent actions follow visual order, Escape restores opener. Tab leaving nonmodal popover keeps outside focus; modal Share contains focus. Repeat with long content and nested mention/profile. |
| State updates | Loading polite status, errors alert, no autofocus on refresh. Focus stays on a retry/field across response when possible. On revoked authority remove sensitive content and focus a safe explanation/control. |
| Contrast | Measure computed foreground/background at each token use in den light/dark, then smoke other supported palettes. Target 4.5:1 normal text and 3:1 meaningful graphical boundaries/focus. Presence words carry state independent of dot color; do not claim source token names prove contrast. |
| Layout | 1280×800, 390×844 and 200% zoom; long unicode labels, four-person overflow, scrolling Share. No clipped close, actions, focus outline or horizontal page scroll. |
| Motion | Emulate prefers-reduced-motion: new popover animation and loading spinner stop. Existing dialog overlay motion is an integration check; no claim that all legacy animations already honor reduced motion. |
| Regression | Cloud participants preserve initials and typing, legacy access chip meanings remain; existing cloud/people/sharing tests plus new primitives/copy-state tests. |
| Privacy / permissions | Change scope while open; revoke access; offline with previous data. No stale profile/share/ports/desktop content, no photo fetch without supplied URL, no automatic mutation retry. |

Completed and outstanding execution evidence is kept in
`docs/TEAM-SURFACES-EVIDENCE.md`. Product approval remains an explicit human review
of all ready/state designs and the decisions above. Source review can accept code
quality while that approval and actual visual/native gates remain outstanding.
