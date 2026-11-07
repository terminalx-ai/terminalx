# Your own model access in cloud workspaces (PRO-18)

By default the agents in a cloud workspace sign in with the organization's
agent logins, which the app manages (`docs/CLOUD-AGENT-LOGINS.md`). A member
can instead route an agent through their **own endpoint** (an LLM gateway or
model provider, with a credential they store) or through a **credential
helper** they manage in the workspace. This page is about that: the desktop
section, what the runtime does with a route, how a route is checked, and who
it reaches.

The server half is terminalx-saas `agentModelRoutes` (contract section 25 of
`apps/api/docs/cloud-workspace-remote-runtime-contract.md`).

## Where it is set

Settings → Organizations → an organization → **Your model access in …**,
under Agent logins. It is there for every organization the person belongs
to, active or not, and for members as well as admins: a route is personal.
One per agent, per organization, per person.

Each agent row says what the agent uses:

- **Organization login, managed by TerminalX.** The default. No route.
- **A route**: its endpoint type, address, helper and model, and what the
  newest check from a workspace found (below).
- **Cursor**: its CLI signs in only with its own login. It supports no custom
  endpoint and no credential helper, so nothing is offered.

**Switch back to the organization login** deletes the route and, for a
custom endpoint, its stored credential. New sessions use the organization's
login again; running sessions keep what they started with until restarted.

## What is offered (the template catalog)

The account service owns a catalog of provider templates, versioned on its
own (`catalogVersion`, and a version per template). The page renders the
templates and fields the service answers with, so it only ever offers what
the agent's CLI supports, and the service validates every field again. A
route records the template id and version it was saved with: a template that
changes later is a new version, and a route on an older one keeps working as
saved and says it can be set up again.

Checked against the CLIs' own documentation on 2026-10-22:

| Template | Agent | Mode | What the runtime sets |
| --- | --- | --- | --- |
| `claude-gateway@1` | Claude Code | custom endpoint | `ANTHROPIC_BASE_URL`; the credential as `ANTHROPIC_AUTH_TOKEN` (Authorization: Bearer) or `ANTHROPIC_API_KEY` (x-api-key); `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` |
| `claude-key-helper@1` | Claude Code | user managed | `apiKeyHelper` in the launch's `--settings`; `ANTHROPIC_BASE_URL` when one is set |
| `codex-provider@1` | Codex | custom endpoint | `-c model_providers.terminalx={ base_url, env_key = "TERMINALX_CODEX_ROUTE_KEY", wire_api = "responses" }`, `-c model_provider="terminalx"`; the key in `TERMINALX_CODEX_ROUTE_KEY` |
| `codex-auth-command@1` | Codex | user managed | the same provider with `auth = { command, timeout_ms = 15000, refresh_interval_ms = 300000 }` instead of `env_key` |

Sources: Claude Code's gateway pages (code.claude.com/docs/en/llm-gateway-connect,
…/llm-gateway-protocol) and Codex's custom model providers
(learn.chatgpt.com/docs/config-file/config-advanced). Provider-format
gateways for Vertex and Foundry are not templates yet. Amazon Bedrock is offered as `claude-bedrock@1`; see PRO-200-BEDROCK.md.

Fields, as the service checks them (`src/lib/agentRoutes.ts` checks the same
first, and `agent_route_check.rs` again in the runtime):

- **Base URL**: `https`, or `http` to the workspace itself (`localhost`,
  `127.0.0.1`, `[::1]`) for a gateway running beside the agent. No user name,
  password, query or fragment: that is where credentials hide in URLs, and the
  credential has its own field.
- **Model**: one id as the endpoint names it. A route that names one runs the
  agent on it instead of the tab's model, since the endpoint may serve no
  model of the tab's name. Codex routes require one.
- **Credential helper**: one executable, `./relative` (to the folder the agent
  starts in) or absolute, made only of characters a shell reads as a path.
  Claude Code runs `apiKeyHelper` through a shell, so arguments belong in a
  script. The runtime passes it as an absolute, quoted path.
