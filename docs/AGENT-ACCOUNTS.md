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
which model is in use. With automatic switching on, the runtime makes this
move itself (below).

## Switching automatically (#981)

**Setting.** Settings → Agents, under an agent's accounts, only with two or
more subscription accounts; per agent and off by default. It is kept on the
agent's entry in `agent-logins.json` (`autoSwitch`, unknown fields kept):

- **Threshold**, 50–100 % (default 90): an account is *full* once any window
  that applies to the tab (5-hour, weekly, or the model's own weekly window)
  is at or past it, or a usage-limit error was received on it.
- **Accounts to use**, an ordered checklist. Subscriptions are checked by
  default; an API key is unchecked and marked "billed per request", and is
  only chosen when no checked subscription has room.
- **Order**: *Most room left* (default) or *In my order*.
- Notifications per switch and when no account has room, each can be off.
- Per project, Settings → Project → accounts: **Never switch accounts in this
  project** (`neverProjects`).
- Turning it on shows a note that the person is responsible for each
  provider's terms.

**Decision.** One pure function, `agent_accounts::auto_switch::decide`, in the
runtime (terminalx-serve). An account is *available* when it is signed in,
checked, not full, its usage read in the last 30 minutes, and its plan was not
seen lacking the tab's model (a model the tab's settings ask for, which the
agent fell back from right after a switch onto it; remembered six hours). An
account a tab left counts again only after
its window resets or its usage drops 10 points below the threshold. When
every account is above the threshold the tab stays, unless its own account
is at its limit: then it moves to the one with the most room, so an
unattended run goes on. When every account is at its limit the tab says so
with the earliest reset. Several tabs leaving one account are
spread: each recent arrival costs an account 10 points of room for 5 minutes.

**When.** Between turns only: never during a turn, a permission request, a
question, a compaction, background work, or within 20 s of typing in the
composer or the terminal. At most one automatic switch per tab per 5 minutes;
a move by hand resets that pause. A limit hit mid-turn switches as soon as the
turn ends and sends `continue`. Follow-ups held for the tab wait while a
switch is owed at a turn's end and are sent on the new account (after the
`continue`); one the person sends now goes where the tab is. A new tab whose account is full starts on the
chosen account instead ("Started on Personal: Work is at 93 % …"), and New
Session's account picker shows that choice and why. The picker sends the
account it moved off, so the runtime decides again as the tab starts and the
move is said in the conversation and kept in the log.

**How.** The switch is #980's *Continue with*: restart on the other account
and resume. A switch refused (the agent reports a sign-out within 2 minutes)
goes back to the original account and tries the next one once; the refused
account is skipped for 30 minutes or until the person moves a tab onto it.
Accounts within 15 points of the threshold are polled every minute; the
runtime checks running tabs every 30 s.

**Telling the person.** The conversation (desktop and phone) shows "Switched
from Work to Personal: Work reached 91% of its 5-hour limit." A tab out of
view gets a notification per switch and when no account is left. The usage
popover marks full accounts and says which account new sessions start on.
Every switch is kept 30 days in `agent-account-switches.jsonl` and listed in
Settings → Agents.

## Security and privacy

- No token is copied, logged, sent to the webview, or sent to a phone. Each
  login stays where its agent wrote it; a refresh token exists in one place.
- Account directories are 0700. Labels and emails are display data: they stay
  out of logs and diagnostics, and privacy mode (PRO-244) never sends them.
- Removing an account revokes it through the agent's logout before anything
  is deleted.

## Decisions on the issue's open questions

1. Resuming across accounts with a shared `projects` directory: **confirmed**
   against the installed Claude Code 2.1.325 (see "Probe results" below). A
   conversation written under one `CLAUDE_CONFIG_DIR` resumed under a second
   directory whose `projects` is a symlink to the same place.
2. Codex is always given `cli_auth_credentials_store = "file"` for added
   accounts, so the keyring question does not arise; if an organization
   policy forces the keyring, the add flow reports the agent's error.
3. The project default is local only.
4. "This Mac's login" is always selectable, including when
   `CLAUDE_CONFIG_DIR` is set in the person's shell profile; it then means
   that directory.

## Probe results (Claude Code 2.1.325, 2026-11-15)

