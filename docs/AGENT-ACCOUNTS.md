# Agent accounts: several Claude Code and Codex logins (#980)

A person can sign in to several Claude Code accounts and several Codex
accounts, stay signed in to all of them, and choose one per session. Two
sessions can run on two accounts of the same agent at the same time.

This page is the design the implementation follows. The issue (#980) holds
the research into other tools; the decisions are repeated here so nothing
depends on reading it.

## Model

An **agent account** is one way for one agent to sign in.

- Agents: `claude` and `codex`. The model must allow others later (OpenCode),
  so the agent is a string-keyed enum, not two hard-coded fields.
- Kinds: `subscription` (claude.ai or ChatGPT sign-in) and `apiKey`.
- Every agent always has the account **This Mac's login**, id `local`. It is
  the person's own `~/.claude` (or `$CLAUDE_CONFIG_DIR` of the app's process)
  and `~/.codex`. TerminalX never moves, copies or deletes it, and a `claude`
  or `codex` run in a plain terminal outside TerminalX keeps using it. It
  cannot be removed, only signed out with the agent's own logout.
- Today's single saved API key (PRO-306, `agent_keys.rs`) is one account of
  kind `apiKey`. More than one may be saved; each is its own Keychain item.
- Each account has an id (opaque, random, filesystem-safe), a label the person
  can edit, a kind, and for subscriptions the email and plan read after
  sign-in (as `agent_local_login.rs` reads them). The default label is
  "email · plan".
- The index is `$TERMINALX_HOME/agent-logins.json`. It gains, per agent, the
  list of accounts and the default account id. It holds ids, labels, kinds,
  emails and plans only, never a token. A file written before #980 loads
  unchanged as "only `local`" (plus the saved key as one `apiKey` account when
  the mode was `api_key`), and fields it does not know are kept on save.
- Defaults: a **default per agent** (index), and a **default per project**
  that overrides it. The project default is stored locally only (not in the
  repository's shared settings), keyed by project id.
- A tab's account is fixed at launch and recorded with the launch (as
  `record_launch` records the login today). It changes only by restarting the
  tab's agent on another account.

## Where an account lives

### Claude Code

Each added subscription account has a directory,
`$TERMINALX_HOME/agent-accounts/claude/<id>/` (mode 0700), used as
`CLAUDE_CONFIG_DIR`.

- Per account: the login (the Keychain entry Claude Code keys to the
  directory, or `.credentials.json`) and `.claude.json`.
- Shared with the person's own directory by symlink: `settings.json`,
  `CLAUDE.md`, `skills`, `commands`, `agents`, `plugins`, and `projects`
  (session history). A link whose target does not exist yet is still made, so
  the first write lands in the shared place.
- User-scope MCP servers live in `.claude.json`, so the `mcpServers` of the
  person's own `.claude.json` are mirrored into the account's file each time a
  tab starts. Their OAuth logins are not; Settings says so.
- Folder trust is written to the account's `.claude.json`.
- Because `projects` is shared, the app keeps one transcript root and a
  conversation started on one account resumes on another.

### Codex

Each added subscription account has
`$TERMINALX_HOME/agent-accounts/codex/<id>/auth.json`, written by Codex itself
during sign-in with `cli_auth_credentials_store = "file"` and `CODEX_HOME`
pointing at that directory. The managed home (`harness/codex/home.rs`) is
built per account: the same links and mirrored settings as today, with
`auth.json` linked to that account's file and `sessions` shared with the
default managed home, so rollouts are found wherever they were written.
`local` keeps today's home and its link to `~/.codex/auth.json`.

### API key accounts

An `apiKey` account is launched as a saved key is today (PRO-306): Claude
Code through the `apiKeyHelper` in `--settings`, Codex through the
`terminalx-api-key` model provider. It uses the `local` configuration
directory for everything else.

## Signing in and out

- **Add account** runs the agent's own login in the new directory, in the app,
  like the existing install and sign-in flow (PRO-152): `claude auth login`
  with `CLAUDE_CONFIG_DIR` set, `codex login` (or the device code flow,
  `codex_device_login.rs`) with `CODEX_HOME` set and the file store.
  TerminalX never sees a password and never handles the OAuth exchange.
- After sign-in the app reads the email and plan. If an account with the same
  agent and email (and organization, where the agent reports one) is already
  listed, the new directory is logged out and deleted and the person is told
  which account it is; it is not added twice.
