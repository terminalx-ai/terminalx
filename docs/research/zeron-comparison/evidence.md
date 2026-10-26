# Runtime evidence and reproduction

See [the report](README.md) for the completion boundary and source-backed feature matrix. Z-prefixed screenshots are unaltered TerminalX computer-use captures of Lume’s viewer. T-prefixed screenshots are unaltered captures of TerminalX Dev’s guest window through Cua Spacesd. Viewer borders or notification banners present in the original captures are retained. In the edited video, the VM application area is cropped for readability; captions are editorial, not app UI.

## Executed checks

| ID / evidence | Action | Result | Boundary |
| --- | --- | --- | --- |
| [Z01](evidence/Z01-welcome.png) | Launch published Zeron app in fresh base clone | Welcome screen appeared | Installation via release archive, not a drag-to-Applications DMG test |
| [Z02](evidence/Z02-microphone-prompt.png) | Start onboarding | Microphone request appeared during appearance setup | Denied; no audio tested |
| [Z03](evidence/Z03-appearance-onboarding.png) | Inspect appearance step | System/light/dark, accent and wallpaper choices visible | Kept system mode initially |
| [Z04](evidence/Z04-sync-choice.png) | Inspect sync step, choose Skip for now | Continued locally without Zeron account | No sync or cloud account created |
| [Z07](evidence/Z07-agents-installed.png) | Click Install beside Codex | Installed and detected Codex 0.164.0 | Login status later confirmed signed out |
| [Z13](evidence/Z13-composer.png) | Add local fixture through device → home → folder picker | Project/device context and composer appeared | Fixture only; no personal repository |
| [Z15](evidence/Z15-model-picker.png) | Open compact model/effort picker, then model list | Searchable model choices and favorite icon visible | Catalog visibility is not proof of account entitlement |
| [Z16](evidence/Z16-checkout-picker.png) | Select New worktree | Checkout mode changed | Git creation verified after first prompt |
| [Z29](evidence/Z29-first-prompt.png) | Send `read readme.md` using Codex | Created a session/worktree | No successful inference |
| [Z34](evidence/Z34-terminal-and-auth-error.png) | Open terminal; run `pwd`; wait for agent outcome | Shell returned session worktree path; chat showed signed-out error and Log in action | Agent error appeared after approximately 25 seconds; not a benchmark |
| [Z39](evidence/Z39-markdown-preview.png) | Open README through file tree | Rendered Markdown preview | File edit/save interaction not exercised |
| [Z40](evidence/Z40-working-tree-diff.png) | Append three lines through setup shell; open Diffs and enlarge pane | Working tree scope and `+3 / -0` reflected the change | Operator-added change; no AI edit, commit or PR |
| [Z43](evidence/Z43-browser.png) | Enter `example.com` in embedded browser | URL loaded inside workspace | Public-page navigation only; no localhost discovery test |
| [Z44](evidence/Z44-dark-theme.png) | Choose dark appearance from View menu | Workspace and embedded page changed appearance | No measured contrast or accessibility pass |
| [Z17](evidence/Z17-general-settings.png), [Z18](evidence/Z18-appearance-settings.png) | Inspect General and Appearance | Compact mode, model picker, PR destination, worktree location and appearance controls visible | Most settings inspected, not individually exercised |
| [Z19](evidence/Z19-notifications.png), [Z21](evidence/Z21-shortcuts.png) | Inspect notification and shortcut pages | Event-specific notification settings and editable binding controls visible | Delivery and rebinding not tested |
| [Z22](evidence/Z22-providers.png), [Z26](evidence/Z26-codex-settings.png) | Inspect provider page and expand Codex | Install states, completion preferences, update policy and account connection entry | Only Codex installed; no additional provider run |
| [Z23](evidence/Z23-devices.png) | Inspect local device | Device row reported macOS / v0.2.125 | No second device paired |
| [Z24](evidence/Z24-file-settings.png) | Inspect file settings | Autosave, word wrap and ignored/hidden visibility controls | Did not change these settings |
| [Z20](evidence/Z20-voice.png), [Z25](evidence/Z25-appshots.png) | Inspect voice and Appshots setup | Optional download/permission/destination controls visible | No microphone, screen-context capture or model download enabled |
| [Z45](evidence/Z45-dark-chat.png), [Z46](evidence/Z46-sidebar-options.png) | Inspect dark chat and sidebar options | Failure remained readable; grouping, sorting, compact and section controls visible | No many-session scalability claim |
| [T01](evidence/T01-fresh-install.png) | Inspect untouched first-run screen | Three start actions, optional sign-in and missing-agent setup notice | Captured before provider/project setup; Dev build |
| [T02](evidence/T02-agent-settings.png), [T03](evidence/T03-install-handoff.png), [T04](evidence/T04-agent-detected.png) | Inspect Agent settings, open Get it, install matched binary, Re-check | Documentation opened in Safari; Codex changed to installed with its path | Binary version and signed-out state verified separately; no npm installer pass |
| [T07](evidence/T07-project-added.png) | Add the same fixture through the native folder picker | Composer initially selected missing Claude Code despite installed Codex | Codex was selected manually; no Claude session started |
| [T12](evidence/T12-models-refreshed.png), [T13](evidence/T13-permission-modes.png), [T14](evidence/T14-session-draft.png) | Inspect model/effort/permission choices; prepare launch | Live catalog included GPT-6.1 Sol; selected High and requested bypass mode, with new worktree enabled | Model visibility is not proof of account entitlement; automation switches remained off |
| [T17](evidence/T17-delivery-recovery.png), [T19](evidence/T19-login-options.png) | Send `read readme.md`; inspect chat and agent terminal | Worktree created; recovery event after 27.577 seconds; terminal showed Codex’s sign-in flow | No inference; canceled the browser sign-in attempt back to the method menu; OAuth URLs excluded from published captures |
| [T22](evidence/T22-shell-pwd.png) | New tab → Terminal on this computer; run `pwd` | Returned the exact worktree path | Separate shell, distinct from the Codex terminal |
| [T25](evidence/T25-markdown-preview.png), [T27](evidence/T27-editor-change.png), [T29](evidence/T29-diff-expanded.png) | Open README; switch Preview/Source; append the test note and Save; inspect Changes | Unsaved marker cleared; independent Git readback reported `3 0 README.md`; diff displayed +3 | This was an operator edit, not an agent result |
| [T31](evidence/T31-scope-options.png) | Inspect Changes scope menu; inspect Repo/History | All changes, Uncommitted changes and Last turn choices; history showed the fixture commit | Scope alternatives inspected only; a background native-menu selection was refused by the driver, so no scope-switch pass is claimed |
| [T35](evidence/T35-browser-loaded.png), [T53](evidence/T53-dark-browser.png) | Open browser tab and navigate to `example.com` | Page rendered in the preview; CLI confirmed URL and worktree association | Public-page navigation only; no browser form or localhost-discovery test |
| [T38](evidence/T38-appearance.png), [T39](evidence/T39-shortcuts.png), [T46](evidence/T46-dark-appearance.png) | Inspect appearance/shortcuts; select Dark | Four themes, mode, text/layout/tab controls and editable shortcuts; dark appearance applied | No rebinding, contrast measurement or screen-reader pass |
| [T40](evidence/T40-transcription.png), [T41](evidence/T41-integrations.png), [T42](evidence/T42-storage.png) | Inspect transcription, integrations and retention | Local model choices, integration setup and guarded cleanup controls visible | No audio/model download, account connection or cleanup invoked |
| [T43](evidence/T43-devices.png), [T44](evidence/T44-organizations.png), [T45](evidence/T45-about.png) | Inspect remote/account/update surfaces | LAN/relay options, no paired devices, organization visibility, version 0.2.19 and update controls | No pairing, cloud compute or updater installation |
| [T48](evidence/T48-dashboard.png), [T50](evidence/T50-search-results.png) | Inspect Needs you dashboard; search README in command palette | Waiting session grouped correctly; search returned file, session and workspace | One-session fixture, not a scalability measurement |
| [T53](evidence/T53-dark-browser.png), [T54](evidence/T54-settings-return.png) | Open Settings from the browser tab, then Close | Browser tab and URL remained selected in the controlled return test | No ordinary-settings navigation regression established |
| [T56](evidence/T56-reopened.png), [T57](evidence/T57-restored-shell.png) | Terminate desktop PID 574 with SIGTERM; relaunch Dev app | Runtime PID 626 and Codex PID 42323 survived; new desktop PID 49054 reattached; saved +3 diff, dark mode and shell tab remained | Browser tab list became empty; prior `pwd` output was not visible. Normal Quit could not be verified through the driver, so this is explicitly a process-termination test |
| [T58](evidence/T58-stopped.png) | Select agent tab and Stop session | UI showed Stopped, live-agent count became zero, CLI tab status became idle and Codex PID exited | Resume and successful coding were not tested |

