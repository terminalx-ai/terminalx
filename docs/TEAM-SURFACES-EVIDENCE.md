# PRO-248 evidence and approval record

Review base: `0656e725da564ba1f1838dd79a2d96b52f96192e`, fetched from `origin/main`
on 2026-11-07. This file records scope and limitations; exact frozen tree/patch
hashes and subsequent review results live in the coordination artifacts below.

## Available evidence

| Item | Result and limit |
| --- | --- |
| Repository inventory and contract reconciliation | Read tokens, typography, dialog/menu/tooltip, avatars/PeoplePicker, Toasts, CloudCollab, CloudShareDialog, ports, schedules, peer status and pending issue context. Concrete ten-surface handoff and 50 non-ready states implemented in the review fixture. Not user design approval. |
| Dependency setup | Normal `pnpm install --frozen-lockfile` passed. Offline attempt first reported a missing package; normal install fetched it. No dependency/lockfile changes, script-policy overrides or new frameworks. |
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` passed on the implementation source. Direct existing compiler entry was used after the normal pnpm shell launcher stalled. This is type-check evidence only, not execution or a replacement for all project checks. |
| Normal TypeScript/Vitest launchers | `pnpm exec tsc --noEmit` and targeted `pnpm vitest run … --maxWorkers=2` produced no output; owned shell launchers remained idle for minutes and were terminated. No pass. |
| Targeted Vitest via JS entry | `node node_modules/vitest/vitest.mjs run src/components/ui/teamPrimitives.test.tsx --maxWorkers=2` also produced no output for over three minutes and was stopped. Root cause not established for this run. No test was reported executed. Tests are authored, not claimed passing. |
| Native/full suites | Not repeated under the explicit host-recurrence constraint. CONTRIBUTING requires full Vitest, Clippy and Cargo tests before publication. They remain outstanding, even though this change is frontend only. |
| Rendered visual/keyboard/contrast evidence | Not completed. TerminalX browser status reports its runtime/browser available, but no page was rendered and no screenshots or computed contrast measurements are claimed. Shared startup stalls and no-duplicate-tree instructions remain. |
| Supplemental React/jsdom interaction smoke | All 60 recipes mounted including open portals. Share retention/disabled edits/discard, desktop local tab/Escape return, automation filter/menu dismissal and repeated-avatar IDs passed explicit assertions. This uses the existing compiler, React, jsdom and Testing Library through a pure-JavaScript runner; it is not a Vitest pass or rendered browser/contrast validation. |
| Supplemental source rendering | A pure-JavaScript React server-rendering check rendered all 60 recipes and checked non-ready output for protected sentinel labels. No browser/closed-portal layout or Vitest pass is inferred. |
| Independent source review | R1 found five actionable source/design defects: Share draft/discard, populated ready designs, desktop keyboard exit, unknown-presence stroke and domain IDs leaking into DOM IDs. R2 accepted those fixes and found a sixth issue: recipient binding across roster changes. That binding and regression coverage are now implemented; recheck requested from the same TerminalX Codex Astra reviewer. The stable report records exact scope and findings. It cannot waive execution, visual or product gates. |
| Product design approval | Not obtained. The “approved before ticket starts” criterion is not retroactively satisfiable for already-started tickets. Pending product choices are enumerated in TEAM-SURFACES.md. |

Durable execution evidence is under
`/Users/developer/.raccoon/task-coordination/raccoon-phase2-20261106/PRO-248-validation/`:
`normal-launcher-stalls.json`, `vitest-direct-stall.json`, `tsc-direct.log`,
`tsc-components.log`, `tsc-r2-final.log`, `dom-r2.log`, and original empty normal/direct Vitest logs. Empty logs are
not evidence of success. Process cleanup was limited to this author's owned checks.

`PRO-248-status.json` records base/head/snapshot, artifact paths, active checks,
reviewer IDs and blockers. `PRO-248-review.json` is written only by the independent
reviewer. No automatic OS/security changes, VM starts, full native retries,
manual pushes, PR creation or app-state edits were performed.

## Required recovery review

After the coordinator confirms real host recovery, use this same worktree/author
and reviewer. Run normal TypeScript, targeted primitives + examples + existing
cloud/people/share regressions, then the repository's full Vitest, strict Clippy
and Cargo tests with at most two workers/test threads. Record exit codes and exact
committed head. A changed head needs fresh independent review.

Run the actual `team-design.html` fixture via Vite and TerminalX browser. Capture
light/dark × 390×844/1280×800 for all ready/empty/loading/error/no-access/offline
surfaces, including opened profile, Share and ports overlays. Enter local review
labels for ready states, four names for overflow and long unicode values. Test
Enter/Space, Tab/Shift+Tab, Escape/outside dismissal and return focus, disabled
controls, live announcements, 200% zoom and reduced motion. Measure actual computed
contrast for text, focus and meaningful graphics; fix failures before claiming an
accessibility pass. Inspect the integrated peer features separately: a presentation
fixture cannot validate backend authority or transport behavior.

Only after those gates and explicit design approval may acceptance be marked
complete. Native review/security/local-check/CI and human-only controls still apply.