- **Keychain entry per directory.** With `CLAUDE_CONFIG_DIR` set, Claude Code
  keeps the login in the generic-password item
  `Claude Code-credentials-<h>`, account `$USER`, where `<h>` is the first 8
  hex characters of SHA-256 of the directory path as given (NFC-normalised).
  With no `CLAUDE_CONFIG_DIR` it is the unsuffixed `Claude Code-credentials`,
  the person's own, which TerminalX never names, reads for an account, or
  deletes. `agent_accounts::claude_dir::keychain_service` computes the name
  (only for an ASCII path; for any other path the agent's own logout is what
  removes the item). `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides which
  directory the item is keyed to, so a launch on an account unsets it.
- **Resume across directories.** A conversation written under one
  `CLAUDE_CONFIG_DIR` resumed under a second directory that shares
  `projects` with it by symlink, so the transcript is found in the shared
  `projects/` whichever directory wrote it. Not confirmed: a resume across
  two *different* signed-in subscriptions, which needs a second account.

## How the core implements it (`src-tauri/src/agent_accounts/`)

- **Index.** `agent-logins.json` stays `agent_keys`' file. Per agent it gains
  `accounts` (added accounts: `id`, `kind`, `label`, `email`, `plan`,
  `organization`, `organizationId`, `addedAt`, and for an `apiKey` account the
  Keychain revision of its key), `defaultAccount`, `projectDefaults`
  (project id → account id) and `keyLabel` (the saved key's label). Every
  field this build does not know is kept on save, at the top level (an agent
  it does not know, a version field) and inside each agent's entry and each
  account. A file without these fields reads as `local` alone, plus the saved
  key as account `api-key` when one is saved; while `defaultAccount` is
  unset, `mode` decides the default exactly as before (the saved key when
  `api_key`, else `local`), so with one account nothing changes.
- **Ids.** `local`, `api-key`, and 16 lowercase hex characters for added
  accounts. Only such ids name a directory.
- **Directories.** `$TERMINALX_HOME/agent-accounts/claude/<id>/` (0700) is
  `CLAUDE_CONFIG_DIR`, with `settings.json`, `CLAUDE.md`, `skills`,
  `commands`, `agents`, `plugins` and `projects` linked to the person's
  directory and `mcpServers` mirrored into its own `.claude.json` at every
  launch. `$TERMINALX_HOME/agent-accounts/codex/<id>/` (0700) is `CODEX_HOME`
  while Codex signs in (its `config.toml` sets the file store) and holds
  `auth.json`; the tabs' managed home is `…/codex/<id>/home`, with
  `auth.json` linked to `../auth.json`, `sessions` linked to
  `$TERMINALX_HOME/codex/sessions`, and the reader's settings mirrored as in
  the default home (plus `cli_auth_credentials_store = "file"`).
- **Sign-in.** Claude Code: `claude auth login --claudeai` runs as a child of
  the desktop (under the watchdog of `codex_device_login`, so it dies with
  the app) with `CLAUDE_CONFIG_DIR` set and the variables that would outrank
  it removed; it opens the browser itself. Codex: the device-code login of
  `codex_device_login` with `CODEX_HOME` the account's directory. The app
  polls `agent_accounts_add_finish`; when the CLI has ended, the email, plan
  and organization are read from the directory (`.claude.json`'s
  `oauthAccount`, or `auth.json`'s ID-token claims). The same address (and
  organization id, where both report one) as a listed account or as This
  Mac's login is a duplicate: the new directory is logged out and deleted and
  the existing account named.
- **Launch grant.** `agent_keys::launch_grant_on(harness, cwd, Choice
  { account, project })` resolves the account (asked for, project default,
  agent default, `local`), and for an added subscription sets
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, unsets `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` and the
  cloud-provider switches, and lists the directory variable in
  `after_profile` so it is set again after the login shell's profile
  (`cloud_grants::env_prefix`). `launch_grant(harness, cwd)` is unchanged.
  An added account's directory deleted outside the app refuses the launch
  ("Sign in again") rather than starting on another login.
- **Removal.** `agent_accounts_remove` first returns the running tabs on the
  account (from the runtime's launch registry, which now records the account
  each tab started on) unless `confirmed`; then the agent's own logout runs
  in the account's directory, and only if it succeeded is the account
  dropped from the index, its Keychain entry deleted and its directory
  removed (links inside it are removed as links, never followed).

## Out of scope

Resuming a tab by itself when a limit resets, cloud workspaces (they use organization
agent logins, PRO-107), agents other than Claude Code and Codex, and syncing
accounts between Macs.
