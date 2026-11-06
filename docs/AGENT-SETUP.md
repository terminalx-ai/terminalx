# Local agent setup

Settings → Agents and the new-session setup instructions read installation and
local login status through `src/lib/agentReadiness.ts`. The native
`check_agent_readiness` command invalidates binary discovery before probing the
CLI. A failed or unsupported probe is **Login not checked**, never evidence
that the agent is missing or signed out. Finding a local login does not prove
provider access or model availability.

While a setup view is mounted, returning to the app (focus, visibility or resume)
rechecks readiness. An embedded command PTY exiting also rechecks: the Codex
sign-in action runs `codex login` in one of these terminals. The exit itself
does not establish successful sign-in. Returning from an interactive login
inside a session to Settings mounts a fresh check.

Settings cards also recheck every two minutes while the document is visible.
Leaving Agents removes that polling; the new-session view does not poll.
Listeners and pending resume work are disposed on unmount or agent selection
change, and an older result cannot replace a newer check.

Each `AgentSetupCard` owns one readiness value for its header, setup body and
install action. The session store's harness list supplies agent metadata, not
the card's status. Both **Check again** and the section's **Re-check** remain
available. Organization logins are separate; these checks only inspect local
agents and do not sign in, copy credentials or start model turns. (PRO-170)

## Installing and signing in from the app (PRO-152)

**Install and sign in** (and **Sign in** for an installed agent that is signed
out) runs in an embedded terminal on the welcome screen, in Settings → Agents
and in the new-session view. One flow per agent lives in
`src/lib/agentSetupFlow.ts`, so a run started on the welcome screen is the
same run that Settings shows.

- **Install** runs the provider's official native installer, which needs no
  Node or package manager: Claude Code's `https://claude.ai/install.sh` (with
  `bash`; it puts `claude` in `~/.local/bin`), and Codex's
  `https://chatgpt.com/codex/install.sh` (with `sh` and
  `CODEX_NON_INTERACTIVE=1`, so it asks nothing and does not start Codex; it
  puts `codex` in `~/.local/bin`). `~/.local/bin` is one of the directories
  `binpath` searches, so the new CLI is found without a restart.
- **Sign in** runs the CLI's own login (`claude auth login`, `codex login`),
  which opens the browser. The terminal accepts input, so a code can be
  pasted when the CLI asks for one.
- After each step exits with 0, the harness list and readiness are checked
  again and the result is announced to every readiness view
  (`announceReadiness`). An install that leaves the agent signed out goes
  straight on to sign-in in the same terminal, with the installer's output
  kept above. Ready ends the run and closes its terminal. The exit code alone
  is never taken as success.
- Readiness checks run one at a time (`readiness::check_binary`). An exit
  makes every readiness view check again, and two Codex app servers starting
  together in a new `CODEX_HOME` race to create its state database. The loser
  exits with "failed to initialize sqlite state runtime", which reads as
  **Login not checked** (seen with Codex 0.167.0 right after its install).
  A check right after an install that still cannot tell the login is asked
  again twice, 1.5 s apart, before the sign-in is given up on.
- The welcome screen shows the setup when no agent is installed, when every
  installed agent is signed out (a sign-in left half way), and for the rest of
  the session once a run has started there. Whether every agent is signed out
  comes from the window's last answer for each agent (any check counts, and
  one from the last five minutes is used as it is), asked for one agent at a
  time and stopping at the first that is not signed out. A reader who is set
  up costs one check at most, and the welcome screen does not check again
  when the app comes back to the front.

Each step runs in a pane of no session, `setup:<agent>:<run>`
(`src-tauri/src/harness/setup.rs`). The webview names the agent and the step.
The runtime (`runtime.pty.agentSetup`) makes the command from the harness
registry. It runs one step at a time per agent, whichever pane asks: while
any of the agent's setup panes runs, another start is refused, decided under
one lock. Two installers would write the same folders, and two sign-ins
would wait on the same local callback. A window that is refused (another
window started the run, or this one did before its page was loaded again)
asks `runtime.pty.agentSetupRunning` for the run's pane and step, and follows
that run as if it had started it. The pane is not a shell tab: no window
lists it, and the Resources view calls it "<Agent> setup". A small POSIX
wrapper around each step decides the exit code. Its `curl` calls (the
download, and the check made after a failure) allow only HTTPS, for
redirects as well (`--proto =https --proto-redir =https`).

| Exit | Meaning | Shown as |
| --- | --- | --- |
| 70 | A folder the installer writes (`~/.local/bin`, `~/.local/share/claude`, `~/.claude`, `~/.codex`) is not writable; checked before anything is downloaded | permission, with the folder named in the output |
| 71 | `curl` could not reach the provider, or a failed step's provider no longer answers | offline |
| 72 | The installer was refused, or what came back is not a script (a captive portal's page) | failed download |
| 73 | The installer ran and failed while the provider answers | installer failed |
| 74 | The sign-in exited without signing in | sign-in did not finish |

Every failure offers **Try again**, which reruns the failed step in the same
terminal, and the setup guide. **Cancel** kills the step and leaves no error.
A step canceled while it was still starting is killed again once its start
returns, since the first kill may have reached the runtime before the step.
An exit of a canceled run that arrives late is ignored, and the next run uses
a new pane.

A terminal can be in one place at a time. When two views show the same run
(the new-chat dialog over the welcome screen), the one mounted last holds the
terminal and the other says where it is. When that view goes, the one before
it takes the terminal back (`useSetupTerminalHost`). Windows has no installer here (`installable` is false), so only the
commands to copy are shown there.

Tests: `harness::setup::tests::e2e` runs install → sign-in → Ready, and each
failure code, through a real terminal and login shell, with `curl` fetching a
stub installer over `file://` and a stand-in CLI. `agentSetupFlow.test.ts`
covers the transitions, `AgentSetupCard.test.tsx` covers Settings, and
`AgentFirstRun.test.tsx` covers the welcome screen from no agent to Ready.
