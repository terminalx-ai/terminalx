# TerminalX improvement backlog

These are proposed changes, not implemented features or filed issues. Priorities rank product value from this investigation; effort is a rough engineering scope estimate, not a delivery commitment. **P1** means address first, **P2** means validate next, and **P3** means optional expansion. No P0 outage or security defect was established. TerminalX desktop observations remain pending the Accessibility repair described in the [report](README.md); recommendations based on its code need a fresh-install usability pass before implementation.

## First increment: agent readiness

### P1 · I01 · Guide installation and login inside the first-run journey · M

**Evidence:** Zeron installed Codex directly and updated its provider row ([Z07](evidence/Z07-agents-installed.png)). TerminalX's [start screen](../../../src/components/start/StartScreen.tsx) and [Agent settings](../../../src/components/settings/SettingsPage.tsx) detect binaries and send the person to an external install page, then ask them to log in in a terminal.

**Change:** Add an optional “Set up an agent” panel with detected binary/version, an explicit supported installation action or copyable command, progress, cancellation, login guidance and re-check. Preserve a direct route for people whose CLI already works. Show the origin and destination of an installation before it runs.

**Acceptance:** On a pristine VM, a person can reach a ready Codex session without guessing which terminal or command to use. Installation failure shows a useful error and retry. Re-check finds an externally installed CLI. Existing installations are not replaced silently. An application account is not required for local setup.

### P1 · I02 · Distinguish installed, signed out, ready and unknown · M

**Evidence:** Zeron's agent was installed and selectable, but the first run failed with an actionable authentication card ([Z34](evidence/Z34-terminal-and-auth-error.png)). TerminalX's [catalog](../../../src-tauri/src/harness/mod.rs) exposes binary availability; its Agent settings instruct users to log in separately.

**Change:** Expose non-destructive provider readiness with a timestamp and refresh action. Show “Installed · sign in required” when known, “Ready” only when checked, and “Login not checked” when probing is unavailable. Use a launch preflight to explain an unmet prerequisite before creating a confusing empty conversation.

**Acceptance:** Missing binary, signed-out CLI, expired login, unknown probe and ready states have distinct copy and actions. Checks never print tokens or trigger a paid request. Transient probe failure does not erase a working session or claim credentials are invalid. A login action returns to the original draft.

### P1 · I03 · Keep app account, agent account and execution location distinct · S–M

**Evidence:** Zeron's onboarding explains local-only versus sync ([Z04](evidence/Z04-sync-choice.png)); the composer exposes both project and device ([Z13](evidence/Z13-composer.png)). TerminalX has local, paired and organization/cloud concepts in [Accounts](../../ACCOUNTS.md) and [cloud session creation](../../../src/components/session/CloudNewSession.tsx).

**Change:** Use a consistent location chip and short launch summary: “On this Mac / repository / new worktree,” or the named cloud workspace and organization. Keep “Sign in to TerminalX” separate from “Sign in to Codex.” Put cloud setup behind choosing remote work.

**Acceptance:** A fresh user can explain where files and the agent run before pressing Start. Switching organization or execution location updates the summary and invalidates stale choices. Local work never looks blocked by an optional app-account sign-in.

## Second increment: launch and work visibility

### P1 · I04 · Group launch controls by the decisions they answer · S–M

**Evidence:** Zeron's model/effort and branch/checkout controls are adjacent to the prompt ([Z15](evidence/Z15-model-picker.png), [Z16](evidence/Z16-checkout-picker.png)). TerminalX already exposes model, effort, permissions and pipeline choices in its [composer](../../../src/components/chat/Composer.tsx) and [new-session view](../../../src/components/session/NewSessionView.tsx).

**Change:** Group controls into agent/model, location/checkout, and permissions/automation. Keep effective settings visible; clearly mark a setting queued for the next turn. Provide a short explanation of new worktree versus current checkout, including whether files are shared with other tabs.