- **Credential** (custom endpoints only): printable ASCII without spaces, at
  most 8 KiB. Never typed into the page: see below.

No model id is written into the app or the catalog. An endpoint's models are
what it answers on its model list.

## Saving, and the check from this Mac

**Enter credential and save** asks the app (not the page) for the credential
in a native secure dialog that names the address, the endpoint type and the
organization. Rust then checks it from this Mac against the endpoint's model
list (`GET <base>/v1/models?limit=1000` for an Anthropic-format gateway,
`GET <base>/models` for an OpenAI-format provider), with the credential in the
header the CLI would use, and no redirect followed. The page is told the
outcome, an HTTP status and the model ids it listed, never the answer body.

- Passed, or reachable with no model list (`unverified`): saved.
- Failed: nothing is saved and the form stays, unless **Save even if this
  Mac's check fails** was ticked. That applies to any failure, a refused
  credential or an unlisted model included: an endpoint may answer only the
  cloud (unreachable, or 403 to other addresses), or serve a model it does
  not list. The workspace's own check labels the route either way.
- A model the endpoint does not list fails as `model-unsupported`, and the
  page lists what it does serve. The model is looked for in the whole list
  (read up to 16 MiB); only the first 200 ids are reported. A list too
  large to read still shows the credential works, and the model is then not
  judged.

The credential leaves Rust once, to the account service, in one zeroized
buffer, and is never returned. Changing only the model or header choice of a
saved endpoint keeps the stored credential; changing the endpoint type or its
origin needs it entered again, so a stored credential is never sent somewhere
new (the service refuses with `cloud_agent_route_credential_required`).

A helper route is saved with no credential at all: TerminalX never sees what
the helper prints.

## In the workspace

The server sends a route as the agent's only grant (`mode: route`), sealed to
the runtime's key like any agent grant, and never sends the organization's
login for that agent beside it. The runtime says it can apply routes
(`agent-routes-v1` on its grant fetches); a runtime too old to say so gets
neither the route nor the organization's login, and the tab says it needs
updating.

For a new session the runtime (`cloud_grants::launch_grant`) reads the
variables, the route's additions and Codex's auth file from one snapshot,
after waiting briefly for the first grant sync when the runtime has just
started (a prompt that woke the workspace), so a launch never gets half of a
route. It:

- sets the template's variables and unsets every other variable that could
  sign the agent in or send it elsewhere (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, Claude Code's
  `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`, `OPENAI_API_KEY`,
  `CODEX_API_KEY`), after the login shell's profile, so nothing app-managed,
  configured or exported overrides what the member chose;
