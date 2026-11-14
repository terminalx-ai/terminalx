# PRO-248 wave 1 evidence

Date: 2026-11-14. Branch: `raccoon/pro-248-try2-pro-248-shared-team-ui-comp`.

## Reconciliation

Read `git diff HEAD...raccoon/pro-248-pro-248-shared-team-ui-component`
before editing, then selectively copied its twelve owned paths. Also read the
original avatar/popover source and compared the examples and other owned paths
against `origin/raccoon/pro-248-team-design-components`. No merge or cherry-pick
was used. Current `ui/button.tsx`, `ui/dialog.tsx`, menu, token CSS, contrast helper
and test setup informed reconciliation. Prior execution logs are not this run's
evidence.

The earlier fixture did not gate followed-workspace navigation or desktop
reconnect. Regression coverage also found ungated automation history,
organization-selection callbacks and retries. These now reflect `canAct` with
native disabled controls and a callback guard at the example boundary. Tests
exercise authority initially denied, granted and revoked, and a synthetic change
on a disabled select. Local filtering, disclosure and focus exit remain usable.

## Commands run in this worktree

- Initial required targeted test attempt: exit 254 (`vitest` missing).
- `pnpm install --frozen-lockfile`: exit 0; no manifest/lockfile edits.
- Expanded regression suite before the fix: exit 1, 14 failed / 117 passed. Both
  reported review failures reproduced, along with the related action gaps above.
- First suite after the fix: exit 0, 131 passed.
- First `pnpm exec tsc --noEmit`: exit 2 because a new test passed an unsupported
  `exact` option to `getByRole`; removed that redundant option.
- Final `pnpm exec tsc --noEmit`: exit 0.
- Final `pnpm vitest run src/components/ui/teamPrimitives.test.tsx src/demo/TeamSurfaceExamples.test.tsx`:
  exit 0, 2 files and 131 tests passed.
- `git diff --cached --check`: exit 0; staged changes contain only the twelve
  owned paths.

Vitest reports an existing duplicate `test:webkit-orchestration` package script
warning. `package.json` is outside this piece's scope and was left untouched.

## What the tests establish

Avatar fallback and no-referrer, explicit unknown/decorative presence, stack
bounds/accessibility, no domain IDs leaked to DOM IDs, passive/interactive chip
semantics, popover labels/Close order/autofocus/Escape/outside-focus dismissal and
return focus, disabled retry and live status/alert semantics. Theme tests check
strong/muted ink on the page/card/well/muted surface token pairs, all eight
supported theme-mode combinations (Ember shares a block), with 4.5:1 text and
3:1 foreground focus thresholds.

Examples cover ten ready recipes and fifty unavailable-state recipes, explicit
caller-gated actions, absent billing data, mounted content/photo/contact removal
on offline and revocation, safe profile focus after revocation, Share scope and
recipient changes, draft retention/discard, ports lifecycle, automation filter
and menu, and local desktop Tab/Escape behavior. These are DOM and token checks,
not native or rendered-browser certification.

## Inaccessible sources

Direct web-tool reads failed for all nine supplied design URLs:

- https://p.superdesign.dev/draft/53dd4e0d-4d1a-4ec2-baa8-b86fc837d259
- https://p.superdesign.dev/draft/7d196912-1297-459d-88a1-f69fd564cb23
- https://p.superdesign.dev/draft/5019eb75-4d85-4db7-a8c5-8fe438150448
- https://p.superdesign.dev/draft/53051cfa-7c60-4e9b-9c3a-c4c944e839a8
- https://p.superdesign.dev/draft/4b3ee652-a092-47c9-b1af-bd3cbe306a35
- https://p.superdesign.dev/draft/e48b5636-73c4-4641-af64-b59331aeb964
- https://p.superdesign.dev/draft/9bb66fc1-d600-4957-aa7f-2335d90517f9
- https://p.superdesign.dev/draft/3710ec6a-b1a6-4600-bfe8-e668170c7185
- https://p.superdesign.dev/draft/30691229-f68c-41a5-a9d2-88e716b38d5f

No design content, screenshot or parity result is inferred from those failures.
The profile discrepancy comes from the supplied ticket review, not an independent
inspection of screen 13.14.

## Outstanding acceptance criteria and owners

- Owner-approved designs for all listed surfaces/states: not obtained. Approval
  before already-started tickets cannot be established by this foundation.
- Profile page versus popover: design/PRO-128 owner decision required; affected
  production UI work deferred. Provisional fixture does not settle it.
- Match to reference layout, spacing, labels and states: not verified. Explicit
  recipe simplifications are in TEAM-SURFACES.md; owner screen review remains.
- Full accessibility pass: DOM focus/labels and token contrast tested, but actual
  browser Tab/Shift+Tab, computed contrast/control boundaries, layout/zoom and
  assistive technology review remain. No screenshot evidence is claimed.
- Production integration, saas contracts, rollout/privacy gates and native/macOS
  certification remain with the lead/feature owners. No CloudCollab or existing
  profile integration edits and no full-ticket completion claim.
