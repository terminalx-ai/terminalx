# Issue #136: folder projects

[Recorded native-app demo](folder-projects.mp4). This is a real macOS screen-region recording of the changed Tauri app, not a browser demo or reconstructed slideshow. The first clip opens an empty folder and starts an agent and shell; the second shows persisted folder/Git sessions after restarting the app. The clips are joined in order without changing their speed, and exported to a 1280×808, 15 fps H.264 MP4 for review (4:00, about 1.4 MB).

## Native smoke test

Validated on September 8, 2026, on Apple silicon, macOS 27.0 (26A5425a). The debug build came from this worktree's Rust source and Vite frontend. It ran as **TerminalX Issue136**, bundle ID `com.terminalx.next.issue136`, with `RACCOON_HOME=/tmp/terminalx-136-home` and Vite port **1536**. Only this validation app was stopped/restarted; the production TerminalX process (PID 6564) continued hosting both issue workers. Desktop interaction and recording used the shared atomic directory lock, released after each recording pass.

1. Leave the saved/default worktree preference enabled. Use the project rail's **Add project** picker to open the empty `/tmp/terminalx-136-empty` directory. It appears as a folder workspace; no worktree toggle or branch label is shown.
2. Select the installed Codex agent and send: “Run pwd and report the working directory. Do not modify any files.” It successfully reports `/private/tmp/terminalx-136-empty`. The canonical `/private/tmp` path is the same selected directory. [Agent screenshot](folder-agent.png).
3. Open **New tab → Terminal**. Run `pwd; test ! -e .git && echo "Folder mode: no Git repository"`. The directory matches, `.git` is absent, and the Files panel shows the empty folder without Changes/Repo/PR tabs. [Terminal screenshot](folder-terminal.png).
4. Open `/tmp/terminalx-136-notes` from the **new-session project dropdown → Add a project…** picker. Open `README.txt` in the editor. Its real contents are visible, with folder navigation and Files-only controls. [Editor screenshot](folder-editor.png).
5. Open the independent Git fixture `/tmp/terminalx-136-git`, initialized with one empty commit on `main`. The saved worktree preference is still enabled and Changes/Repo/PR tabs are available. Starting the same prompt creates `raccoon/cozy-rose-mole`; the agent reports `/private/tmp/terminalx-136-git/.raccoon/worktrees/cozy-rose-mole`. [Git controls](git-controls.png), [Git worktree session](git-worktree.png).
6. Quit and restart the validation app using the same binary, bundle and data directory. Reopen `/tmp/terminalx-136-empty/` through the picker, expand its workspace and open its saved session. The original transcript survives. Open a shell again and confirm the same cwd and absent `.git`. Refresh all projects successfully. [Restart screenshot](folder-restarted.png).
7. Compare the isolated app's CLI project/session lists before and after restart: exactly three unique canonical project paths, two `kind: "folder"` projects, unchanged session IDs, and `cwd == projectPath` with null `worktreeName`, `branch` and `baseRef` for the folder session. Both folder fixtures still have no `.git` directory.

`terminalx computer` supplied the UI actions and screenshots. Screenshot pixels were inspected with image viewing, and representative frames were decoded from the actual source recordings and inspected too. Frames from the final compressed MP4 were also decoded and visually inspected at 0:15, 1:10, 2:25, 2:45, 3:40 and 3:55. The source clips are retained locally under `target/evidence/`; the portable MP4 and screenshots above travel with this commit. The separate native title used to identify the validation build overlaps its custom toolbar; that title override is not part of the application change.

## Automated checks

All passed on this worktree:

- `corepack pnpm exec tsc --noEmit`
- `corepack pnpm vitest run` — 65 files, 372 tests passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml` — 434 passed, four existing ignored tests.

Rust/CMake were installed inside the ignored `target/tools` directory, and Cargo used the isolated `target/check` target directory. New coverage includes invalid/missing paths, canonical and symlink deduplication, project-kind persistence/defaults, folder session/workspace reloads despite requested worktrees, both UI folder pickers, folder-only panels, and preserved Git controls.

## Scope

Ordinary local directories only. Automatic detection of an external `git init` remains the follow-up noted in the issue; explicitly reopening a folder reclassifies it. Native agent execution was checked with Codex; Claude Code was not installed on this Mac. No commit, push or PR action was executed in the validation fixture. Existing Git behavior is additionally covered by the full backend/UI suites.
