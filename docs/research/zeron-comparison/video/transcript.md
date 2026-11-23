# Zeron and TerminalX comparison video transcript

## 00:00:00 — Zeron × TerminalX

FRESH VM COMPARISON · 26 OCT 2026

This comparison tests Zeron and TerminalX in separate fresh macOS virtual machines from the same Lume base. Both used the same Codex version and local fixture, without provider credentials. TerminalX was a development build; Zeron was a published release. The video separates observed behavior from source-confirmed features. Narration is synthetic. Different capture geometry means these images are not a controlled density or performance benchmark.

## 00:00:27 — 01 · Zeron guides the first run

ZERON · OBSERVED

Zeron starts with a guided sequence: choose an appearance, decide whether to sync, install an agent, then open a project. Sync can be skipped, so local use does not require an application account. A microphone permission prompt appeared before voice was requested. TerminalX should borrow the useful guidance while requesting permissions when the feature is invoked.

## 00:00:49 — 02 · Installation stays in the app

ZERON · OBSERVED FOOTAGE

Clicking Install beside Codex started an inline installation and updated the provider row when it finished. This is a concrete onboarding advantage: the next step remains in the product instead of requiring the user to find a shell and installation instructions. Installed did not mean authenticated. The subsequent task still needed a provider login.

## 00:01:09 — 03 · TerminalX starts with local work

TERMINALX · OBSERVED

The fresh TerminalX screen offers a local project, a GitHub project and quick start. Application sign-in is optional. A missing-agent notice links to Claude Code, Codex, re-check and agent settings. This is a useful fast path for existing command-line users. A guided readiness checklist would help someone starting from an empty Mac.

## 00:01:29 — 04 · Detection works; setup is external

TERMINALX · OBSERVED FOOTAGE

TerminalX agent settings show installation commands and external links. Get it opened the official Codex documentation in Safari. After the test operator installed the matching standalone binary, re-check correctly detected Codex and showed its path. This footage begins after that installation. The new composer nevertheless initially selected missing Claude Code. Prefer an available provider when the default cannot start.

## 00:01:54 — 05 · Zeron keeps launch choices nearby

ZERON · OBSERVED

Zeron keeps project, device, model, reasoning level, branch and checkout close to the prompt. The checkout picker makes current checkout versus a new worktree an explicit decision. For both products, the user should be able to explain which agent runs, where it runs, what files it changes and which permissions apply before starting.

## 00:02:15 — 06 · TerminalX has the core controls

TERMINALX · OBSERVED

TerminalX exposes model, effort, permissions, worktree and automation choices. Its model list refreshed to include GPT-6.1 Sol; the test selected High effort. Both apps received the prompt: read readme dot m d. TerminalX used the requested bypass mode in the disposable fixture, with automation switches off. The improvement is clearer grouping and readiness, rather than adding controls already present.

## 00:02:41 — 07 · Zeron creates a worktree, then needs login

ZERON · OBSERVED FOOTAGE

The prompt created a real Zeron worktree. A separate shell opened there, and print working directory verified the location. Because Codex was signed out, the chat eventually showed an authentication error with a login action. This gives the user a specific reason for the failure, although a preflight readiness check could have caught it sooner.

## 00:03:00 — 08 · TerminalX recovery needs the real cause

TERMINALX · OBSERVED

TerminalX also created the worktree, initially showed Working, and then reported unconfirmed prompt delivery after about twenty-eight seconds. The recovery notice suggested checking the terminal and possibly pressing Enter. The actual prerequisite was provider sign-in. Recognizing that state would give the user a direct setup action instead of generic delivery troubleshooting.

## 00:03:22 — 09 · The real CLI makes recovery inspectable

TERMINALX · OBSERVED

Switching the agent tab to terminal revealed the real Codex process waiting for login. No provider credentials were supplied. This shared chat and terminal process is a TerminalX strength: users can inspect exactly what the agent is waiting for. A separate shell tab also opened in the worktree and passed the same working-directory check. Agent terminal and ordinary shell are distinct tools.

## 00:03:45 — 10 · Zeron’s changes stay beside the task

ZERON · OBSERVED FOOTAGE

The test operator deliberately added three README lines to exercise the diff. This was not an agent-generated edit. Zeron showed the working-tree scope, added-line count and expandable diff beside the conversation. The file tree and Markdown preview were also exercised. These are practical workspace capabilities to compare directly.

## 00:04:05 — 11 · TerminalX previews and edits the file

TERMINALX · OBSERVED

TerminalX opened the README in Markdown preview, switched to source, and saved the same three-line addition. Independent Git readback confirmed three additions and no deletions. At this VM’s narrow width, sidebar and tool panels reduced the document area. Improve focus and tool discovery while preserving the working editor and existing pane controls.

## 00:04:25 — 12 · Diff scope is already explicit

