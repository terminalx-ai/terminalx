# Agent logins for cloud workspaces, from the desktop (PRO-79, PRO-107)

Each organization stores one login per agent (Claude Code, Codex, Cursor) for
its cloud workspaces. The account service owns them: it validates a login with
the provider, encrypts it, refreshes it, and hands workspace machines only
short-lived access made from it (PRO-17). Nothing is stored per user. This
page is about the desktop side: each organization's page in Settings →
Organizations → **Agent logins**, and the Agent logins step of organization
setup.

## Where they are set (PRO-107)

Agent logins are a setting of each organization, not of the account.

- **The organization's page.** Settings → Organizations lists every
  organization the person belongs to, each with a **Settings** button that
  opens its page. The page names the organization in its heading, in "Agent
  logins for …", and in every consent, confirmation and native dialog. Its
  agent logins work for **any** organization the person belongs to, chosen
  explicitly: the active (default) one is never switched for it, and another
  organization's logins are never touched.
- The page also holds the organization's other settings (members, compute,
  GitHub, workspace settings, environment, diagnostics, teardown). The
  service keeps those on the active organization, so they are shown on the
  active organization's page; another organization's page says so and offers
  to make it the active (default) organization.
- **Settings → Account** no longer has the section. It links to the active
  organization's page instead.
- **Organization setup.** Organization details → Compute connection → **Agent
  logins** → Setup completion. Right after the cloud is chosen, the setup
  shows the same Agent logins section for the new organization. **Continue**
  needs at least one agent connected; connecting one does not leave the step
  by itself, so several can be connected. **Set up later** skips it. After a skip,
  the later steps and setup completion say which agents have no login and
  link to the organization's page; a setup that went on with a login says
  nothing more about them. The setup's repository step likewise links to the
  organization's page, where GitHub is. A setup record from before
  the step goes back to it only when no agent has a login and its setup
  workspace was not chosen to run without an agent. The choice is
  kept in the setup record (`logins: "connected" | "later"`).

How the organization travels: every agent-login command takes it
(`orgId`, or `organizationId` in the consent; none is the active one).
`agent_login_context` in `cloud_workspaces.rs` checks the page's context
revision against the active context (same account, same generation, same
default organization as when the person chose), then takes the named
organization by membership (`context_in`, CS-18). Requests go to
`/v1/desktop/orgs/{that organization}/cloud-workspace-credentials…`, and an
answer is fenced by that membership, not by which organization is active: a
default switch does not drop a request in flight for another organization,
leaving it does.

The server authorizes these routes by membership and the owner or admin role
in the path organization (terminalx-saas, PRO-107). A server from before
answers `active_organization_required` for a non-active organization; the
page says the server changes logins only in the active organization and
offers to make it active. A server without the multi-organization capability
is refused locally with `cloud_organization_unavailable`.

## What the section does

- Lists each agent's status: connected (API key or subscription login, whose
  it is when the service knows, who may use it), revoked, or not connected.
