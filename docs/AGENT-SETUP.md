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
