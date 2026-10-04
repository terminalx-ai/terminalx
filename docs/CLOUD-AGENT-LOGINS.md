# Agent logins for cloud workspaces, from the desktop (PRO-79)

An organization stores one login per agent (Claude Code, Codex, Cursor) for
its cloud workspaces. The account service owns them: it validates a login with
the provider, encrypts it, refreshes it, and hands workspace machines only
short-lived access made from it (PRO-17). This page is about the desktop side:
Settings → Account → **Agent logins**.

## What the section does

- Lists each agent's status: connected (API key or subscription login, whose
  it is when the service knows, who may use it), revoked, or not connected.
- **Log in with Claude** (the first way offered for Claude Code). The
  account service runs the sign-in and keeps a login it renews. See below.
- **Connect / replace with an API key.** A native secure dialog collects the
  key (`secure_prompt` in `commands.rs`, the same one provider keys use).
- **Use this Mac's Claude Code login.** The app lends the short-lived access
  token of the Claude Code sign-in on this computer. See below.
- **Disconnect**, after a confirmation.

"Log in with Claude" is PRO-82's server-side sign-in and the lasting way to
connect a subscription; lending this Mac's sign-in is the secondary,
temporary one. Codex's "Sign in with ChatGPT" (also PRO-82) is not on the
desktop yet.

## Who may do it

Owners and admins. The service refuses every credential route, the list
included, to anyone else (`organization_admin_required`), so a member sees a
sentence saying who connects logins and no controls. The desktop does not
decide this itself and cannot widen it.

A stored login is organization-wide: agents in every member's workspaces may
run on it. A login that only its owner's workspaces use does not exist on the
service yet, so the desktop does not offer one.

## What never happens

- A login is never typed into, held by or returned to the webview. The page
  sends the agent, the source (`api-key` or `local-login`) and the consent;
  Rust collects the login, sends it once from one zeroized buffer and clears
  it. The answer type (`AgentLogin`) has no field for a login.
- Nothing is collected or read before `authorize_agent_login` passes: both
  consents given, the request is for the organization active now, and the
  service answered the list (so the person is an owner or admin).
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

Defaults, as the owner chose them: a new login is usable by the whole
organization (`sharedUse: "organization"` is sent); Disconnect removes the
stored login and does not sign the account out at the provider, and the page
says so; a login stays when the admin who made it leaves, until an owner or
admin disconnects it (flagging it to owners is the service's part).

## "Use this Mac's Claude Code login"

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
refuses without it (`cloud_agent_login_replace_unconfirmed`), and the native
confirmation says what is replaced and that agents in every workspace stop
when the lent sign-in expires.

The steps, in order:

1. The page's consent: two checkboxes, with text naming the organization.
2. `authorize_agent_login`: consent, active organization, owner or admin.
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

Codex has no such option: its `auth.json` is not usable without its refresh
token.

### What the person is told

- Which organization and which account.
- That only the access token is uploaded, and when it expires.
- That agents in every member's workspaces may run on their subscription.
- That anyone who can drive a workspace can read the short-lived token off
  its machine (it is in the agent's environment there).
- How it ends: Disconnect, which the service refuses (409) while a workspace
  of the organization still uses the login; revoke in the web console; or
  its own expiry. The desktop has no revoke route today.

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