**Acceptance:** A novice can identify model, location, branch and permission mode from the launch surface. The unguarded mode stays visible. Existing shortcuts and remembered preferences continue to work. Mobile/narrow layouts do not hide the selected location or permission state.

### P1 · I05 · Surface the current plan above the composer · M

**Evidence:** Zeron's [latest-plan tray](https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/docs/todo-panel.md) is source-confirmed; authenticated runtime verification remains open. TerminalX has plan tool rows and a cross-project dashboard, but this investigation did not locate an equivalent persistent current-plan tray in the inspected chat components.

**Change:** Show the selected conversation's latest supported plan as a compact progress summary with an expandable checklist. Keep provider events authoritative. Collapse after completion and distinguish stopped, failed and completed work.

**Acceptance:** A long conversation shows the current task without scrolling back. Late events cannot resurrect an old plan. Switching tabs never mixes plans. A stopped run is not animated as working; reduced motion and keyboard operation are respected. Unsupported agents show no invented plan.

### P1 · I06 · Make failed or unconfirmed prompt delivery actionable · M

**Evidence:** TerminalX's [recovery banner](../../../src/components/session/RecoveryBanner.tsx) and [delivery model](../../../src/lib/sessions.ts) already acknowledge recovery. Separately from the clean-VM comparison, the source-research worker started through the host TerminalX CLI remained at `delivery_unconfirmed`, with no provider session ID. This is an observed integration symptom, not a diagnosed root cause or a fresh-install app failure.

**Change:** Give CLI and UI users the same explicit delivery stage, last confirmed event, and supported next action. Distinguish queued, accepted by the CLI, running and blocked on initial agent setup. Retry must be safe against duplicate prompts.

**Acceptance:** A deliberately unready agent presents a clear recovery action and does not appear to be researching indefinitely. Once acknowledged, a retry cannot deliver the same instruction twice. Tests cover queued input, trust/setup gates, runtime restart and late provider-session discovery.

## Third increment: workspace usability

### P2 · I07 · Make workspace tools discoverable from one stable entry point · S–M

**Evidence:** Zeron's right-pane chooser exposes Files, Browser, Terminal, Diffs and History. Runtime checks exercised all except history. TerminalX already provides these capabilities through editor, shell, browser and changes surfaces.

**Change:** Test a consistent “Open tool” menu and named shortcuts. Preserve independent panes and full-height terminals; allow a reader to enlarge a focused surface and return without losing context.

**Acceptance:** From a new project, a first-time user opens a terminal in the correct worktree, previews a README, opens changes and starts a browser without consulting documentation. Tool switching preserves drafts, terminal output, browser state and editor scroll position.

### P2 · I08 · Make diff scope and provenance obvious · S–M

**Evidence:** Zeron showed a clear Working tree scope and added-line counts ([Z40](evidence/Z40-working-tree-diff.png)). TerminalX supports last-turn and session diffs plus Git/PR views.

**Change:** Give every changes view an explicit scope, base/head or working-tree label, freshness indicator and empty-state explanation. Link a changed file back to its editor and relevant turn when that provenance is known.

**Acceptance:** The same file modified before and during a turn can be inspected without confusing turn changes with all local edits. Untracked, staged and unstaged changes are distinguishable. Empty or stale data never looks like a confirmed clean tree. No stage/commit/merge action is implied by merely opening a diff.

### P2 · I09 · Add a user-triggered screen-context draft · M–L

**Evidence:** Zeron exposes Appshots with a global shortcut, destination, optional accessibility text and review-before-send wording ([Z25](evidence/Z25-appshots.png)). Capture was not enabled in this test. TerminalX already has a floating window, attachments and computer-use infrastructure.

**Change:** Offer “Capture window to draft” from the floating chat. Preview the image and any extracted text, let the person remove/redact it, then send explicitly. Treat this as a human capture workflow, separate from agent-controlled computer use.

**Acceptance:** Nothing is sent automatically. The selected destination is visible. Permission requests appear only when the person invokes capture. Unsupported or protected windows fail clearly, and existing own-app and human-confirmation protections remain intact.

