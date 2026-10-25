# Interim comparison video transcript

## 00:00:00 — Zeron × TerminalX

INTERIM COMPARISON · 26 OCT 2026

This interim comparison examines Zeron and TerminalX in separate fresh macOS virtual machines created from the same Lume base. Zeron was exercised directly. TerminalX was built and launched, but its desktop walkthrough is pending a host Accessibility repair. The video distinguishes observed behavior from source-confirmed features. Narration is synthetic, and no successful authenticated agent run is claimed.

## 00:00:25 — 01 · A guided first run

ZERON · OBSERVED

Zeron starts with a guided sequence: choose an appearance, decide whether to sync, and install an agent. The sync step can be skipped, so local use does not require an application account. The sequence is clear, but a microphone permission prompt appeared before I asked to use voice. TerminalX should adopt helpful setup guidance while requesting permissions only at the point of use.

## 00:00:48 — 02 · Install is part of the product

ZERON · OBSERVED FOOTAGE

In the clean Zeron VM, clicking Install beside Codex started an inline installation and then marked the provider available. This is a concrete onboarding advantage. TerminalX currently detects existing command-line agents and links out to installation instructions. The opportunity is a guided installation and login handoff with progress, cancellation and a reliable re-check.

## 00:01:10 — 03 · Keep the launch context nearby

ZERON · OBSERVED

The composer keeps the project, device, model, reasoning level, branch and checkout choice close to the prompt. Choosing a new worktree makes isolation an explicit decision before work starts. TerminalX already has these kinds of controls. The improvement is to group them around the questions a user must answer: which agent, where it runs, what files it changes, and which permissions apply.

## 00:01:34 — 04 · Worktree, shell and a real failure

ZERON · OBSERVED FOOTAGE

The first prompt created a real Git worktree. A terminal opened in that checkout, and the print-working-directory command confirmed the location. Because Codex had no account credentials, the chat eventually showed a signed-out error with a login action. This exposes an opportunity for both products: distinguish installed from authenticated before a run begins, and preserve the draft when setup is needed.

## 00:01:58 — 05 · Inspect changes beside the conversation

ZERON · OBSERVED FOOTAGE

Zeron combines files, Markdown preview, terminal, diffs and browser surfaces in the workspace. This diff shows three lines deliberately added by the test operator, not by an agent. The working-tree scope and added-line count make the result understandable. TerminalX already supports rich changes and editor views. Prioritize clear scope, provenance and a stable way to open each tool.

## 00:02:22 — 06 · Browser and presentation controls

ZERON · OBSERVED

I loaded a public page inside Zeron and switched the workspace to dark appearance. The embedded page followed that appearance. Settings also expose accents, material choices and distinct font controls in source. TerminalX has themes, adjustable scale, a browser and an editor already. Better discoverability and measured readability are stronger priorities than simply adding more decoration.

## 00:02:46 — 07 · Context capture deserves its own flow

ZERON · SETUP OBSERVED, CAPTURE UNTESTED

Zeron exposes Appshots as a user-triggered context-capture workflow, with a shortcut, destination and permission explanation. The setup screen promises review before sending. I did not enable capture or validate that workflow end to end. TerminalX could connect its floating chat and attachment support into a similar capture-to-draft experience while preserving protected windows and human-only confirmations.

## 00:03:10 — 08 · Breadth versus a focused agent model

SOURCE-CONFIRMED · SEE REPORT LINKS

Zeron defines ten production agent harness identities in the inspected release. Only Codex was installed and attempted in this walkthrough. TerminalX deliberately offers Claude Code and Codex for new work, with legacy Cursor and OpenCode adapters hidden. Broader provider support is a product decision. Each additional provider needs reliable authentication, status, interruption, resume and permission behavior, not just a new picker entry.

## 00:03:37 — 09 · TerminalX: verified installation boundary

TERMINALX · CLI VERIFIED, UI PENDING

TerminalX was built from the comparison branch and installed in a second fresh clone, without Zeron data or installed agents. Its command-line interface confirmed version zero point two point nineteen, an active local runtime, zero projects and zero sessions. The host computer-use helper then refused the new Lume window. A human Accessibility repair is required, so the remaining TerminalX discussion is based on source rather than a completed desktop walkthrough.

## 00:04:05 — 10 · Preserve TerminalX’s distinctive strengths

TERMINALX · SOURCE-CONFIRMED

TerminalX gives chat and terminal views of the same real agent command-line process. That is a different interaction model from Zeron’s structured Codex harness and separate shell. TerminalX also provides a cross-project attention dashboard and an issue-to-pull-request workflow with independent review and merge checks. These are strengths to preserve. A competing pull-request viewer should not be treated as equivalent to a gated review pipeline.

## 00:04:30 — 11 · The first improvements to ship

RECOMMENDATIONS · VALIDATE WITH USERS

Start with guided installation and a truthful readiness state. Then make application login, provider login and execution location unmistakably different. Group launch controls around user decisions, and keep the effective permission mode visible. A compact current-plan tray could complement the existing attention dashboard. Prompt delivery and recovery should also say exactly what was confirmed and what action is needed next.

## 00:04:55 — 12 · Next: improve the tools already present

RECOMMENDATIONS · 14 ITEMS IN THE REPORT

The next increment should make existing tools easier to find: files, terminal, browser, changes and history. Add clearer diff scope, searchable settings and notification previews. Validate contrast, font scaling, keyboard access and narrow layouts with measurements. Capture-to-draft is a distinct product opportunity. Provider expansion and theme imports should follow demonstrated demand rather than a feature-count contest.

## 00:05:22 — What remains before the comparison is complete

BLOCKED ON ACCESSIBILITY · CHECKS PASSED

The accompanying report contains a detailed feature matrix, fourteen prioritized improvements, acceptance criteria, screenshots and reproduction notes. TypeScript checks, all three thousand three hundred eighty-seven tests, and the TerminalX Dev build passed. The work remains incomplete until the TerminalX desktop walkthrough is recorded. Authenticated agent execution, sync, cloud compute and voice also remain explicitly unverified.
