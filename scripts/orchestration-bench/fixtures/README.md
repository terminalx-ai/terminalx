# Runner fixtures

Real answers of the installed `terminalx` CLI (TerminalX 0.2.31), captured on
2026-11-12 from sessions of this repository's own benchmark work, for the
parsers in `usage.mjs` and `run.mjs`. None was written by hand.

| File | Command |
| ---- | ------- |
| `sessions-usage.json` | `terminalx sessions usage <lead session> --json` |
| `sessions-usage-children-of.json` | `terminalx sessions usage --children-of <lead session> --json` |
| `wait.json` | `terminalx wait <session> --timeout 1 --json` on a session whose turn had ended |
| `error-timeout.json` | `terminalx sessions list --worktree <path> --json` when the app did not answer in time |
| `worktrees-delete-dry-run.json` | `terminalx worktrees delete <worktree> --project <project> --dry-run --json` (removes nothing) |

The one edit: in `worktrees-delete-dry-run.json` the home folder at the
start of each path is written `~`, because the repository is public.