## Fixture and installation record

The base clone had no Zeron or TerminalX installation. The TerminalX clone additionally confirmed no `~/.raccoon` or `~/.codex` directory before first launch. Both clones use the default disposable `lume` account. VM passwords and control credentials are intentionally absent from the artifacts.

Zeron artifact: `zeron-0.2.125-macos-arm64-app.tar.gz` from its GitHub release. The SHA-256 is recorded in [environment.json](environment.json). Its application reported 0.2.125 in Devices. Zeron's installer placed Codex at `~/.local/bin/codex`; `codex --version` returned `codex-cli 0.164.0`, and `codex login status` returned `Not logged in`.

Fixture creation:

```sh
mkdir -p ~/comparison-fixture
cd ~/comparison-fixture
git init -b main
git config user.name 'Comparison Fixture'
git config user.email 'comparison@example.invalid'
printf '# Comparison fixture\n\nA local task board used to compare agent workspaces.\n' > README.md
printf 'export const tasks = [{ id: 1, title: "Compare workspaces", done: false }];\n' > tasks.js
git add README.md tasks.js
git commit -m 'Initialize shared comparison fixture'
```

The Zeron fixture commit was `1b5ca39`. The separately initialized TerminalX fixture commit was `13261e682ca2da52a4a88df933a4a48c4ad85011`; commit IDs differ because initialization times differ. Both used the file contents above. Zeron created:

