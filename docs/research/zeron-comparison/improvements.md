# TerminalX improvement backlog

These are proposed changes, not implemented features or filed issues. Priorities rank product value from this investigation; effort is a rough engineering scope estimate, not a delivery commitment. **P1** means address first, **P2** means validate next, and **P3** means optional expansion. No P0 outage or security defect was established. Both local walkthroughs are complete within the [report’s](README.md) unauthenticated scope. Runtime findings are separated from source-based candidates. Implement I01/I02/I06 first; then validate launch/tool hierarchy and restart restoration. Current-plan, voice and remote proposals need authenticated or dedicated follow-up tests.

## First increment: agent readiness

### P1 · I01 · Guide installation and login inside the first-run journey · M

**Evidence:** Zeron installed Codex directly and updated its provider row ([Z07](evidence/Z07-agents-installed.png)). TerminalX’s runtime [Agent settings](evidence/T02-agent-settings.png) sent the user to documentation and detected the externally installed binary on Re-check. Its [new composer](evidence/T07-project-added.png) initially selected missing Claude Code even though Codex was installed.

**Change:** Add an optional “Set up an agent” panel with detected binary/version, an explicit supported installation action or copyable command, progress, cancellation, login guidance and re-check. Preserve a direct route for people whose CLI already works. When the saved/default provider is unavailable and another is installed, offer or select the available provider instead of presenting a disabled start state. Show the origin and destination of an installation before it runs.

**Acceptance:** On a pristine VM, a person can reach a ready Codex session without guessing which terminal or command to use. Installation failure shows a useful error and retry. Re-check finds an externally installed CLI. Existing installations are not replaced silently. An application account is not required for local setup.

### P1 · I02 · Distinguish installed, signed out, ready and unknown · M

**Evidence:** Zeron's agent was installed and selectable, but the first run failed with an actionable authentication card ([Z34](evidence/Z34-terminal-and-auth-error.png)). TerminalX showed installed, then Working, then a generic delivery-recovery notice; its actual terminal was at Codex sign-in ([T17](evidence/T17-delivery-recovery.png), [T19](evidence/T19-login-options.png)).

**Change:** Expose non-destructive provider readiness with a timestamp and refresh action. Show “Installed · sign in required” when known, “Ready” only when checked, and “Login not checked” when probing is unavailable. Use a launch preflight to explain an unmet prerequisite before creating a confusing empty conversation.

**Acceptance:** Missing binary, signed-out CLI, expired login, unknown probe and ready states have distinct copy and actions. Checks never print tokens or trigger a paid request. Transient probe failure does not erase a working session or claim credentials are invalid. A login action returns to the original draft.

### P2 · I03 · Keep app account, agent account and execution location distinct · S–M

**Evidence:** Zeron's onboarding explains local-only versus sync ([Z04](evidence/Z04-sync-choice.png)); the composer exposes both project and device ([Z13](evidence/Z13-composer.png)). TerminalX has local, paired and organization/cloud concepts in [Accounts](../../ACCOUNTS.md) and [cloud session creation](../../../src/components/session/CloudNewSession.tsx).

**Change:** Use a consistent location chip and short launch summary: “On this Mac / repository / new worktree,” or the named cloud workspace and organization. Keep “Sign in to TerminalX” separate from “Sign in to Codex.” Put cloud setup behind choosing remote work.

**Acceptance:** A fresh user can explain where files and the agent run before pressing Start. Switching organization or execution location updates the summary and invalidates stale choices. Local work never looks blocked by an optional app-account sign-in.

## Second increment: launch and work visibility

### P2 · I04 · Group launch controls by the decisions they answer · S–M

**Evidence:** Zeron's model/effort and branch/checkout controls are adjacent to the prompt ([Z15](evidence/Z15-model-picker.png), [Z16](evidence/Z16-checkout-picker.png)). TerminalX already exposes model, effort, permissions and pipeline choices in its [composer](../../../src/components/chat/Composer.tsx) and [new-session view](../../../src/components/session/NewSessionView.tsx).

**Change:** Group controls into agent/model, location/checkout, and permissions/automation. Keep effective settings visible; clearly mark a setting queued for the next turn. Provide a short explanation of new worktree versus current checkout, including whether files are shared with other tabs.

**Acceptance:** A novice can identify model, location, branch and permission mode from the launch surface. The unguarded mode stays visible. Existing shortcuts and remembered preferences continue to work. Mobile/narrow layouts do not hide the selected location or permission state.

### P2 · I05 · Surface the current plan above the composer · M