- for Claude Code, also pins the route's address (`ANTHROPIC_BASE_URL`, Claude
  Code's own for a helper route that names none) and those provider switches
  (`0`) in the `env` of the launch's `--settings`. A checkout's
  `.claude/settings.json` `env` beats the process environment, and without
  this it could send the route's credential to an address or provider of its
  own (checked live with Claude Code 2.1.308 against two stand-in gateways:
  both a project `ANTHROPIC_BASE_URL` and a project Bedrock switch took the
  route's token elsewhere; with the pins, every request went to the route).
  The credential itself never goes on the command line;
- removes Codex's `auth.json` from the managed home;
- adds the helper or provider overrides and the route's model.

What this does not change: code the checkout runs (its hooks, its tools) runs
with the agent's environment, where the credential is, as for any agent
credential.

A route whose template version this runtime does not apply, or whose
settings do not fit it, sets nothing (and still unsets the rest): the tab
says why, and the agent is never quietly put on the organization's login.

## Checks and labels

Each route version is checked from the workspace (`agent_route_check.rs`,
reported to `POST /v1/cloud-workspace-bootstrap/agent-route-check`): a helper
is run the way the agent would run it (no stdin, its folder, at most 15 s;
exit 0 and one header-safe line), then the endpoint's model list is read with
the credential. Only codes, an HTTP status and model ids are reported, and a
report that does not get through is sent again on the next turns of the grant
loop until the server has it (or says the route has moved on). A
route is checked once per version, a failed or unverified one again after
five minutes (one minute when an agent starts), and a `./relative` helper only
from the folder an agent starts in.

What Settings says:

- custom endpoint: **Saved · not checked from a workspace yet**, then
  **Connected** once a workspace read the model list with the credential;
- credential helper: **User managed** until a workspace ran the helper and the
  endpoint accepted its credential, then **User managed · working**;
- either: the reason a check failed, in words (`unauthorized`, `unreachable`,
  `helper-not-found`, `model-unsupported` with the models it lists, …), and
  **unverified** for an endpoint with no model list.

A failed check also puts a line in the agent's tab when it starts ("Your
Claude Code endpoint did not list the model … It lists …").

## Who a route reaches

- **Only the creator's own workspaces.** The server picks routes by the
  workspace's creator; another member's workspaces keep the organization's
  login and never receive the route.
- **A stored credential only where nobody else drives.** It is delivered only
  to private workspaces with no driver shares (`route-shared-workspace`
  otherwise, never a fallback), and the server records which runtime
  generation it was handed to. A workspace whose current runtime received one
  cannot be opened to the organization or shared with Can send
  (`cloud_workspace_share_personal_route`): stopping delivery would not take
  back what a running agent already holds. Switching back does not lift
  that; a restart (stop and resume, a new runtime generation) does. A
  workspace that never received one is not restricted, and from the moment
  it is shared the credential is withheld there. The create and schedule
  checks judge the same way (the workspace creator's route, and whether the
  workspace is shared), so a schedule or a shared create never starts a
  machine for an agent that would get nothing. A helper route carries no
  credential and is delivered to shared workspaces too: everyone who drives
  such a workspace runs through the creator's helper and gets what it prints.
  The page says so, so a member does not point a helper at a credential only
  they should use.
- Organization owners and admins can drive any workspace of the organization,
  so they could read a credential an agent of it holds; the page says
  "reaches only workspaces you create that nobody else can drive" and makes no
  wider promise.
- **Leaving the organization** deletes the member's routes (a trigger on the
  membership row).
- Compute-provider keys, PRO-19 secrets and the organization's logins are
  separate tables; a route's credential is encrypted with AAD binding
  organization, member, route and agent.

## What never happens

- A credential is never typed into, held by or returned to the webview, never
  logged, never in a check report, and never on a command line (Codex reads it
  from `TERMINALX_CODEX_ROUTE_KEY`).
- A redirect is never followed with a credential.
- The organization's login is never injected for an agent the member routed.

## Verified

- Unit tests: field rules on all three sides, the check's outcomes and masking
  against a local server, helper runs (missing, not executable, failing,
  silent, chatty, slow, cwd), route env and launch overrides, unknown
  templates, a withheld route, check scheduling and stale reports; the desktop
  client's requests; the Settings section; the tab and share messages.
- Live, on this Mac, against a local stand-in gateway (no real provider, no
  paid compute), with the exact variables and arguments the runtime builds:
  Claude Code 2.1.308 through the gateway with a bearer token and with
  x-api-key, and with an `apiKeyHelper` in a folder whose name has a space
  (both headers carried the helper's output); the organization's key set in
  the environment never reached the gateway; a model the gateway does not
  serve ("There's an issue with the selected model"); Codex 0.153.4 with the
  route's provider and key, and with the auth command.
- Server integration tests on a throwaway Postgres (terminalx-saas).

Not verified: a real gateway or provider account, the cloud runtime image's
own CLI versions (Claude Code 2.1.285, Codex 0.159.1) in a VM, and the
end-to-end path through a deployed server.

Amazon Bedrock (`claude-bedrock@1`) uses a server-side Test and save with AWS
keys or a Bedrock API key. See [PRO-200-BEDROCK.md](PRO-200-BEDROCK.md) for the
credential boundaries, runtime environment and validation limits.