### P2 · I10 · Simplify settings discovery without removing expert controls · S–M

**Evidence:** Zeron groups settings into task-specific pages with direct descriptions ([Z17](evidence/Z17-general-settings.png), [Z22](evidence/Z22-providers.png)). TerminalX has a larger set of local runtime, organization, environment, provider and integration settings.

**Change:** Add searchable settings and contextual deep links from failures. Separate local setup from organization administration. Use consistent terms for session, tab, workspace, project and provider across launch, settings and errors.

**Acceptance:** Searching “Codex login,” “font,” “notification,” “worktree,” or “Linear” reaches the relevant setting. A local-only user does not need to understand cloud organization setup. Search results preserve permission/role visibility.

### P2 · I11 · Preview notification behavior and attention routing · S

**Evidence:** Zeron exposes completion, input, error/disconnection and background controls ([Z19](evidence/Z19-notifications.png)). TerminalX already grades notifications by attention and has a Needs you dashboard.

**Change:** Explain what happens for completion, input needed and failure in foreground/background states, with a test/preview action. Link actionable notifications to the correct conversation or pipeline decision.

**Acceptance:** One event produces the intended channel once, not duplicate tones and banners. A notification from another project opens the correct session. Permission denied and Do Not Disturb are explained without claiming delivery.

### P2 · I12 · Validate density, contrast and motion in real workflows · S–M

**Evidence:** Both products already offer themes and shortcut customization. Zeron adds accent/material and separate UI/code/terminal font controls. Screenshots support visual comparison but are not accessibility measurements.

**Change:** Run a focused usability/contrast pass at narrow widths, multiple font scales, light/dark modes and reduced motion. Improve disabled text, focus indicators, icon labels and truncation based on measured failures. Offer comfortable/compact density if user testing demonstrates value.

**Acceptance:** Critical actions and status remain legible at 125%/150% scale; controls have keyboard focus and accessible names; long project/model names do not hide location or permissions. Record measured contrast failures before asserting compliance. Screenshots and tests cover small-window layouts.

## Later product decisions

### P3 · I13 · Evaluate more providers against TerminalX's same-process design · L

**Evidence:** Zeron has ten non-mock harness identities. TerminalX intentionally offers two PTY-first providers and retains hidden Cursor/OpenCode adapters.

**Change:** Gather demand and choose one provider pilot. Define capability, authentication, status, interruption, resume and chat/terminal consistency requirements before exposing it. Do not simply remove the hidden-provider filter.

**Acceptance:** A provider passes the real session lifecycle matrix, including authentication failure, interruption, resume and permission behavior. Unsupported capabilities are explicit. Existing Claude/Codex behavior does not regress.

### P3 · I14 · Expand theme import only after readability work · M

**Evidence:** Zeron's theme library supports local VS Code theme imports; TerminalX already ships four themes and light/dark controls.

**Change:** If demand warrants it, add a constrained import format with preview and reset. Keep semantic colors for warnings, permissions and diffs distinct from decorative colors.

**Acceptance:** Invalid imports fail atomically. Imported palettes cannot make essential state unreadable without a warning. Reset restores a usable theme. No executable extension content is loaded as a theme.

## Preserve these strengths

- Real CLI process shared by chat and terminal; keep inspection and recovery transparent.
- Independent review, commit-bound checks and merge controls; do not equate these with a PR viewer.
- Worktree isolation and guarded cleanup.
- Cross-project attention dashboard and supported CLI automation.
- Optional local-only use, explicit remote/cloud authority, local dictation and manual update installation.

## Validation plan before building the backlog

Finish the TerminalX fresh-VM walkthrough, then run the same tasks with authenticated Codex on both apps: create a worktree, make a small tested change, inspect the diff, interrupt/resume, switch sessions and recover after quitting the UI. Separately test remote/sync with two disposable devices and a clearly scoped account. Do not mix debug/release performance results or infer speed from Rust/GPUI versus Tauri/React.
