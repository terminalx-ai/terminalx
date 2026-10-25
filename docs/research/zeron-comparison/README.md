# Zeron and TerminalX: fresh-install comparison

**Test date:** 26 October 2026, Asia/Dubai (recording began 25 October UTC).

**Zeron:** v0.2.125, commit `255c540d651910ccab451b77ec59c05ba4266d41`.

**TerminalX:** 0.2.19, source commit `e86b2de2db8968739d75e85ae0e859b38e95a862`.

This is a product and usability investigation, not a performance benchmark or a security audit. The deliverables are a feature comparison, an evidence ledger, a narrated video, and an actionable improvement backlog. No application behavior was changed.

**Start here:** [Watch the 5:50 interim video](video/comparison-interim.mp4) · [Read the 14 prioritized improvements](improvements.md) · [Video transcript and chapters](video/README.md) · [Validation results](validation.md).

**Status: incomplete.** Zeron was exercised in its VM. TerminalX was freshly installed and its runtime verified, but its UI walkthrough requires the host Accessibility repair described below. The video makes this boundary explicit.

## Scope and reproducibility

Each application was installed in its own clone of the same Lume macOS base: macOS 26.5.2 (25F84), four virtual CPUs, 8 GiB RAM, a 150 GiB virtual disk and a configured 1440 × 900 display. The pre-existing `terminalx-ui-pilot` VM was left alone. See [environment.json](environment.json) for artifact hashes and VM names.

Zeron used its published Apple Silicon application archive. TerminalX used the repository's Dev variant, built from the exact commit above with `pnpm tauri build --debug --bundles app`. The build used the existing Dev identity, development helper/launcher/runtime hooks, and disabled updater artifact generation. This is a fresh installation of current project code, **not a test of the signed production installer, production account endpoints, or updater**. Debug-versus-release timings and memory figures would not be comparable, so none are ranked here.

No provider credentials, personal projects, host app profiles, or existing conversations were copied into either VM. Zeron installed Codex 0.164.0 through its onboarding UI. The fixture repository contains only a README and a JavaScript task list. A later README addition was made by the test operator to exercise the diff viewer; it was not an agent-generated change.

All desktop interaction was coordinated through `terminalx computer` against Lume's native viewer. Lume SSH was used for installation, fixture creation, and read-only verification. The video uses real VM screen recordings and screenshots, with editorial captions and synthetic narration. It must not be interpreted as a successful authenticated coding run.

Evidence labels throughout this package:

| Label | Meaning |
| --- | --- |
| **Observed** | Exercised in the installed app, with a screenshot or recorded result. |
| **Source** | Implemented behavior inspected at the pinned source commit; not an end-to-end runtime pass. |
| **Not tested** | Needs credentials, another device, permissions, or a separate test scenario. |
| **Recommendation** | Product judgment, with a proposed validation criterion. |

## Current completion boundary

Zeron's onboarding, project selection, model/effort controls, worktree creation, terminal command, Markdown preview, working-tree diff, embedded browser, settings and light/dark appearance were exercised. An unauthenticated Codex run reached a visible signed-out error; successful inference was not tested.

TerminalX built successfully and launched in a separate clean VM. Its CLI confirms version 0.2.19, an active local runtime, zero projects and zero sessions. The desktop walkthrough is pending a host Accessibility repair: the TerminalX helper reports `permission_denied` for the new Lume window even though its permission inventory reports granted. Do not treat source-confirmed TerminalX UI descriptions below as completed runtime checks.

## Main finding

Zeron makes the journey from an empty Mac to a configured workspace unusually explicit: appearance, optional sync, an agent installer, then a project. The composer keeps project, device, model, effort, branch and checkout choice close to the prompt. Its adjacent terminal, file, diff and browser surfaces support a focused workspace.

TerminalX already has many of those capabilities. Its distinctive strengths are the real agent CLI behind both chat and terminal, a cross-project attention dashboard, GitHub/Linear issue entry points, independent review pipelines, configurable permission modes, and a supported automation CLI. The strongest near-term opportunities are **agent readiness and onboarding, clearer location and launch state, and making existing workspace tools easier to discover**. Adding a theme, shortcut editor, command palette, browser or diff viewer as if absent would misdiagnose the gap.

