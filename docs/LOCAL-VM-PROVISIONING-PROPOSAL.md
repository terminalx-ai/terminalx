# macOS26 bootstrap and Linux task runtime integration

Status: source proposal, 2026-10-28. No installed profile, VM, account, credentials,
or running owner changed. The current fresh-macOS capability remains unavailable.
The working two-action model is an implementation assumption communicated to the
user, not an explicit answer to every product preference question.

## Proposed macOS26 path

Retain Lume **0.6.1**, release source **3350f504014c85416009a90fcb339fe556ce02fc**,
and the already-pinned signed archive. Use its ordinary IPSW installation and
background run path. Add a TerminalX bootstrap adapter that completes normal
macOS26 Setup Assistant in that VM, then establishes SSH for the resulting
account. Do not use the existing offline unattended patcher for this profile.
This is a proposed integration of supported building blocks, not a claim that
background first-account automation is implemented or accepted.

Lume's create command accepts an explicit IPSW path, and its run command supports
`--display none --detach`; the VNC server remains available without opening a
viewer. These are public options in the exact pinned version, not proposed CLI
flags. [Create source](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Commands/Create.swift),
[Run source](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Commands/Run.swift).

The pinned unattended patcher directly creates the fixed account, completes
Setup Assistant, configures autologin, and changes lock/sleep settings. Changing
YAML health-check credentials does not personalize that account. The new profile
must avoid this path entirely, preserving normal OS security and consent.
[Offline patcher](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Unattended/MacOSOfflineSetupPatcher.swift).

Use a new source profile identifier, `macos26-personalized-v1`, separate from
legacy `macos-local-v1`. Keep legacy enrollment/readback compatible. The following
are **TerminalX-owned proposed contracts**, not claims about upstream APIs:

| Boundary | Required contract |
| --- | --- |
| Restore image | Explicit Apple macOS26 IPSW URL, OS/build, size and SHA256. Never `latest`, a macOS27 image, or a preconfigured default-account clone. No new IPSW manifest has yet been verified or selected. |
| VM identity | Environment ID, generation, immutable Lume VM identity/config fingerprint, operation ID and installation digest. A reused display name cannot inherit receipts. |
| Account creation | Unique account name and secret reference supplied by the guided flow; confirmed guest UID and home. Secret values stay out of argv, journal, events and artifacts. |
| Bootstrap input | A background VNC connection bound to that exact owned VM, authenticated and restricted to a verified loopback endpoint. A finite state machine observes each expected Setup Assistant screen before one effect. Unrecognized UI or a lost receipt becomes a retained inspection gate; never replay account creation blindly. |
| Transport trust | Guest SSH host-key fingerprint obtained through the VM-bound bootstrap channel, plus a dedicated newly created per-guest key reference. An IP address, `ssh-keyscan` result or default password alone is not identity evidence. |
| Runtime enrollment | Verify the selected account UID/home, environment/generation, protocol and executable digest before installing/starting the guest runtime. Keep provisioning separate from provider authorization. |
| Consent/readiness | Preserve explicit OS-required and provider consent. Continue automatically after a verified receipt. Boot, screenshot, account creation and SSH connection are separate stages and none alone establishes Ready. |

This design keeps routine work in the background. The first-account executor,
VNC screen transitions and out-of-band host-key capture still need implementation
and disposable fixtures. Fresh macOS26 acceptance must test these against an
actual supported restore image before enabling Create.

## Account-bound transport

