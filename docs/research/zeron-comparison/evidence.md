# Runtime evidence and reproduction

See [the report](README.md) for the completion boundary and source-backed feature matrix. Screenshots are unaltered captures from TerminalX's computer-use tool of Lume's native viewer. The viewer border, guest desktop and notification banners are retained. In the edited video, the VM application area is cropped for readability; captions are editorial, not app UI.

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
| T01 — CLI, no screenshot | Launch freshly built TerminalX Dev in second base clone | CLI returned 0.2.19, active local runtime, `projects: []`, `runningTabs: []` | GUI walkthrough blocked on host helper Accessibility error |

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

The recorded fixture commit was `1b5ca39`. Zeron created:

```text
/Users/lume/comparison-fixture                              1b5ca39 [main]
/Users/lume/.zeron/worktrees/comparison-fixture/quiet-lynx    1b5ca39 [zeron/read-readme-md]
```

The worktree initially used branch `zeron/quiet-lynx`; the app renamed it from the prompt. The README addition was:

```markdown

## Comparison note
This line was added by the test operator to exercise the diff view.
```

TerminalX was built with the repository's `src-tauri/tauri.dev.conf.json` identity and resources. A temporary config overrode `beforeBuildCommand` to run the launcher, computer helper and local runtime build hooks with `--dev`, then `pnpm build`; it set `bundle.createUpdaterArtifacts` to false. This temporary build configuration is not an application-source change. The bundle was zipped with `ditto`, transferred through a Lume shared directory, and installed under `/Applications/TerminalX Dev.app` in the second VM. No production bundle was relabeled to evade computer-use protections.

## Recording provenance

- Original Zeron recording: 600.003 seconds, H.264, 3016 × 2096 variable-rate screen capture. The editor normalizes selected excerpts to 25 fps. Full recording remains locally at `/tmp/zeron-comparison-2026-10-26/raw/zeron-walkthrough.mov`; durable selected excerpts are committed under [video/clips](video/clips).
- [Install excerpt](video/clips/zeron-install.mp4): source seconds 36–64; cropped app region `(308, 284, 2056, 1584)`.
- [Terminal/auth excerpt](video/clips/zeron-worktree-terminal.mp4): source seconds 372–401; cropped app region `(174, 438, 2400, 1590)`.
- [Diff excerpt](video/clips/zeron-diff.mp4): source seconds 428–453; same later-region crop.
- Excerpts retain their observed timing. If narration is longer than an excerpt, the last frame is held; app actions are not fabricated or replayed to suggest new activity.
- The edited video labels TerminalX sections as source-confirmed and explicitly states that its GUI walkthrough is pending. Synthetic narration is disclosed.

## Resume the blocked desktop comparison

1. Repair the host's **TerminalX Computer Use Helper** Accessibility grant through System Settings. Its permission inventory reports granted, but `get-app-state` on the new Lume viewer returns `permission_denied` with no accessibility window. The installed guide requires the person to resolve this, then retry; no alternate desktop driver was used.
2. Confirm the exact Lume app/window with `terminalx computer list-apps` and `list-windows`; window IDs from this run are ephemeral.
3. Capture TerminalX's first-run screen before adding any provider or project. The VM `terminalx-fresh-comparison` has TerminalX installed and no agent installation added.
4. Exercise its install handoff, then install the same Codex version without copying authentication. Add the same fixture and test composer/worktree/error/terminal/file/diff/browser/settings paths. Every new TerminalX session must use `--agent codex --mode bypassPermissions`; keep human-only safeguards intact.
5. If the person signs in later, run the authenticated task matrix from [improvements.md](improvements.md). Otherwise keep those cases explicitly unverified.
6. Replace the interim completion boundary and source-only video sections with observed TerminalX results, rerender, verify the media, and commit the completed package. TerminalX owns pushing, PR creation and independent review.

## Environment artifacts

The Zeron VM is stopped and retained. The fresh TerminalX VM is retained for continuation. Downloads, build logs, the exact temporary build config, original recording and capture helper scripts are in `/tmp/zeron-comparison-2026-10-26`; these are local working files, not durable delivery links. Durable comparison text, screenshots, selected clips and video authoring inputs live in this directory. Neither unrelated VMs nor host agent credentials were changed.
