# Local GitHub and remote setup (PRO-166)

The PR tab and Settings → Integrations use `gh_connection_status` to distinguish
an absent CLI, a signed-out account, a connected account, and a failed check.
Finding `gh` on PATH alone is not proof of a login. The PR panel passes its
checkout so the check selects the remote's host (including gh's explicit base
remote and host/repository environment overrides). Settings and repository
creation use `GH_HOST`, or github.com when it is unset. The selected host is
shown in the setup card and passed to login too.

Remote selection follows gh's local resolver: SSH URLs and SCP-style destinations
are expanded with `ssh -G`, including SSH config aliases, patterns and includes.
The SSH endpoint `ssh.github.com` becomes `github.com`, and SSH transport ports
are not used as API ports. The resolver then keeps github.com and hosts configured
in gh's `hosts.yml` (including accounts stored in the keychain), before applying
gh's sole-configured-host preference, explicit base, and upstream/github/origin
ordering. A GitLab upstream therefore cannot displace a GitHub origin. The config
directory follows `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, then gh's platform default;
legacy `hosts` in `config.yml` is also supported. Only host names are used; tokens
are neither returned nor used by this step. `GH_HOST` and `GH_REPO` remain explicit
overrides, including for Enterprise hosts not yet configured in gh.

The check runs `gh auth status --active --hostname <host>`, with a 15-second
deadline. An absent account requests login. A failed active-account check is
ambiguous: gh 2.70 calls transport failures an invalid token too. In that case,
`gh api --hostname <host> --include --silent user` distinguishes an HTTP 401
from transport, rate-limit, and server errors, with its own 15-second deadline.
Only the 401 requests login; connection failures offer retry. Checking another
configured host cannot override this host's result. Unknown hosts are rejected
by gh's account selection before the API probe. Command output is available
only through **Show details**.

**Connect GitHub** opens the existing terminal view in a dialog. The dedicated
`gh_login_start` command asks the local runtime for `runtime.pty.githubLogin`.
That operation accepts only a `github-login-<uuid>` pane id, runs the fixed
`gh auth login --web --hostname <host>` command in the person's home. The host
is validated before shell interpolation; callers cannot supply a command or
reuse a session's terminal. This works before the person has created any session,
including from Settings. The view subscribes before launch and refreshes after
successful exit. A nonzero or unknown exit keeps the dialog and its terminal
output, collapsed behind **Show details**, until the person closes it. Closing
refreshes the connection and cancels only this login's PTY, including a spawn
that completes late. Credentials remain owned by the GitHub CLI.

Before a local push, the Repo panel reads `git remote`. With no destination,
**Add a remote** adds `origin` using a literal argument to `git remote add`.
Git refuses to overwrite an origin added concurrently. When signed in, the same
form offers repository creation through `gh repo create --source <primary>
--remote=origin`; visibility defaults to private and is explicit. Git's NUL-delimited
worktree list identifies the primary checkout (or bare repository), whose config
is shared with the session. This avoids gh 2.70 rejecting linked checkouts' `.git`
files, and leaves all branches and commits in place. Both flows leave publishing
commits to Push. The PR panel also offers remote setup after
connecting GitHub. Cloud workspaces continue using their existing GitHub App
credentials and error explanations; local login does not affect them.

Push permission errors are explained as denied repository access, not a missing
remote or a signed-out GitHub account: Git SSH/HTTPS credentials can differ from
the CLI login. Diagnostic output is collapsed behind **Show details**.

Coverage: `GitRecovery.test.tsx` exercises the recovery actions and hidden
diagnostics; `PrPanel.test.tsx` retains PR ownership/cleanup safeguards;
`github::connection_tests` checks a real signed-out CLI, unrelated-host credentials,
and a failing local proxy in isolated configs; it also exercises host selection
and shared remote configuration from a real linked worktree. SSH destinations,
real OpenSSH aliases, and mixed GitLab/GitHub remotes are compared with the
installed gh's selected API endpoint through a rejecting local proxy, without
external requests. `git::tests` adds a remote and pushes to a real bare repository.