```text
/Users/lume/comparison-fixture                              1b5ca39 [main]
/Users/lume/.zeron/worktrees/comparison-fixture/quiet-lynx    1b5ca39 [zeron/read-readme-md]
```

The worktree initially used branch `zeron/quiet-lynx`; the app renamed it from the prompt. The README addition was:

```markdown

## Comparison note
This line was added by the test operator to exercise the diff view.
```

TerminalX was built with the repository's `src-tauri/tauri.dev.conf.json` identity and resources. A temporary config overrode `beforeBuildCommand` to run the launcher, computer helper and local runtime build hooks with `--dev`, then `pnpm build`; it set `bundle.createUpdaterArtifacts` to false. This temporary build configuration is not an application-source change. The bundle was zipped with `ditto`, transferred through a Lume shared directory, and installed under `/Applications/TerminalX Dev.app` in the second VM. The existing Dev identity was retained throughout.

## Background continuation

The user explicitly authorized trycua and requested that VM testing not disturb the host desktop. The guest already ran Cua Spacesd 0.7.0 with Accessibility and Screen Recording grants. Its bootstrap endpoint was initialized with a newly generated task credential through the authenticated guest shell; that credential is not committed. Direct guest MCP calls provided exact-window accessibility actions and screenshots. Cua’s process/file APIs ran fixture setup and readback inside the same VM. Host TerminalX remained the session/pipeline coordinator.

