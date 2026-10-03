# Agent logins for cloud workspaces, from the desktop (PRO-79)

An organization stores one login per agent (Claude Code, Codex, Cursor) for
its cloud workspaces. The account service owns them: it validates a login with
the provider, encrypts it, refreshes it, and hands workspace machines only
short-lived access made from it (PRO-17). This page is about the desktop side:
Settings → Account → **Agent logins**.

## What the section does

- Lists each agent's status: connected (API key or subscription login, the
  account it belongs to when the service knows it, who may use it), revoked,
  or not connected.
- **Connect / replace with an API key.** A native secure dialog collects the
  key (`secure_prompt` in `commands.rs`, the same one provider keys use).
- **Use this Mac's login** (Claude Code and Codex). The app reads the login
  the agent's own CLI keeps on this computer and stores it for the
  organization.
- **Disconnect**, after a confirmation.

The provider's own sign-in flows ("Log in with Claude", "Sign in with
ChatGPT") are PRO-82 and are added to this same section.

## Who may do it

Owners and admins. The service refuses every credential route, the list
included, to anyone else (`organization_admin_required`), so a member sees a
sentence saying who connects logins and no controls. The desktop does not
decide this itself and cannot widen it.

A stored login is organization-wide: agents in every member's workspaces may
run on it. A login that only its owner's workspaces use does not exist on the
service yet (PRO-82 lists it as an open question), so the desktop does not
offer one.

## What never happens

- A login is never typed into, held by or returned to the webview. The page
  sends the agent, the source (`api-key` or `local-login`) and the consent;
  Rust collects the login, sends it once and clears it. The answer type
  (`AgentLogin`) has no field for a login.
- Nothing is collected or read before `authorize_agent_login` passes: both
  consents given, the request is for the organization active now, and the
  service answered the list (so the person is an owner or admin).
- A login is never logged. Failures are codes; the local reader's errors say
  only which kind of failure it was.
- A login is never read silently. "Use this Mac's login" runs only from its
  button, after the consent text and both checkboxes.

## Security review of "use this Mac's login"

| Concern | What the code does |
| --- | --- |
| Reading without the person's knowledge | Only `cloud_agent_login_connect` with `source: local-login` reads it, after consent and the admin check. For Claude Code the login is in the macOS Keychain item `Claude Code-credentials`, read with `/usr/bin/security`; macOS asks the person to allow that. The existing usage reader (`status/usage/claude_oauth.rs`) is separate and unchanged. |
| More than the login leaving the Mac | Only the part the service stores is sent: `claudeAiOauth` for Claude; `auth_mode`, `last_refresh`, `tokens`, `OPENAI_API_KEY` for Codex. Other keys in those files (for example MCP server tokens in Claude's file) are dropped before upload. |
| The wrong account | With `CLAUDE_CONFIG_DIR` set, only that directory's file is read, never the Keychain. Codex follows `CODEX_HOME`. |
| A refresh token on a workspace machine | Unchanged from PRO-17: machines receive short-lived grants; the stored login stays with the service. |
| Who can use it afterwards | Stated in the consent: every member's workspaces in the organization. The service's `managers` scope cannot be chosen from the desktop route today. |
| Revoking | Disconnect in the same section; the service stops handing it out at once. |
| A dialog left open, or two at once | One connect at a time (`cloud_provider_operation_in_progress`); the secure field is emptied whichever way the dialog ends. |

Not verified, and for the owner:

- **Sharing one refreshable login between this Mac and the service.** The
  uploaded Claude or Codex login includes its refresh token, and the service
  refreshes it. If the provider rotates refresh tokens, the CLI on this Mac
  and the service may sign each other out. This was not tried against a real
  provider. The web console's paste field has the same property.
- **Terms of use** for running a personal subscription in an organization's
  workspaces: the same open question as PRO-82.
