# Workspace SSH (PRO-215)

A person explicitly enables SSH from a cloud workspace's menu. The native
service checks their current membership and effective collaboration rights,
generates an Ed25519 identity in TerminalX's account/organization/workspace
scope (or derives the public half of the key selected in Settings → General →
Advanced), and registers **only its public key**. Existing private keys are
never overwritten. Passphrase-protected custom keys must already be unlocked
for public-key derivation; generated keys are owner-readable files.

Enable writes a scoped Include at the beginning of `~/.ssh/config`, plus one
product-owned config and pinned `known_hosts` file in `~/.ssh/terminalx`.
Existing configuration is retained. Remove SSH access and config removes only
that scoped Include/config/host pin; private keys remain. The copy action gives
`ssh <workspace-id>.terminalx`. TerminalX must be running and its existing
“Let agents in local sessions control cloud workspaces” permission must be on.
Neither enabling nor connecting wakes stopped compute. Key propagation waits
for the runtime's next member refresh.

The ProxyCommand invokes `terminalx ssh-proxy --organization … --workspace …
--scope …`. The checked account/profile revision travels through attachment acquisition and
native stream admission. `ssh.info` and the forward must use the same captured
connection id and native transport epoch; replacement or account transition
refuses the open.
The app opens the existing authenticated E2EE `ports/1` stream, and the proxy
copies raw stdin/stdout with half-close handling. Each proxy owns a separate loopback listener and its streams. Closing it
releases those resources without touching other proxies, previews or workspace
leases. A native 45-second renewal deadline also bounds lost control replies
and vanished CLI/window owners; late stream-open answers are closed. The tunnel never exposes a public SSH port.

Only the Linux cloud runtime starts this SSH implementation. It binds a random
port on `127.0.0.1`, then gives accepted sockets to isolated `sshd -i` children.
It never starts/enables the machine's SSH service, reads `/etc/ssh/sshd_config`,
or edits the user's authorized_keys. Its private runtime directory holds host
identity, config and a fresh authorized_keys file. Runtime bootstrap extracts
OpenSSH into `/opt/terminalx/openssh` without running package maintainer scripts.
The shared idempotent setup runs for fresh and existing-user installs,
headless and AppImage fast/image resumes, required and offered reinstalls, and
the legacy machine0 installer. It repairs the old nologin account shell and
resolves the private executable's dependencies. The runtime checks the actual
executable/config before advertising `ssh/1`. The same unprivileged workspace
account runs the shell. Forwarding, password
login, user rc files and user environment files are disabled.

The key list is recomputed on every authoritative member update, including
key-only changes. Only `manager || (driver && canApprove)` qualifies. Missing,
malformed or expired SSH grants authorize nothing. A server-issued 60-second
absolute expiry is retained with each admitted key and ends new admission
and live sessions. A monotonic deadline prevents clock rollback or replay
from extending a grant; the local liveness limit can only shorten it. Changing
keys closes sessions in the previous key generation; a rejected runtime
credential clears keys. `ssh.info` and the port stream apply current runtime
rights, even for previously issued manage attachments.

Server routes are membership-authenticated PUT/DELETE
`/v1/desktop/orgs/:orgId/cloud-workspaces/:workspaceId/ssh-key`. They have no
user/grantee parameter. PUT accepts one canonical Ed25519 public key; DELETE
revokes the caller's key. The registration is workspace-scoped with a membership
foreign key. A revoked share deletes its registration; leaving/rejoining an
organization cannot resurrect it. `workspace-ssh-v1` negotiates the public-key
extension to runtime members; older runtimes receive the original list.

## Validation and delivery gates

Rust regressions cover binary proxy bytes/half-close, scoped Include quoting,
idempotence/removal and symlink refusal, current RPC authorization, viewer
refusal and key-update cancellation. The opt-in Linux test
`remote::ssh::acceptance::real_ssh_shell_bind_viewer_and_removal` uses generated
temporary keys and the actual product listener/sshd to check shell identity,
non-loopback refusal, viewer refusal and removal. Run only in an existing
controlled disposable Linux workspace with `TERMINALX_DISPOSABLE_SSH_ACCEPTANCE=1`
and the product's OpenSSH binary (or `TERMINALX_TEST_SSHD`). Run it as the
bootstrapped `terminalx-runtime` account: the fixture refuses another user.
The server's opt-in `cloudWorkspaceSshSetup.docker.test.ts` covers fresh and
preexisting nologin accounts with actual private OpenSSH dependency setup.
Clock-controlled Rust regressions cover short expiry, cached replay, rotation,
renewal and local liveness; owned-forward regressions cover socket teardown,
late answers, expiry and preservation of simultaneous proxies/previews. It does not modify a
host SSH service. These native tests have **not** run under the current host
startup incident and remain required acceptance gates.

Server integration regressions live with the collaboration tests and exercise
the canonical membership/role resolver and real PostgreSQL. Provisional0112
is reserved, not proof of predecessor deployment: reconcile actual journal
ordering and repeat clean/incremental tests before publication.

Delivery also requires actual integration of PRO171's effective-share resolver,
PRO244's policy-aware network/stream cancellation and PRO252's rollout contract.
Those pending foundations are not copied or assumed landed here. The reviewed
server must pass normal hooks, native review/CI and gated merge; the existing
production poller must deploy that exact SHA healthily before desktop
publication. No duplicate deployment is appropriate.