The matched Codex payload contained only `.local/bin/codex` and the standalone 0.164.0 release files. The `current` symlink was established in the fresh VM. `codex --version` returned `codex-cli 0.164.0`; `codex login status` returned `Not logged in`. No host or Zeron authentication profile was imported.

The TerminalX worktree was `/Users/lume/comparison-fixture/.raccoon/worktrees/sturdy-cream-wren`, branch `raccoon/sturdy-cream-wren`. Its launch used `--agent codex` semantics, `gpt-6.1-sol`, High effort and `bypassPermissions`, consistent with the standing session preference. The provider remained signed out.

Background driver refusals for native sheets/menu targeting and unverified keystrokes were resolved through fresh observations and guest-only foreground input when needed. Those are automation-harness results, not asserted application bugs. No host desktop input was used. The controlled Settings-return test passed; earlier ambiguous navigation was not classified as a defect.

The normal Quit menu/shortcut did not yield a verified exit during automation. The lifecycle test therefore used SIGTERM on the exact desktop PID, explicitly preserving the local runtime and testing reattachment. The subsequent UI and CLI showed that the runtime and agent survived; browser metadata did not return. The stopped agent was not counted as a successful task.

## Recording provenance

- Original Zeron recording: 600.003 seconds, H.264, 3016 × 2096 variable-rate screen capture. The editor normalizes selected excerpts to 25 fps. Full recording remains locally at `/tmp/zeron-comparison-2026-10-26/raw/zeron-walkthrough.mov`; durable selected excerpts are committed under [video/clips](video/clips).
- [Install excerpt](video/clips/zeron-install.mp4): source seconds 36–64; cropped app region `(308, 284, 2056, 1584)`.
- [Terminal/auth excerpt](video/clips/zeron-worktree-terminal.mp4): source seconds 372–401; cropped app region `(174, 438, 2400, 1590)`.
- [Diff excerpt](video/clips/zeron-diff.mp4): source seconds 428–453; same later-region crop.
- Excerpts retain their observed timing. If narration is longer than an excerpt, the last frame is held; app actions are not fabricated or replayed to suggest new activity.
- TerminalX native recording: 599.978 seconds, H.264, 1024 × 768, captured entirely inside the guest with macOS `screencapture`, launched through Cua’s guest process API. Local original: `/tmp/zeron-comparison-2026-10-26/raw/terminalx-native.mov`; SHA-256 `ade076b00f6f7ad98b73e507f1ccc9ed75389d13afd9b3c8c8802f343ec89dcc`.
- [TerminalX agent-settings excerpt](video/clips/terminalx-agent-settings.mp4): native source seconds 4–29, cropped to app region `(0, 30, 1024, 674)` and normalized to 25 fps. It begins after the operator installed Codex; it does not depict an in-app installation.
- A local sequence of timestamped Cua window captures also records the continuation; it is supplementary working evidence, not a claimed high-frame-rate recording. Only selected, inspected assets are published.
- The final video uses real TerminalX runtime evidence alongside Zeron evidence. Source-only areas and untested account features retain explicit labels; synthetic narration is disclosed.

## Optional follow-up testing

With explicitly supplied test accounts, run the same authenticated change, test, interrupt/resume and PR workflow in both apps. Use two disposable devices for remote/sync and separately test production packaging/updating. These are coverage extensions, not passes inferred from settings pages. The current package completes the requested local comparison with those limits disclosed.

## Environment artifacts

Both comparison VMs are stopped and retained. The guest Codex session was explicitly stopped before shutdown. Downloads, build logs, the exact temporary build config, original recording and capture helper scripts are in `/tmp/zeron-comparison-2026-10-26`; these are local working files, not durable delivery links. Durable comparison text, screenshots, selected clips and video authoring inputs live in this directory. Neither unrelated VMs nor host agent credentials were changed.