## Feature comparison

The TerminalX column is source-confirmed unless explicitly marked otherwise. Links resolve to exact source versions or files in this repository. The [evidence ledger](evidence.md) maps runtime observations to screenshots.

| Area | Zeron v0.2.125 | TerminalX 0.2.19 | Implication |
| --- | --- | --- | --- |
| First run | **Observed:** welcome, appearance, optional sync, install-agent step, then project handoff. Microphone permission appeared before voice was requested. [Onboarding source][z-onboarding] | Three task-oriented start actions; a missing-agent notice, installation links, re-check and Agent settings. Sign-in is optional. [StartScreen](../../../src/components/start/StartScreen.tsx) | Keep TerminalX's fast local entry; add an optional readiness checklist and contextual setup. Avoid copying premature microphone prompts. |
| Agent installation | **Observed:** inline Codex installation changed from installing to available. **Source:** installer/update policies are provider-specific. [Provider settings][z-harness-settings] | Detects existing CLIs and links to installation instructions; Settings says to log in in a terminal. [Agent settings](../../../src/components/settings/SettingsPage.tsx) | The setup handoff is a concrete friction gap, not evidence that TerminalX cannot run Codex. |
| Supported providers | **Observed:** multiple provider rows, Codex used. **Source:** ten non-mock harness identities: Claude Code, Codex, Cursor, Devin, Grok, Hermes, Pi, OpenCode, Antigravity and Muse. [Registry][z-agents] | New work offers Claude Code and Codex. Cursor/OpenCode adapters remain in source but are deliberately hidden. [Registry](../../../src-tauri/src/harness/mod.rs) | Broader provider support is a product decision with maintenance and interaction-model costs. Hidden adapters are not shipped parity. |
| Provider accounts | **Observed:** Codex account connection entry and update policy. **Source:** multiple account behavior varies by provider. [Account rules][z-providers] | Uses the agent CLIs' existing login; managed Codex home isolates hooks. Cloud organization logins are a separate feature. [PTY design](../../PTY-FIRST.md), [cloud logins](../../CLOUD-AGENT-LOGINS.md) | Clearly separate app account, agent login and cloud credential states. |
| Permission model | **Source:** Codex harness forces full access and approval policy never. [Codex harness][z-codex] | Explicit permission modes, hook-backed cards and protected human decisions. [PTY design](../../PTY-FIRST.md), [computer use](../../COMPUTER-USE.md) | Preserve TerminalX's controls and visible unguarded-mode indication. Do not copy defaults merely to match speed. |
| Composer | **Observed:** model, reasoning slider, branch, checkout, project and device near the prompt; model search and favorites affordance. [Composer implementation][z-composer] | Model/effort controls, permission choices, attachments, mentions, queued follow-ups and pending setting changes. [Composer](../../../src/components/chat/Composer.tsx) | Improve grouping and readiness cues; most core controls already exist. |
| Worktree isolation | **Observed:** selecting New worktree created `quiet-lynx`, later renamed branch `zeron/read-readme-md`; verified with Git and terminal `pwd`. [Workspace implementation][z-shell] | Worktrees are the default for Git sessions; shared-tree agent tabs, external-worktree discovery and guarded cleanup. [README](../../../README.md), [retention](../../WORKSPACE-RETENTION.md) | Keep the default isolation and cleanup protection; explain checkout impact at launch. |
| Agent chat and terminal | **Observed:** native chat with separate working shell. Signed-out run showed an actionable error. **Source:** Codex app-server structured protocol. [Harness][z-codex] | Chat is a projection of the same interactive CLI PTY; switching views preserves the process. [PTY design](../../PTY-FIRST.md) | TerminalX's same-process inspection is a meaningful differentiator. |
| Shell | **Observed:** terminal opened in the session worktree and returned `pwd`; tabbed beside other tools. [Terminal implementation][z-terminals] | Persistent full-height shell tabs, working-directory and scrollback retention. [README](../../../README.md) | Test discoverability and tab switching rather than adding another terminal. |
| Files and editor | **Observed:** searchable file tree and live Markdown preview; source changes appeared in the viewer. **Source:** autosave/wrap/ignored-file settings. [Files panel][z-files] | Git badges, file icons, CodeMirror editor, Markdown/media previews, quick open and project search. [Editor](../../../src/components/editor/EditorPane.tsx), [media](../../MEDIA-VIEWERS.md) | Favor better connections between files, chat context and changes over a replacement editor. |
| Diff and history | **Observed:** working-tree diff showed the operator's three added lines, and the pane could expand. **Source:** working-tree/turn/history surfaces. [Diff synchronization][z-diff] | Last-turn or whole-session changes, Git status/history and PR panels. [README](../../../README.md) | Make scope labels and base/head/working-tree distinctions explicit. |
| Browser | **Observed:** entered a URL and loaded it inside the workspace; browser adopted dark appearance. **Source:** local preview discovery. [Browser][z-browser], [preview networking][z-preview] | Workspace-scoped Chromium tabs and an automation CLI; cloud preview support is separately documented. [Browser](../../BROWSER-USE-MACOS.md), [cloud previews](../../CLOUD-PREVIEWS.md) | A predictable Files / Browser / Terminal / Changes entry point is worth testing. |
| Navigation and search | **Observed:** project/device/folder selection with breadcrumbs, sidebar grouping/sort/compact options. **Source:** palette searches threads, commands, filenames and file content. [Palette][z-palette] | Command palette covers projects, workspaces, sessions, files, commands, issue and PR entry points. [Palette](../../../src/components/command/CommandPalette.tsx) | Both have substantial search; compare common task completion, not presence of a palette. |
| Progress and attention | **Observed:** run status and elapsed time, failure card. **Source:** persistent latest-plan tray, queue, attention-sorted sessions and terminal activity status. [Todo panel][z-todo], [status][z-status] | Needs-you / working / done dashboard; status and pipeline notifications; tool rows render plan events. [Dashboard](../../../src/lib/dashboard.ts), [tool rows](../../../src/components/chat/ToolCallRow.tsx) | A compact current-plan tray could complement the dashboard without duplicating it. |
| Delegation | **Source:** MCP exposes create/read/send/wait/interrupt and batched delegation; child creation is limited to one level. [MCP tools][z-mcp] | TerminalX CLI creates and coordinates real agent sessions and transcript reads. [CLI guide](../../../skills/terminalx-cli/SKILL.md) | Preserve one authoritative session state and improve actionable delivery/recovery reporting. |
| Issues and PRs | **Source:** PR board, detail/code views, CI assessment and review handoff. Not exercised against GitHub. [PR board][z-pr], [handoff][z-pr-handoff] | GitHub/Linear issues to worktree, PR, independent reviewer, fix rounds and commit-bound merge gates. [Pipeline](../../ISSUE-PIPELINE.md) | Keep this as TerminalX's primary workflow advantage. A PR viewer is not equivalent to an independent gated pipeline. |
| Themes and typography | **Observed:** system/light/dark, accent swatches, material controls. **Source:** separate UI/terminal/code font controls and local VS Code theme import. [Appearance][z-appearance], [theme library][z-theme] | Four themes, supported light/dark modes, UI scale and terminal font settings. [Settings](../../../src/components/settings/SettingsPage.tsx) | Better contrast previews and density controls matter before wallpaper/theme breadth. |
| Shortcuts and accessibility | **Observed:** editable shortcut page. **Source:** conflict handling, focus/ARIA semantics and reduced motion. [Shortcuts][z-shortcuts] | Editable bindings, shortcut hints, semantic controls and motion handling. [Shortcuts](../../../src/components/settings/ShortcutsTab.tsx) | No comparative screen-reader or contrast pass was performed; neither product receives an accessibility score. |
| Notifications | **Observed:** separate controls for task completion, input, errors/disconnections, agent updates and background-only behavior. [Settings][z-notifications] | Attention-graded desktop/in-app/tone behavior and work-status controls. [Work status](../../../src/components/settings/WorkStatusSettings.tsx) | Make the events and current behavior understandable with a preview/test action. |
| Voice | **Observed:** Codex voice-device/style controls and optional dictation download; audio not tested. [Voice session][z-voice] | On-device macOS dictation and optional local transcription models. [Transcription](../../../src/components/settings/TranscriptionTab.tsx) | Differentiate live voice sessions from dictation; request permissions at the point of use. |
| Screen context | **Observed:** Appshots setup explains capture, optional accessibility text, shortcut and review-before-send. Capture itself not enabled. [Appshots][z-appshots] | Agent-driven desktop tools and floating quick chat; screenshots can be attached, but no equivalent global Appshot flow was verified. [Computer use](../../COMPUTER-USE.md), [floating window](../../FLOATING-WINDOW.md) | A user-triggered capture-to-draft flow is a useful separate product opportunity. |
| Local and remote | **Observed:** local use without a Zeron account. **Source:** separate local/synced profiles, optional multi-device control, headless engine and hosted sessions. [Architecture][z-architecture] | Optional account, device pairing, encrypted remote transport, cloud organizations/workspaces and diagnostics. [Accounts](../../ACCOUNTS.md), [cloud lifecycle](../../CLOUD-LIFECYCLE.md) | Both have remote capabilities. No sync, cloud compute, organization-role or mobile end-to-end pass was performed. |
| Lifecycle and updates | **Source:** detached engine survives closing the UI; app updater and agent-update policy are separate mechanisms. [Architecture][z-architecture], [updates][z-update] | Separate local runtime, explicit update check/install, signed update validation. [Runtime](../../LOCAL-RUNTIME-ACCEPTANCE.md), [README](../../../README.md) | Keep lifecycle and update authority legible; do not claim latency/battery wins from implementation language. |

