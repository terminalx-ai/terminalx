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

Each step runs in a pane of no session, `setup:<agent>:<run>`
(`src-tauri/src/harness/setup.rs`). The webview names the agent and the step.
The runtime (`runtime.pty.agentSetup`) makes the command from the harness
registry and refuses one while the pane still runs. The pane is not a shell
tab: no window lists it, and the Resources view calls it "<Agent> setup". A
small POSIX wrapper around each step decides the exit code:

| Exit | Meaning | Shown as |
| --- | --- | --- |
| 70 | A folder the installer writes (`~/.local/bin`, `~/.local/share/claude`, `~/.claude`, `~/.codex`) is not writable; checked before anything is downloaded | permission, with the folder named in the output |
| 71 | `curl` could not reach the provider, or a failed step's provider no longer answers | offline |
| 72 | The installer was refused, or what came back is not a script (a captive portal's page) | failed download |
| 73 | The installer ran and failed while the provider answers | installer failed |
| 74 | The sign-in exited without signing in | sign-in did not finish |

Every failure offers **Try again**, which reruns the failed step in the same
terminal, and the setup guide. **Cancel** kills the step and leaves no error.
An exit of a canceled run that arrives late is ignored, and the next run uses
a new pane. Windows has no installer here (`installable` is false), so only the
commands to copy are shown there.

Tests: `harness::setup::tests::e2e` runs install → sign-in → Ready, and each
failure code, through a real terminal and login shell, with `curl` fetching a
stub installer over `file://` and a stand-in CLI. `agentSetupFlow.test.ts`
covers the transitions, `AgentSetupCard.test.tsx` covers Settings, and
`AgentFirstRun.test.tsx` covers the welcome screen from no agent to Ready.
