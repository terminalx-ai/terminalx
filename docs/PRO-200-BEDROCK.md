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

The runtime understands `claude-bedrock@1` and admits it only on a Linux cloud
runtime with Claude Code **2.1.319**. Unknown versions and platforms fail closed
before starting an agent. This bounded version admission must be expanded only
after verifying the deployed artifact's host-routing contract, not just a
minimum-version comparison. The local macOS artifact's source contract has been
inspected; actual Linux startup/reload/resume validation remains a release gate.

TerminalX uses Claude's documented `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`
embedding contract. Selected credentials enter the structured child environment;
competing bearer/key/session credentials are **absent**, not empty strings.
The AWS JS SDK selects bearer authentication by variable presence, so blanking
a stale bearer is not a valid way to select access keys. Host mode filters
settings-sourced provider credentials, regions and `AWS_ENDPOINT_URL*`, including
on subsequent settings applications. User/project/local settings and instructions
remain enabled. Nonsecret SDK options are additionally pinned in CLI settings;
AWS credential-export/refresh helpers are disabled for this explicit route.

Bedrock launches use a non-login `/bin/sh` with startup-file variables removed,
so a profile cannot overwrite the selected process credentials or disable host
mode before Claude starts. Other pane launches retain their existing behavior.
One configuration identity is resolved before policy admission or trust writes
and carried unchanged to process spawn. With `CLAUDE_CONFIG_DIR` absent, it
remains absent in the child: global configuration stays at `HOME/.claude.json`,
and user settings/instructions/transcripts stay under `HOME/.claude`. Setting it
to that default directory would move the global file; an empty value would move
the user-settings root. Neither is substituted. A custom absolute directory
selects its own `.claude.json`, user settings, policy cache and transcripts, and
trust preparation writes that same selected global file. Existing global MCP,
project, theme and other preferences are preserved in place. Admission requires
absolute NFC-normalized HOME and custom roots, with no dot/parent components or
repeated/trailing separators (the root `/` is allowed). Claude normalizes the
user root to NFC but joins its global path lexically; ambiguous spellings are
rejected before transcript lookup, settings/policy reads or trust writes.
Configuration is never canonicalized, copied or renamed to hide a mismatch.
Empty/relative custom roots and conflicting user-settings root redirects also
fail admission without rewriting configuration. As with managed-policy refresh, settings changes during
a running session still require the controlled Claude lifecycle release gate. Secrets never enter argv, public route status,
or a temporary settings file. This shared PTY seam does not change GitHub
credentials (PRO-195) or sharing (PRO-171).

Both the Bedrock control-plane and invocation endpoints are constructed from the
validated region. `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true` disables inherited
service/global/config-file endpoint overrides in AWS JS SDK v3; the explicit
regional invocation endpoint remains pinned. Config/credential files are
`/dev/null`, metadata is disabled, and profile/role/web-identity/container sources
are removed. Temporary session tokens stay paired with their keys; expiry never
refreshes or silently borrows another identity. Background route checks do not
make paid model calls.

Host mode also changes model-policy precedence and removes Claude's automatic
third-party-provider telemetry opt-out. The route therefore refuses existing
Linux managed settings (including fragments, malformed/unreadable files or
symlinks) and cached remote policy rather than overriding them; administrators
must reconcile that runtime before using this route. It explicitly sets
`DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`. No managed `availableModels`
allowlist is replaced. Dynamic managed-policy rollout and PRO-244 privacy
admission must be reconciled before publication; the unmerged privacy foundation
is neither copied nor assumed present.

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

## Review regressions and execution boundaries

`cloud_grants` tests compare all three schemes against the shared launch fixture,
including credential absence, nonsecret argv/settings, retained settings sources,
helper suppression and public/debug redaction. Native tests also cover unsupported
CLI admission, managed-policy refusal, endpoint construction and the actual PTY
non-login path. These tests still require native compilation/execution.

`scripts/test-bedrock-endpoints.mjs` uses real AWS JS SDK clients with a request
handler that intercepts serialized/signed requests in memory, with network APIs
forbidden. It checks all three credentials, session headers, inference-profile
control-plane discovery, invocation, configured-endpoint overrides and negative
controls for empty bearer and removed endpoint protection. Its separate artifact
reader evaluates the reviewed CLI's actual host-provider predicate and checks
that it is called from the settings filter. Changing settings fixtures exercise
that predicate; they are **not** a substitute for running Claude's complete
settings loader, `/cd`, settings refresh or resume. No customer credentials,
provider request or paid call is used.

Reproduce the offline request checks using a disposable package with pinned
`@aws-sdk/client-bedrock@3.1164.0` and
`@aws-sdk/client-bedrock-runtime@3.1164.0` installed normally, then:

```sh
node scripts/test-bedrock-endpoints.mjs /path/to/fixture/package.json /path/to/reviewed/claude
```

The extractor rejects any artifact other than the inspected macOS 2.1.319 SHA256
`1f53587e92dee8e089fa349188a4cda64fa34ace6e7b0ca2ee278ddaa3cc2ebd`.
It reads executable bytes only, never private CLI caches, and never launches
Claude. Linux artifact verification and actual controlled Claude lifecycle tests
remain outstanding under the host startup restriction. Also outstanding: normal
hooks/formatting gates, full desktop/native checks, database API suite (13 skipped
is not a pass), CI/security, authorized live AWS/cloud smoke and healthy deployment
of the paired server through the existing poller before desktop publication.

