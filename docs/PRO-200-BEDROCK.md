# Bedrock model access and provider usage limits (PRO-200)

Amazon Bedrock is a personal model-access route under Settings → Organizations
→ Your model access. It uses the existing PRO-18 member-owned encrypted route
and grant authorization. It does not widen an organisation login's sharing
scope or alter PRO-171's group sharing or PRO-195's GitHub credentials.
No SQL migration is needed; reservation 0112 is unused.

Select Amazon Bedrock, a region, a Claude model or inference-profile ID and one
credential method: AWS access keys, temporary AWS keys with their session token,
or a Bedrock API key. Test and save collects each secret through native secure
prompts. The page never receives the credentials. This action makes one small,
billable InvokeModel request from the account service. A refused test saves
nothing; there is no save-without-testing option for Bedrock. Each save requires
fresh credential entry so changing the region or authentication method never
carries a credential to a new destination implicitly.

The server builds the regional AWS endpoint itself, signs AWS keys with SigV4
(including a temporary session token), or sends the Bedrock API key as a bearer
token. It does not consult its own AWS credential chain. Redirects are refused;
errors are allowlisted codes, never provider messages, bodies, headers or secrets.
The existing encrypted route envelope binds the credential to the organization,
member, route and agent. A successful test is labeled as an account-service test,
not as evidence that a workspace has run Claude Code.

The runtime understands `claude-bedrock@1`, pins `CLAUDE_CODE_USE_BEDROCK`, region,
endpoint and the selected model, and supplies exactly the selected AWS credential
set. Other Anthropic credentials/provider switches and AWS profile/role sources
are removed. Inherited AWS config files are disabled for this explicit route.
The session token stays paired with its access keys. Expired temporary keys
must be replaced; TerminalX does not refresh them or borrow another identity.
Repository AWS credential-export/refresh helpers are disabled for this route.
Secrets remain in the process environment, never in launch arguments or the
public route status. Background route checks do not make paid model calls.
Disconnect asks “Disconnect Amazon Bedrock?” and explains that new sessions
return to the organization's login while running sessions keep their startup
credential until restarted.

A cloud tab whose normalized recovery is `usage_limit` shows the agent's name,
asks for an organisation admin to raise the limit or switch logins, and offers
Copy request. The copied message contains fixed words and an allowlisted agent
name only, with no raw diagnostics, workspace/repository names, IDs or prompt.
AWS expired/invalid credentials and access denial map to sign-in/access recovery;
ServiceQuotaExceeded maps to usage limit; Throttling/ServiceUnavailable remain
transient capacity errors. A bare Claude `rate_limit` event no longer implies
exhausted usage without a quota marker or usage-limit message.

## Cursor capability spike, 2026-11-07

Installed `cursor-agent --version`: `2026.04.17-787b533`. Bounded `--help` and
`login --help` completed; the login help exposes browser suppression via
`NO_OPEN_BROWSER`, with no export command or token-output option. The top-level
help was truncated by the installed CLI's piped output, so it is not evidence
of an exhaustive command inventory. No login, private cache, keychain or token
extraction was attempted.

[Cursor's authentication documentation](https://cursor.com/docs/cli/reference/authentication)
documents browser login stored locally and user API keys for automation. Its
[headless documentation](https://cursor.com/docs/cli/headless) uses the API-key
path. No supported export interface was found in this bounded spike. Keep the
existing native API-key connection and explain the dashboard step in the Cursor
row. `NO_OPEN_BROWSER` prints a login URL; it is not a transferable credential.

## Provider contracts and validation

Primary references: [Claude Code on Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
[AWS InvokeModel](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html),
[AWS signing](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)
and [Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html).

Controlled tests exercise the actual server request builder and API boundary,
credential exclusivity, error redaction, encrypted save/grant behavior (database
integration), runtime grant/environment mapping, cloud recovery UI and clipboard.
Fixtures contain synthetic credentials only. No real AWS account, customer
workspace or paid model call was used during implementation. A live Test/save
and real cloud Claude Code smoke remain outstanding until explicitly authorized.

PRO-252's unmerged feature-flag framework and PRO-244's unmerged privacy policy
are not copied. This change keeps existing account HTTP admission and session
launch interfaces; reconcile those foundations before publication. Server must
receive exact-head independent review, actual CI and a healthy deployment via
the existing main poller before desktop delivery. Do not run a duplicate deploy.
Host startup failures currently block required native/broad validation and normal
server hooks; the coordination status records actual executions separately from
source inspection. A source-only review is not committed-head approval.