The current Cua **0.7.0** Lume SSH adapter retains only the executable and VM name;
its argv does not carry an account/key binding. Lume 0.6.1 does expose username and
password options, but passing passwords on argv is not the proposed secure path.
[Cua 0.7.0 adapter](https://github.com/trycua/cua/blob/cua-sdk-v0.7.0/libs/cua/crates/cua-vmm/src/lume/ssh.rs),
[Lume SSH command](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Commands/SSH.swift).

Propose a TerminalX-owned OpenSSH transport adapter alongside the retained legacy
Cua route. The host's read-only version check reports **OpenSSH_10.2p1 / LibreSSL
3.3.6**. This does not require installing a different SSH client. Its contract:

- Execute `/usr/bin/ssh` with a generated private configuration, explicit account,
  per-guest identity file/reference, pinned known-hosts entry and environment-bound
  host-key alias. Resolve the current IP from the exact VM, then authenticate the
  pinned key; never accept an IP as identity.
- Require `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, `IdentityAgent=none`,
  `ForwardAgent=no`, `BatchMode=yes`, `PasswordAuthentication=no`,
  `KbdInteractiveAuthentication=no` and `UpdateHostKeys=no`. Disable user config,
  proxy commands, connection sharing and inherited forwarding/environment rules.
- Send only the bounded guest RPC over stdin to the absolute runtime path in the
  confirmed guest home. Remove inherited TerminalX control credentials. No host
  provider credentials, host SSH agent, or existing personal SSH keys are copied.
- Treat key mismatch, UID/home mismatch, generation change, missing receipt and
  timeout as refusal/unknown outcome, with no fallback to legacy credentials,
  another VM, host shell, or host desktop.

These are supported SSH configuration concepts, but the TerminalX adapter and its
initial trust ceremony still need implementation and review.
[OpenSSH configuration reference](https://man.openbsd.org/ssh_config).

Source integration points: extend `local_vm/transport.rs` with a separate typed
account-bound variant; remove fixed guest-home assumptions only for that variant
in `guest.rs`, `desktop.rs`, `guest_setup.rs`, `guest_readiness.rs` and installers;
add a durable personalization journal to `creation.rs`/`setup.rs`. Keep the old
variant unchanged until its existing tasks and receipts are retained. Account
personalization is never a retrofit of either current live VM.

## Why no silent dependency replacement

Tart publicly supports macOS26 images, but its documented images use a shared
default account too. Swapping provisioners does not itself satisfy this first-
account contract. A Tart/Packer alternative would need its own account/transport
binding, licensing review and acceptance evidence before a profile replacement.
[Tart quick start](https://tart.run/quick-start/).

The concrete choice proposed here is to keep the existing Lume version and build
the missing TerminalX bootstrap/transport adapters. It remains a proposal for a
new profile. No dependency upgrade, OS upgrade, installed-profile change or fresh
VM creation is authorized by this document. Public documentation does not prove
that the unimplemented bootstrap composition will pass macOS26 acceptance.

## Linux source slice and remaining delivery work

The source now separates exact Linux container task identities from attached
computer targets. It enrolls an already-installed Linux guest runtime only after
an authenticated description matches the expected environment, generation,
protocol, exact runtime executable SHA256 and Linux shell/files route. Both the RPC helper and running guest owner check that artifact binding before dispatch. Docker and Podman requests use full
container IDs, explicit `cua` user and bounded stdin, without shell interpolation,
host environment forwarding or host mounts. The CLI options are documented by
[Docker](https://docs.docker.com/reference/cli/docker/container/exec/) and
[Podman](https://docs.podman.io/en/latest/markdown/podman-exec.1.html).

Linux selected tasks use the shared journal/guest worker/history/artifact/recovery
implementation. Their provider account must be a supported guest-owned Codex
file-backed login. The UI does not offer task desktop access, infer authorization
from container boot, or enable tasks in an unprepared stock XFCE container.
Attached MCP lifetimes and pending guest tasks have exclusive host admission;
unknown proxy exit retains a fence instead of releasing it on a timer.

This is not complete Linux onboarding or demonstrated parity. Remaining work:

1. Produce and verify Linux runtime artifacts for the exact source/architecture.
   The local x86_64 cross-target check currently stops in `openssl-sys` because a
   Linux OpenSSL sysroot is unavailable. No packages/profile were installed to
   bypass that constraint; no container was started for a build.
2. Implement the guided runtime/profile installer and expose the existing
   supported device-login flow for Linux. Enrollment of a prepared runtime is an
   internal boundary, not the promised out-of-box product setup.
3. Implement explicit reconciliation for interrupted attached MCP operations,
   proving the old remote process is stopped before clearing an unknown fence.
4. Validate the Linux Driver/tool contract and integrate task desktop support
   through the guest workflow lease before advertising full guest-task parity.
5. Implement the macOS attached-desktop lease/proxy using guest ownership and
   manual-control rules; never graft direct Cua tools onto an active guest task.
6. Keep live activation, disruptive acceptance, PR and merge readiness held.


## Linux native artifact gate and proposed build preparation

The current lockfile selects `openssl 0.10.81` and `openssl-sys 0.9.117`.
The macOS cross-check stopped in openssl-sys before compiling our Linux code:
there is no Linux OpenSSL sysroot. A successful macOS check does not establish
Linux-native compilation or runtime behavior. No packages or build containers
were installed or started for this continuation.

Reuse the existing release matrix's `ubuntu-22.04` x64 and
`ubuntu-22.04-arm` arm64 builders for a **nonpublishing** validation job from the
exact reviewed commit. The proposed prerequisites are a native C toolchain,
`pkg-config`, and Linux OpenSSL headers/libraries (`libssl-dev` on these runners).
Record the runner image, compiler/Rust versions, package versions, lockfile digest,
ELF machine, required glibc version, shared-library dependencies and binary SHA256.
Do not point a Linux build at the host's Homebrew OpenSSL. Cross-building instead
would require a matching compiler/sysroot and target-prefixed
`X86_64_UNKNOWN_LINUX_GNU_OPENSSL_DIR` or
`AARCH64_UNKNOWN_LINUX_GNU_OPENSSL_DIR`; setting an environment variable without
those libraries is not a build fix. These are the crate's supported build inputs.
[Exact crate build documentation](https://docs.rs/openssl/0.10.81/openssl/).

This is a dependency/build proposal, not an installed-profile change or a request
to run the publishing release workflow. No new package or image version is pinned
by this proposal. A reproducible builder/package manifest and both native build
receipts must precede a trusted Linux profile entry. That entry must bind the
source commit, target architecture, runtime protocol and SHA256. The installer
must verify the ELF architecture and full artifact digest before executing it,
then verify the nonroot cua account, private installation and immutable
container/environment/generation through the authenticated guest RPC. Existing
histories and unknown ownership outcomes must block replacement. This installer
and trusted artifact catalog remain implementation work; the UI does not offer a
fake successful install or ask the user for an arbitrary runtime binary path.

## Ownership reconciliation and macOS attachment source boundary

Linux attachment reconciliation acquires the same admission lock as task/setup
routing, inspects the exact full container ID, and requires the TerminalX label,
`Status=exited`, `Running=false`, `Pid=0`, all pause/restart/dead flags false, and a
valid started/finished interval. A private PID namespace is required; missing,
host or shared PID mode is refused. Missing/replaced/ambiguous or still-running
containers stay fenced. Confirmation repeats the fresh inspection; UI-supplied
state is never proof. The original marker and exit evidence are archived before
release, while the earlier action outcome remains unknown. Nothing stops a
container, changes input, or retries an MCP operation.
[Docker exec lifetime](https://docs.docker.com/reference/cli/docker/container/exec/),
[Docker inspect](https://docs.docker.com/reference/cli/docker/container/inspect/),
[Podman inspect state fields](https://docs.podman.io/en/latest/markdown/podman-container-inspect.1.html).
The private-namespace exit rule follows Linux's termination of the namespace's
remaining processes when its PID 1 exits.
[Linux PID namespace lifetime](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).

The new macOS guest attachment boundary retains exact environment/generation and
parent session/tab/conversation leases. Tool input is restricted to the existing
Driver capability allowlist; each keyed call is journaled before delivery and
its receipt is retained. An unknown call blocks new input and same-boot release;
reopening the owner returns the original receipt without replay. Explicit release
requires either all call receipts or a different current kernel boot, retaining
any unknown earlier outcome. Tasks, manual takeover, setup actions and provisioning
evidence account for this lease. This source seam is not advertised as an attached
macOS capability yet: the host MCP adapter, exact-target selection admission,
discovery catalog and end-to-end UI/recovery fixtures still need integration.