Primary contracts: [Claude environment variables](https://code.claude.com/docs/en/env-vars),
[settings](https://code.claude.com/docs/en/settings-reference),
[Bedrock authentication and inference profiles](https://code.claude.com/docs/en/amazon-bedrock),
[AWS configured endpoints](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html).
The host-routing entry was verified in the official page's Markdown response;
the cached HTML rendering lagged that entry during this review.

## Configuration-identity regression (R4)

`session_bedrock_config_tests.rs` drives the real `SessionManager::start_cli`,
`claude_launch`, configuration/policy admission, trust preparation and PTY spawn.
Only the account grant and external Claude executable are controlled fixtures.
The child inspects the actual prepared temporary global file and checks retained
MCP/project preferences, onboarding/trust state, user settings/instructions,
resume and transcript roots for absent and explicit custom directories. A stale
child-env directory is overridden/removed by the admitted identity. Other cases
verify that user root redirects and a custom remote-policy cache refuse before
trust writes or spawn. No real account config is inspected; Bedrock launches also
do not attribute their usage to an ambient Anthropic OAuth account.
Decomposed Unicode HOME/custom roots and parent-component paths through actual
temporary symlinks are refused before settings parsing or trust preparation;
both lexical and physical config targets retain their original contents.

These native integration tests are written but **not executed** under the host
startup restriction. `node scripts/test-bedrock-configuration.mjs /path/to/reviewed/claude`
executes only the exact artifact's pure global/user path computations against the
shared synthetic path fixture. Its default-directory and empty-override negative
controls expose why both attempted substitutions are wrong. The same fixture
records admitted NFC paths and rejected decomposed/parent/dot/separator paths,
including the artifact's distinct global and user results. Rust identity tests
assert admission against those cases; their execution remains outstanding. This available
contract check does not replace the native integration tests or a controlled real
Claude lifecycle smoke.

### Configuration selector audit (R4, round5)

The pinned artifact's actual `kj` suffix resolver and fixed production mode now
run in the pure-function tests, alongside `PFr` and the full legacy-file selector.
The test no longer substitutes an empty suffix. Any nonempty
`CLAUDE_CODE_CUSTOM_OAUTH_URL` (including whitespace or `0`) selects
`.claude-custom-oauth.json` even with Bedrock/host mode. This bounded route refuses
that namespace before trust preparation. An explicit empty OAuth selector is
retained and selects the ordinary file; absence stays absent. Neither existing
global file is overwritten, renamed or merged to hide an incompatible selection.

The audit covers these related identity inputs:

| Input                                                                                                       | Admitted behavior                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOME`, `CLAUDE_CONFIG_DIR`                                                                                 | Captured once, prior NFC/lexical admission retained. Conflicting local environment roots fail closed. Default global/user roots remain distinct.                              |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL`                                                                              | Absent or empty only; reject nonempty contributions even when another layer might mask them.                                                                                  |
| User-root `.config.json`                                                                                    | The actual CLI resolver can prefer this legacy global file. Refuse its presence, unreadability or symlink before preparation; preserve it and both ordinary/OAuth candidates. |
| `CLAUDE_CODE_PROJECT_DIR_NAME`                                                                              | Can replace the cwd-derived project namespace with a custom root. Refuse any presence for this bounded route.                                                                 |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH`, `CLAUDE_CODE_REMOTE_SETTINGS_PATH`, `CLAUDE_CODE_MOCK_REMOTE_SETTINGS` | Refuse alternate policy inputs rather than inspect only the default policy locations. Existing managed-policy refusal also remains.                                           |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR`                                                                           | Refuse any presence. Its actual resolver treats empty and absent differently with a custom root.                                                                              |
| `CLAUDE_CODE_IGNORE_PERSISTED_TRUST`, `CLAUDE_CODE_RELAUNCH_HOME_TRUST`                                     | Refuse alternate trust controls; the ordinary prepared trust identity is required.                                                                                            |

The artifact's production OAuth mode is a fixed function, not an invented env
switch. Its global/user resolvers use Node's `os.homedir` and POSIX path helpers;
Linux child HOME is pinned explicitly. The standard PTY command does not request
diskless storage, seeded global paths, alternate setting sources or bare mode.
Global-file discovery is cached by the CLI: admission runs before its first
access, not by changing a filename after launch.

Contribution order is now explicit. The launch captures ambient identity and one
local environment-cache snapshot, checks route/grant contributions, then checks
the resolved cloud configuration including bound secrets. The cloud callback
sees the same locked revision used for launch, before MCP files or launch records
are written. It performs configuration/policy admission and trust preparation
only after all those values are checked. The captured local snapshot goes to the
PTY without a second environment-cache lookup. Selected grant credentials and
the admitted identity still win at structured process creation; no secret is
placed in argv, status, error text or identity Debug output.

User `settings.json` contributes to this boundary and is checked without echoing
its contents. In the inspected artifact, the project/local settings filter
(`__o`/`S_o`/`te`) rejects HOME, config-root and custom-OAuth redirects; the
unconditional settings deny set also includes project-namespace/trust controls.
Managed and remote policy remain refused, and TerminalX owns the flag-settings
payload. Workspace/Local VM arguments append quoted prompts and MCP definitions,
not alternate configuration flags. This inspection is narrower than running the
real settings loader; policy refresh and the Linux lifecycle gates remain.

New SessionManager regressions cover inherited, cloud workspace, local-cache and
user-settings OAuth selectors with default/custom roots, preserving both global
files and settings. Positive cases retain empty selectors and the captured local
environment. A ConfigStore test sends a sealed bound selector through the real
resolver and checks refusal before MCP writes or launch tracking. These native
tests are **unexecuted** under the host hold. Pure artifact checks also exercise
legacy-file selection, secure-storage empty semantics and the project namespace.
