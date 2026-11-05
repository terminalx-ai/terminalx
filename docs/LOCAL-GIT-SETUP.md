# Local GitHub and remote setup (PRO-166)

The PR tab and Settings → Integrations use `gh_connection_status` to distinguish
an absent CLI, a signed-out account, a connected account, and a failed check.
Finding `gh` on PATH alone is not proof of a login. The check runs `gh auth
status --active` with a 15-second deadline. A network failure stays a failed
check rather than claiming the person is signed out. Command output is available
only through **Show details**.

**Connect GitHub** opens the existing terminal view in a dialog. The dedicated
`gh_login_start` command asks the local runtime for `runtime.pty.githubLogin`.
That operation accepts only a `github-login-<uuid>` pane id, runs the fixed
`gh auth login --web` command in the person's home, and cannot launch a supplied
command or reuse a session's terminal. This works before the person has created
any session, including from Settings. The view subscribes before launch,
refreshes connection state on exit, and closes only its own PTY on cancellation
or unmount, including a spawn that completes late. Credentials remain owned by
the GitHub CLI.

Before a local push, the Repo panel reads `git remote`. With no destination,
**Add a remote** adds `origin` using a literal argument to `git remote add`.
Git refuses to overwrite an origin added concurrently. When signed in, the same
form offers repository creation through `gh repo create --source=.
--remote=origin`; visibility defaults to private and is explicit. Both flows
leave publishing commits to Push. The PR panel also offers remote setup after
connecting GitHub. Cloud workspaces continue using their existing GitHub App
credentials and error explanations; local login does not affect them.

Push permission errors are explained as denied repository access, not a missing
remote or a signed-out GitHub account: Git SSH/HTTPS credentials can differ from
the CLI login. Diagnostic output is collapsed behind **Show details**.

Coverage: `GitRecovery.test.tsx` exercises the recovery actions and hidden
diagnostics; `PrPanel.test.tsx` retains PR ownership/cleanup safeguards;
`github::connection_tests` checks a real signed-out CLI in an isolated config;
`git::tests` adds a remote and pushes to a real bare repository.