- **Sign in again** on one account runs the login in that account's directory
  only. Login state and expiry are reported per account (#667, PRO-170).
- **Remove account** first names the running tabs that use it, then runs the
  agent's own logout with that account's directory, then deletes the
  directory and (for Claude Code) its Keychain entry. Only that account's
  files are touched.
- A Claude Console sign-in without an API key is stored outside the
  configuration directory, so it cannot be a second account. It is not
  offered; the add flow says why.
- Managed settings (`forceLoginOrgUUID`, `forceLoginMethod`) may refuse an
  account; the agent's own error is shown on that account.
- An account directory deleted outside the app shows "Sign in again".

## Launching on an account

- The runtime (`terminalx-serve`) starts the agents. It gets the account id
  with the launch, resolves it, and sets `CLAUDE_CONFIG_DIR` (Claude Code) or
  `CODEX_HOME` (Codex) in the PTY's environment, which is set before the
  login shell's profile runs, and unsets afterwards the variables that would
  outrank it, as it does for the API key variable.
- `CLAUDE_CONFIG_DIR` joins `CODEX_HOME` in `store/environment_reserved.json`.
- Terminal tabs of a session carry the same variables, so `claude` or `codex`
  typed by hand there uses the session's account.
- Everything that assumes one directory follows the tab's account: transcript
  root and agent data (`harness/claude/transcript.rs`, `agent_data.rs`,
  `cleanup.rs`), folder trust (`harness/claude/trust.rs`), sandbox paths
  (`harness/provider_sandbox.rs`, `harness/mod.rs`), the Codex home, and
  lending a login to an organization (`agent_local_login.rs`, which asks
  which account).
- A launch with no account id, or an id the runtime does not know, uses the
  project default, then the agent default, then `local`. A runtime older than
  #980 ignores the field and starts on `local`; the desktop detects that from
  the runtime's reported capabilities and the tab says so instead of failing.
- The CLI (`terminalx sessions create … --account <id|label>`) and the phone
  list accounts by id and label and can choose one when they start a session.
  Neither ever receives a token.

## Choosing an account in the app

- Default per agent in Settings → Agents; default per project in the
  project's settings.
- Per session in the shared launch settings (New Session, issue start,
  handoff), next to model and effort. The picker appears only when the agent
  has more than one account.
- A tab shows its account (label in the tab header, a small mark in the tab
  strip) only when its agent has more than one account. With one account,
  nothing in the app changes.
- "Switch account" on a tab restarts its agent on another account and resumes
  the same conversation.

## Usage per account

- Each subscription account is polled with its own token, read from its own
  Keychain entry or, when that is not found, the directory's
  `.credentials.json` (Claude Code), or its own `auth.json` (Codex). The app
  never refreshes a token; it reads what the agent wrote.
- Accounts with running tabs are polled more often than idle ones.
- One account's failure shows "usage unavailable" for that account only.
- An `apiKey` account shows no subscription windows.
- The usage popover and Stats show each account's windows under its label;
  the tab's own usage shows the account it runs on.

## At a usage limit

The limit message in a tab offers **Continue with <label>** for each other
account of that agent whose windows have room. It restarts the agent on that
account and resumes the conversation. If the resumed conversation's model is
not on that account's plan, the agent falls back as it does and the tab says
which model is in use. Rotation is always the person's choice; automatic
rotation is out of scope.

## Security and privacy

- No token is copied, logged, sent to the webview, or sent to a phone. Each
  login stays where its agent wrote it; a refresh token exists in one place.
- Account directories are 0700. Labels and emails are display data: they stay
  out of logs and diagnostics, and privacy mode (PRO-244) never sends them.
- Removing an account revokes it through the agent's logout before anything
  is deleted.

## Decisions on the issue's open questions

1. Resuming across accounts with a shared `projects` directory is confirmed
   by a probe against the installed Claude Code as part of the core work; the
   result is recorded here.
2. Codex is always given `cli_auth_credentials_store = "file"` for added
   accounts, so the keyring question does not arise; if an organization
   policy forces the keyring, the add flow reports the agent's error.
3. The project default is local only.
4. "This Mac's login" is always selectable, including when
   `CLAUDE_CONFIG_DIR` is set in the person's shell profile; it then means
   that directory.

## Out of scope

Automatic rotation between accounts, cloud workspaces (they use organization
agent logins, PRO-107), agents other than Claude Code and Codex, and syncing
accounts between Macs.