TERMINALX · OBSERVED

The runtime inspection corrected an early source-only hypothesis: TerminalX already displays scope, target branch and merge-base information. Its scope menu offers All changes, Uncommitted changes and Last turn. Only All changes was exercised here. The improvement list therefore does not propose adding missing scope labels. Mixed staged, untracked and turn-specific changes need a separate test.

## 00:04:50 — 13 · Zeron embeds the browser

ZERON · OBSERVED

Zeron loaded a public page inside its workspace browser. Switching to dark appearance also changed the embedded page’s presentation. Its neighboring file, terminal and diff surfaces keep the task context close. The test establishes navigation and appearance behavior, not browser performance or full application-preview compatibility.

## 00:05:11 — 14 · TerminalX browser and navigation work

TERMINALX · OBSERVED

TerminalX loaded the same public URL in a workspace browser tab, with a live preview and an Open window action. The CLI confirmed the URL and workspace association. Its interaction model differs from Zeron’s inline browser. A controlled Settings open-and-close test retained the selected browser. Command-palette search also found the README, session and workspace.

## 00:05:33 — 15 · Attention has a home

TERMINALX · OBSERVED

TerminalX’s dashboard placed the blocked session in Needs you. That is useful when work spans several projects. The routing worked; the explanation should name provider setup when that is the blocker. Later, Stop changed the session to Stopped and removed the live Codex process. Stopped is not the same as completed.

## 00:05:51 — 16 · Improve readability before adding themes

TERMINALX · OBSERVED SETTINGS

TerminalX already offers four themes, light and dark modes, transcript text sizing, layout options and editable shortcuts. Dark appearance survived reopening. Zeron adds accent, material and separate font controls, with theme import confirmed in source. Prioritize measured contrast, focus, text scaling and narrow-window usability. These screenshots do not establish accessibility compliance for either product.

## 00:06:18 — 17 · Capture-to-draft is a distinct opportunity

ZERON · SETUP OBSERVED, CAPTURE UNTESTED

Zeron’s Appshots setup describes a global capture shortcut, destination, optional accessibility text and review before sending. Capture itself was not enabled in this test. TerminalX could connect floating chat and attachments into a user-triggered capture-to-draft workflow. Voice and transcription controls exist in both products, but no audio was recorded. Dictation should remain distinct from live voice conversation.

## 00:06:44 — 18 · Breadth requires lifecycle quality

SOURCE-CONFIRMED · RUNTIME LIMITS IN REPORT

Zeron defines ten production harness identities in the inspected release. TerminalX offers Claude Code and Codex, with legacy adapters hidden. Only Codex was installed and attempted in these walkthroughs. Additional providers need reliable authentication, status, interruption, resume and permissions. Both projects also implement remote capabilities. Local settings inspection does not establish cloud or multi-device parity.

## 00:07:11 — 19 · Runtime survives; workspace context is lost

TERMINALX · DESKTOP-PROCESS RESTART TEST

The lifecycle test terminated only the TerminalX desktop process, then reopened it. The local runtime and waiting Codex process retained their process identities. The app reconnected, and the saved diff, dark mode and shell tab remained. It asked for a session selection; the previous browser tab was absent. Restore recoverable workspace and browser context. This was a process-termination test, not a verified normal Quit or full reboot test.

## 00:07:38 — 20 · Preserve TerminalX’s workflow strengths

OBSERVED FOUNDATION · PIPELINE CONFIRMED IN SOURCE

TerminalX’s real agent terminal and attention dashboard were observed directly. Its issue-to-pull-request workflow, independent review and commit-bound merge gates are documented in source and were not exercised against GitHub in these VMs. Preserve these strengths. A pull-request viewer and a gated review pipeline represent different levels of workflow support.

## 00:07:59 — 21 · Ship readiness and recovery first

RECOMMENDATIONS · 14 ITEMS WITH ACCEPTANCE CRITERIA

Start with guided installation, available-provider selection and truthful readiness states: missing, signed out, ready or unknown. Make unconfirmed delivery explain the last confirmed stage and a safe next action. Preserve the draft through login and avoid duplicate retries. Next, restore workspace context after a desktop restart and simplify launch and tool discovery. The report gives evidence, priorities, effort estimates and acceptance criteria for fourteen proposals.

## 00:08:29 — 22 · What this comparison establishes

LOCAL WALKTHROUGH COMPLETE · LIMITS EXPLICIT

The local comparison covers fresh setup, signed-out launches, worktrees, shells, files, diffs, browsers and settings. TerminalX also received attention, stop and desktop-restart checks. Neither product completed authenticated coding. Cloud, sync, voice, Appshots capture, production updating and performance rankings remain outside the verified scope. Both VMs are stopped and retained. The report and evidence ledger let you trace each recommendation to an observation or an exact source version.