- Flags a login whose configurer has left (`configurerLeft` in the service's
  list, terminalx-saas #186): the person who connected a subscription login
  is no longer an owner or admin. The login is kept and keeps working on
  their subscription; the row says so, and that logging in again takes it
  over.
- **Log in with Claude** (the first way offered for Claude Code). The
  account service runs the sign-in and keeps a login it renews. See below.
- **Connect / replace with an API key.** A native secure dialog collects the
  key (`secure_prompt` in `commands.rs`, the same one provider keys use).
- **Log in with ChatGPT** (the first way offered for Codex, PRO-79). Codex's
  own device-code login runs on this Mac in a throwaway home; the one-time
  code is shown in the page's dialog and nowhere else, and the login Codex
  writes is uploaded by the app and the home deleted.
- **Lend this Mac's Claude Code or Codex sign-in.** The app lends the
  short-lived access token of the sign-in on this computer. See below.
- **Disconnect**, after a confirmation that names the organization and says
  it reaches every workspace of it.

"Log in with Claude" (PRO-82's server-side sign-in) and "Log in with
ChatGPT" are the lasting ways to connect a subscription; lending this Mac's
sign-in is the secondary, temporary one. Cursor connects with an API key.

## Who may do it

Owners and admins. The service refuses every credential route, the list
included, to anyone else (`organization_admin_required`), so a member sees a
sentence saying who connects logins and no controls. The desktop does not
decide this itself and cannot widen it.

A member does see, per agent, whether a workspace of theirs would get a
login. That comes from the create check (`cloud-workspaces/preflight?agent=`,
which any member may ask, PRO-73), not from the list: it answers pass or
fail and carries no identity. A fail is the same answer for "no login is
stored" and "the stored one is limited to managers' workspaces", so the
member's row names both. A server that does not answer per agent gets "the
service did not say".

## Where other pages send people

A first prompt refused for lack of a login
(`cloud_workspace_agent_credential_required`), a launch that failed with
`agent-sign-in-required`, and an agent tab that needs sign-in all name
Settings → Organizations → Agent logins and carry an "Open Agent logins"
button (`AgentLoginsLink`). It opens the page of the organization the
workspace belongs to (the create form's, the workspace's, the tab's), not the
active one, with its Agent logins scrolled into view (`openAgentLogins` in
`settingsLinks.ts`). The same holds in the new-session view and in the setup
step's create check. The create refusal is one code for two causes (see above):
an owner or admin is never held back by the managers-only limit, so they are
told the login is missing or revoked; anyone else is told it is one of the
two and that an owner or admin can see which.

## Who a stored login reaches (`sharedUse`)

The account service keeps a scope on each login: `organization` (agents in
every member's workspaces may run on it) or `managers` (only workspaces that
nobody but owners and admins can drive). The desktop **does not offer a
choice of scope, and so never sends one**: no request it makes carries
`sharedUse` (the API-key and lend `PUT`, and `…/claude/login-complete`).
The service then decides:

- **A first login** takes the service's default. That is `organization`,
  unless the operator turned on the narrow default for subscription logins.
  The desktop cannot see that switch, so it says "by default, agents in
  every member's cloud workspaces" and points at the row, which shows what
  the service stored.
- **A login that replaces one of the same kind** (a sign-in or a lent
  sign-in over a subscription login, an API key over an API key) keeps the
  stored scope. Logging in again never widens a login someone narrowed to
  `managers`. The page and the native dialogs say "this keeps who can use
  the login now: …" with the stored scope, read from the list at that
  moment.
- **A login that replaces one of another kind** (a sign-in over an API
  key, or the reverse) is never wider than the stored login: the service
  gives it the narrower of the stored scope and the default for its kind
  (terminalx-saas #187; a server without it keeps the stored scope, which
  fits the same words). It is not described as a first login. The page and
  the native dialogs say "this keeps who can use the login now, or fewer:
  at most …" with the stored scope, and point at the row for what was
  stored, because the desktop cannot see the service's default.

In no case does a replacement from the desktop widen who can use a login.

No client has a control for the scope yet; the service's routes accept
`sharedUse`. If the desktop gets one, the value is sent only when the person
picked it.

Until #429's follow-up the desktop sent `sharedUse: "organization"` with
every sign-in, which widened a `managers` login each time an admin logged in
again.

## What never happens

- A login is never typed into, held by or returned to the webview. The page
  sends the agent, the source (`api-key` or `local-login`) and the consent;
  Rust collects the login, sends it once from one zeroized buffer and clears
  it. The answer type (`AgentLogin`) has no field for a login.
- Nothing is collected or read before `authorize_agent_login` passes: both
  consents given, the request is for the organization the page names in the
  account the page knew, and the service answered that organization's list
  (so the person is an owner or admin there).
- A login is never logged. Failures are codes.
- **A refresh token never leaves this Mac.**

## "Log in with Claude"

The account service's sign-in (terminalx-saas PRO-82): PKCE, with the
verifier and state kept by the service. The desktop's part:

1. The page's consent (the same two checkboxes, and the replace choice when
   a login is stored), then `authorize_agent_login`.
2. `…/claude/login-start`. The app opens the answer's page in the browser,
   after checking it is an `https` page of the provider (`claude_login_page`);
   nothing else is ever opened, also not through "Open the page again".
3. The person signs in and approves. The provider's page shows a code.
4. "Enter the code" opens a **native secure dialog** for the code; it is
   sent once to `…/claude/login-complete` from a zeroized buffer and never
   passes through the webview. The dialog names the organization.
5. The answer is `complete` (the login is stored), `code-invalid` with the
   tries left, `unavailable` (the provider did not answer; the attempt stays
   open), `pending`, or `expired` / `canceled` / `failed` (the attempt is
   over and nothing was stored).
6. "Cancel sign-in" calls `…/claude/login-cancel`.

A server that does not offer the routes (older, or with the feature off)
answers 404 to the start, and the page says the sign-in is not available
there.

Defaults, as the owner chose them: who a login reaches is the service's
decision (no `sharedUse` is sent; see "Who a stored login reaches");
Disconnect removes the stored login and does not sign the account out at the provider, and the page
says so; a login stays when the admin who made it leaves, until an owner or
admin disconnects it (flagging it to owners is the service's part).

## "Lend this Mac's sign-in"

What is uploaded is the access token of the local sign-in, with its expiry
and scopes (`agent_local_login.rs`). Not the refresh token: a refresh token
held by both this Mac and the service would be refreshed by both, and where
the provider rotates it the first refresh on either side signs the other out.

So the lent sign-in is **temporary**. It stops working at the access token's
own expiry (hours), the service cannot renew it, and it has to be lent again.
The stored login's name carries whose sign-in it is and its expiry as a UTC
time ("ada@example.com · lent until 2026-10-03T21:40:00Z"), because the
service has no field for an expiry. The list reads that back: it shows
"expires in 3 h" in the viewer's own time zone, and **Expired** once the time
has passed, even though the service still calls the login connected.

The service holds one login per organization and agent, so lending a sign-in
**replaces** whatever is stored, an API key included. When one is stored the
button reads "Replace…", the page asks for that choice explicitly, the app
refuses without it (`cloud_agent_login_replace_unconfirmed`), and every
native dialog (the lend's confirmation, the API-key prompt and the sign-in's
code prompt) says what is replaced. If someone else stores a login while a
sign-in is open, the open sign-in asks for the replace choice itself before
the code can be entered again. The lend's confirmation also says that agents
in every workspace stop when the lent sign-in expires.

The steps, in order:

1. The page's consent: two checkboxes, with text naming the organization.
2. `authorize_agent_login`: consent, the named organization, owner or admin there.
3. The sign-in is read. Claude Code keeps it in the Keychain item
   `Claude Code-credentials`; the account's address comes from `.claude.json`.
   A sign-in that has expired, or has no expiry, is not lent.
4. **A native confirmation** (`native_confirm`, an `NSAlert` drawn by the
   app, not the page) names the organization, the account and the expiry, and
   says what leaves the Mac, who can use it and how it ends. Cancel is the
   default button, and only the confirm button counts as yes (a modal that
   ends any other way uploads nothing). The expiry is checked again after
   the dialog closes. This is the confirmation that counts: the page's
   checkboxes are values the webview reports, and the Keychain prompt is not
   a control, because the app already reads that item for the usage display.
5. Only then is the access token uploaded.

Codex's lend works the same way: its access token and ID token (which names
the account and plan), never the refresh token (`codex_from_raw` in
`agent_local_login.rs`). Only a ChatGPT sign-in is lent; an API key kept in
`auth.json` is connected as an API key.

### What the person is told

- Which organization and which account.
- That only the access token is uploaded, and when it expires.
- Who may run on their subscription: every member's workspaces by default
  for a first login, or the scope the replaced login has.
- That anyone who can drive a workspace can read the short-lived token off
  its machine (it is in the agent's environment there).
- How it ends: Disconnect, or its own expiry. The desktop has no revoke
  route today.

## What Disconnect does

The service deletes the stored login. It does **not** refuse because a
workspace is running: desktop-created workspaces name no login of their own
and sign in with whatever the organization has stored, so a disconnect
reaches all of them, running ones included. Nothing is stopped; an agent
keeps the access its machine was already handed until that runs out, then
needs a sign-in.

The one refusal (`cloud_workspace_credential_in_use`, 409) is for a
workspace still in existence whose first-run setup pinned this very login's
id (`remove` in `organizationCloudWorkspaceCredentialService.ts`). The page
and the native lend confirmation say exactly this. Until #450 they said the
service refuses "while a workspace of the organization still uses the
login", which a disconnect with a running Claude Code workspace disproved.

## Not verified, and for the owner

- Not run against a real provider or server. In particular it was not
  checked that the provider accepts the local access token from another
  machine for as long as its `expiresAt` says.
- The local access token carries the scopes of the CLI's own sign-in, which
  are wider than the two PRO-82's server-side login asks for.
- **Terms of use** for running a personal subscription in an organization's
  workspaces: the same open question as PRO-82.
- Whether a temporary lend is worth offering at all once PRO-82's sign-in
  exists.