**Evidence:** Zeron's [latest-plan tray](https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/docs/todo-panel.md) is source-confirmed; authenticated runtime verification remains open. TerminalX has plan tool rows and a cross-project dashboard, but this investigation did not locate an equivalent persistent current-plan tray in the inspected chat components.

**Change:** Show the selected conversation's latest supported plan as a compact progress summary with an expandable checklist. Keep provider events authoritative. Collapse after completion and distinguish stopped, failed and completed work.

**Acceptance:** A long conversation shows the current task without scrolling back. Late events cannot resurrect an old plan. Switching tabs never mixes plans. A stopped run is not animated as working; reduced motion and keyboard operation are respected. Unsupported agents show no invented plan.

### P1 · I06 · Make failed or unconfirmed prompt delivery actionable · M

**Evidence:** In the fresh VM, the prompt produced a `delivery_unconfirmed` event 27.577 seconds after the user-message event. The [chat recovery notice](evidence/T17-delivery-recovery.png) advised inspecting the terminal and possibly pressing Enter; the [terminal](evidence/T19-login-options.png) was actually at the provider’s sign-in flow. The app correctly routed the session into Needs you, but the recovery reason lacked the prerequisite. An earlier host research worker also had unconfirmed delivery; that separate symptom is not needed to establish this VM finding.

**Change:** Give CLI and UI users the same explicit delivery stage, last confirmed event, and supported next action. Recognize supported provider onboarding/login screens and route to setup without suggesting Enter could send the coding task there. Distinguish queued, accepted by the CLI, running and blocked on initial agent setup. Retry must be safe against duplicate prompts.

**Acceptance:** A deliberately unready agent presents a clear recovery action and does not appear to be researching indefinitely. Once acknowledged, a retry cannot deliver the same instruction twice. Tests cover queued input, trust/setup gates, runtime restart and late provider-session discovery.

## Third increment: workspace usability

### P2 · I07 · Make workspace tools discoverable from one stable entry point · S–M

**Evidence:** Zeron's right-pane chooser exposes Files, Browser, Terminal, Diffs and History. Runtime checks exercised all except history. TerminalX’s live test opened Shell/Browser through New tab and Files/Changes through the right panel. At the recorded 1024-pixel width, sidebar, editor and right panel left a narrow document area ([T27](evidence/T27-editor-change.png)); hiding panes is already supported. This is a TerminalX viewport observation, not a like-for-like density score against Zeron.

**Change:** Test a consistent “Open tool” menu and named shortcuts. Preserve independent panes and full-height terminals; allow a reader to enlarge a focused surface and return without losing context.

**Acceptance:** From a new project, a first-time user opens a terminal in the correct worktree, previews a README, opens changes and starts a browser without consulting documentation. Tool switching preserves drafts, terminal output, browser state and editor scroll position.

### P2 · I08 · Restore workspace context after desktop-process restart · M

**Evidence:** The desktop was terminated with SIGTERM and reopened. Runtime PID 626 and Codex PID 42323 survived, and the saved diff, dark mode and shell tab remained. The start screen asked the user to choose a session; after selection, the browser tab was absent and `terminalx tab list --worktree all` returned empty. Earlier shell `pwd` output was not visible ([T56](evidence/T56-reopened.png), [T57](evidence/T57-restored-shell.png)). This is an abrupt desktop-process restart, not a verified normal Quit result.

**Change:** Persist and restore the selected workspace/tool and recoverable browser metadata independently of the desktop process. Reattach existing runtime/terminal state; distinguish recovered state from a newly launched shell or page. Explain any surface that cannot be restored.

**Acceptance:** After a controlled desktop termination with saved files, reopening preserves the agent process identity and offers the previous workspace, open file and browser URLs. Restoring a URL must not silently resubmit forms or replay side effects. Verify terminal process and scrollback behavior independently. Normal quit, abrupt termination, runtime loss and full reboot have separate expected outcomes.

**Revised finding:** The initial source-only suggestion to add diff scope labels is withdrawn: the runtime already exposed scope, target and merge-base information, plus All changes / Uncommitted changes / Last turn choices. Preserve those controls and extend mixed-state diff testing separately.

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

The local walkthrough is complete. Before implementing source-based candidates, run the same tasks with authenticated Codex on both apps: create a worktree, make a small tested change, inspect the diff, interrupt/resume, switch sessions and recover after quitting the UI. Separately test remote/sync with two disposable devices and a clearly scoped account. Do not mix debug/release performance results or infer speed from Rust/GPUI versus Tauri/React.