## Recommended implementation order

See [improvements.md](improvements.md) for acceptance criteria, evidence and effort. Start with agent readiness and an optional setup checklist; then simplify launch/location information and surface the current plan; then improve access to existing tools and context capture. Provider expansion and theme imports follow product validation, not checklist parity.

## Validation and limits

- `pnpm install --frozen-lockfile` completed without lockfile changes.
- `pnpm check` passed: TypeScript plus 289 test files / 3,387 tests.
- The frontend and native Dev application build completed successfully.
- Successful agent inference, paid cloud creation, sync, GitHub/Linear writes, voice recording, Appshots capture and update installation were not tested.
- Zeron's older `docs/PARITY.md` contains historical statements contradicted by the installed release, including an always-dark UI description. Current code and observed behavior take precedence over that checklist.
- VM viewer input/geometry issues are capture-environment limitations, not automatically defects in either app. No frame-rate, CPU, memory, battery, accessibility-compliance or time-to-productivity ranking is supported by this run.

[z-onboarding]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/onboarding.rs
[z-harness-settings]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/settings/harnesses.rs
[z-agents]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/proto/src/agent.rs
[z-providers]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/proto/src/providers.rs
[z-codex]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/harness/src/codex/mod.rs
[z-composer]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/composer.rs
[z-shell]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/shell.rs
[z-terminals]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/engine/src/terminals.rs
[z-files]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/shell/files_panel.rs
[z-diff]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/engine/src/diff_sync.rs
[z-browser]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/browser/view.rs
[z-preview]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/docs/preview-networking.md
[z-palette]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/shell/command_palette.rs
[z-todo]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/docs/todo-panel.md
[z-status]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/docs/program-status.md
[z-mcp]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/mcp/src/tools.rs
[z-pr]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/pull_requests.rs
[z-pr-handoff]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/pull_request_handoff.rs
[z-appearance]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/settings/appearance.rs
[z-theme]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/theme/src/library.rs
[z-shortcuts]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/settings/shortcuts.rs
[z-notifications]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/settings/notifications.rs
[z-voice]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/voice-session/src/lib.rs
[z-appshots]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/crates/ui/src/settings/appshots.rs
[z-architecture]: https://github.com/zeronsh/zeron/blob/255c540d651910ccab451b77ec59c05ba4266d41/ARCHITECTURE.md
[z-update]: https://github.com/zeronsh/zeron/tree/255c540d651910ccab451b77ec59c05ba4266d41/crates/update
