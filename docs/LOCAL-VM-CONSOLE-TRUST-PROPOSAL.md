# macOS26 console and first-account trust integration

Decision proposal, 2026-10-28, based on PRO-114 checkpoint `74663b9a`.
This specifies a dependency extension and acceptance contract. It is **not an
implemented console, observed Setup Assistant sequence or authenticated guest
receipt**. No VM, account, credential, installed profile or production artifact
was changed. Linux/macOS choice and the separate **Attach desktop tools** and
**Run task in VM** actions remain the working defaults.

Follow-on source implements the bounded helper filesystem engine and, at the
user's subsequent authorization, a reviewable restricted-Lume owner/channel
candidate. See [candidate source and exact contract](../integrations/lume-bootstrap/README.md).
The candidate is patched against the exact baseline below; it is not an adopted
dependency/profile or enabled production channel. Its real VZ adapter is
typechecked and its native IPC is fixture-tested, without creating a VM.

## Recommended choice

Keep Lume's ordinary macOS26 restore path and the existing noVNC **1.7.0** client.
Add a restricted, separately signed Lume bootstrap profile with a private console
broker inside the process that owns the `VZVirtualMachine`. Use two dedicated
VirtioFS directories to deliver a signed guest bootstrap helper and return account
and SSH public-key receipts. Do not derive trust from OCR, the VNC desktop name,
an IP address, or a first SSH connection.

This is the smallest useful extension identified; it avoids a Python/vncdotool
installation and a new viewer dependency. **The installed Lume0.6.1 profile cannot
provide this safely unchanged.** A loopback URL in its session file is not enough
to establish the required ownership and authentication contract.

| Component | Exact baseline / proposed delta |
| --- | --- |
| Lume | 0.6.1 source `3350f504014c85416009a90fcb339fe556ce02fc`; retain current signed executable pin `a369d63746690afe79626e357241df2f95b523e7f6f60ac9bc7665762abfc904` for legacy use. Proposed separate profile `lume-terminalx-bootstrap-v1` starts from that source with the bounded changes below. This identifier is TerminalX's proposal, **not an existing upstream release**. |
| Console client | Already installed in repository dependencies: `@novnc/novnc` 1.7.0; upstream tag resolves to `63107bd06d9e1f6136ff21aeda8cd62cbf0d433e`. Keep the existing pnpm integrity pin; no package change. |
| Host bridge | Existing Rust `tokio-tungstenite` 0.28.0 and owner authentication/admission facilities. Add a dedicated authenticated console route, not a generic caller-supplied TCP proxy. |
| Guest helper | A new signed TerminalX bootstrap executable or bounded subcommand, delivered through the read-only share. It needs no guest SDK/Python, provider login, host credentials or initial SSH. Its future digest must come from an actual reviewed build. |

There is no checksum for the proposed Lume/helper build yet. A reviewed source
commit, signed artifact, executable/archive digests and architecture evidence are
required before a new catalog entry. Existing pins must not be overwritten.
The [noVNC release](https://github.com/novnc/noVNC/releases/tag/v1.7.0) and
[versioned API](https://github.com/novnc/noVNC/blob/63107bd06d9e1f6136ff21aeda8cd62cbf0d433e/docs/API.md)
support WebSocket connections, credentials, view-only mode, key input, framebuffer
readback and connection/security events. These features do not authenticate the
VM or grant automation authority.

## What the pinned source actually establishes

* `Run.swift` supports detached/no-viewer execution, VNC policy, and repeated
  `--shared-dir path:ro|rw`. The directory tag is Apple's macOS automount tag.
  [Pinned command](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Commands/Run.swift#L38-L43).
* `DefaultVNCService` attaches its server to the supplied `VZVirtualMachine`
  object. It uses Apple's **private** `_VZVNCServer` API, writes a password-bearing
  session URL and logs local/external URLs. A `127.0.0.1` URL is not proof that
  the listener only binds loopback. The exposed constructor does not establish
  an address-binding guarantee.
  [Pinned service](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/VNC/VNCService.swift#L73-L119).
* A VNC-enabled run additionally starts `writeVNCConfigViaSSH`, which tries the
  fixed `lume` account/password and writes `~/.vnc.env`. It also shares VNC
  connection details through a temporary `lume-config` directory. Omitting
  `--clipboard` does **not** suppress this independent background task. This is
  a separate blocker from missing Setup Assistant automation.
  [Run dispatch](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/VM/VM.swift#L487-L496),
  [SSH task](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/VM/VM.swift#L1171-L1203).
* VirtioFS maps supplied directories to `VZSharedDirectory` with each read-only
  flag, grouped in `VZMultipleDirectoryShare`; names derive from basenames and
  collisions receive suffixes. The helper must discover and validate the mounted
  manifest rather than guess a `/Volumes` path.
  [Pinned sharing implementation](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Virtualization/VMVirtualizationService.swift#L279-L330).
  Apple documents the [automount device tag](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration/macosguestautomounttag)
  and [read-only shared directories](https://developer.apple.com/documentation/virtualization/vzshareddirectory).

Lume's native attach signal only reveals its viewer; it is not a background
capture/input/trust API. Its [SSH clipboard bridge](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/VM/VM.swift#L417-L425)
is circular before SSH trust, so neither clipboard synchronization nor an assumed
RFB clipboard event is part of this proposal.

## Required Lume delta and exact console contract

The following are **new TerminalX contracts**, not claims about installed CLI
flags or undocumented Apple methods. The candidate implements private inherited
control, original-owner reconnect and fixed share-receipt reads. Console streaming
and input remain unavailable. Adoption requires separate profile/artifact review:

1. Disable all fixed-account SSH probes/writes, native SSH clipboard integration,
   VNC credential sharing to the guest and secret-bearing logging in bootstrap
   mode. Preserve unrelated legacy profiles. The bootstrap path must fail if any
   default-account transport is reachable.
2. Start one VM owner from the retained provision operation. Supply a private
   inherited control descriptor at process creation; retain its owner epoch,
   source/artifact identity, config/disk/NVRAM identities and full environment,
   generation, restore digest and bootstrap ID. Do not reconstruct ownership from
   a VM name or PID. Reopen uses a private owner Unix socket and an authenticated
   challenge to the same epoch; a missing lease cannot be recreated from files.
3. The owner binds a `0600` Unix socket in the operation's `0700` directory. Verify
   peer UID, the retained signed executable/process identity and a fresh nonce
   over the private channel. Authenticate the host too. Retain a private reconnect
   capability reference, never a capability in URLs, logs or agent-visible JSON.
   The response binds that exact `VZVirtualMachine` object and actual shares to
   the original VM/config pin and epoch. PID and socket existence alone are not
   authentication or exit proof.
4. A console-open request names the original target, bootstrap ID, parent
   session/tab/conversation and exclusive lease. The owner connects to its own
   VNC server and returns an already bound RFB stream through the authenticated
   channel. Callers cannot supply a port, URL, password or alternate VM. The
   TerminalX loopback WebSocket endpoint validates Origin, a short-lived scoped
   capability and the lease before forwarding this stream to noVNC. Tokens stay
   outside URLs; use a checked handshake/subprotocol or equivalent private IPC.
5. Prove the underlying VNC listener is loopback-only and owned by that VM process
   on macOS26. This is a **release/acceptance gate**, not a property established by
   the current source. If its private Apple API cannot provide this, do not enable
   the profile: evaluate a TerminalX-owned native console bridge or a different
   server with an explicit bind contract. A loopback proxy does not hide an
   otherwise exposed upstream listener. Do not invent an `_VZVNCServer` option.
6. Bind every input to an immutable request ID, observed frame sequence/digest
   and original lease. Persist intent before input. Unknown input is inspection
   only; never replay clicks, text, account creation or consent after reconnect.
   A changed owner epoch closes the stream and fences the operation. Sharing a
   VNC session is not permission to compete with task or desktop ownership.

RFB password authentication authenticates the client to the server; it does not
replace this VM-owner proof or provide encrypted transport. See
[RFC6143 security](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.2.2).
Private local IPC and the process-held VM object are the proposed trust root.
This protects against stale/replaced targets within the existing trusted-host
boundary; it is not hardware remote attestation or protection against a
compromised host account/guest kernel.

## Account and key bootstrap without circular SSH trust

Create two operation-specific directories under the private host bootstrap root:
`input-<id>` shared read-only and `receipt-<id>` shared read-write. Pin their
canonical device/inode identities and actual share configuration in the owner
lease. Share no host home, repository, SSH directory or credential store. Never
mount these directories in another VM. Restrict receipt size and file types;
reject aliases, symlinks, changed identity, stale nonces and unexpected files.
The writable share is an explicit guest-to-host input boundary, not a trusted
host-code directory. Never execute its contents.

| Stage | Effect and evidence |
| --- | --- |
| Human setup | Person completes normal macOS26 Setup Assistant in the embedded console, including account/password and any required security decisions. Initial implementation has no unverified automated screen transitions. Preserve SIP and normal lock/security behavior. |
| Local helper launch | After an explicit human bootstrap authorization, launch the signed helper in that guest GUI account from the read-only share. An initial human launch is acceptance scaffolding only, not a final mandatory manual installation flow. Seamless onboarding still requires a verified background delivery/launch path for this non-consent step. Gatekeeper or removable-volume prompts remain human-only; no auto-launch or keyboard sequence is presumed verified. |
| Account/trust observation | Helper derives its real/effective UID/GID, OS account name/home and home device/inode, OS version/build, plus the existing SSH Ed25519 **public** host key. No password/private host key is read or exported. Human enables Remote Login for only this account first. Missing host public key is a wait state, never permission to generate system keys or toggle services. |
| Receipt transport | Helper writes a bounded receipt for the original nonce, target/config/restore/epoch and helper digest through the dedicated receipt share. Host accepts it only while the authenticated VM owner attests the original share mapping and lease. A file appearing on disk without that live original-owner proof is not sufficient. Original account and trust receipts feed the existing personalization ledger. |
| Per-guest client key | Only after that account/trust binding exists, invoke the already implemented original key producer. Its private key remains in the host's private per-guest reference. Publish **only its public key** and the bound installation intent into the input share. This avoids the producer's existing trust precondition becoming circular. |
| Public-key installation | Helper consumes the immutable manifest, checks the original account/home/key digest, persists intent, then creates the owned `.ssh`/`authorized_keys` entry without replacing unrelated keys. Use `.ssh` mode0700, file mode0600 and the line `restrict ssh-ed25519 <public> terminalx-bootstrap:<id>`. SSH supplies neither forwarding nor a PTY; task PTYs remain inside the authenticated runtime. Preserve original unrelated lines and retain before/after digests. Interrupted writes reconcile the original intent, never regenerate or append duplicates. Unknown/conflicting files fence recovery. |
| Final trust confirmation | Receipt binds installed authorized-key digest and unchanged host public key to the original operation. First SSH uses strict pinned host-key authentication, isolated config and the new key only, then verifies the same account/home/target. A mismatch returns to a held state; never accept a new key, password or another OS. Existing runtime/Driver/Codex delivery can now proceed. |

The helper's local observation, public-key write and recovery are now implemented
in `src-tauri/src/local_vm/macos_bootstrap_helper.rs`, with descriptor-relative
storage in `macos_helper_fs.rs`. Native filesystem tests construct only synthetic
channel/account/key observations in disposable directories. A digest string
supplied by UI, OCR output or a fixture is not a production trust constructor.
The future internal constructor must consume the authenticated owner/share proof
directly and retain a live lease check before every effect and receipt acceptance.
OpenSSH documents the [authorized_keys format and restrictions](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT).

## Implemented helper boundary and remaining integration

The internal helper entrypoint refuses before opening any OS account, public
host-key or authorized-keys path: authenticated channel acquisition is unavailable.
There is no CLI/RPC route or request-deserializable channel constructor. Existing
production and legacy transports are unchanged. The native engine performs the
following work only when an internal channel capability is present (currently
constructed solely by disposable tests):

* Read strict, size-bounded manifests tied to the original bootstrap, VM/config
  fingerprint, generation, restore/runtime/helper digests, parent identity, nonce,
  owner epoch and two distinct host/mounted share identities.
* Observe the account name/UID/GID/home and exact macOS26 version/build; validate
  the original home and the helper's bytes. Read only the existing Ed25519 public
  host-key file; absence is a refusal, with no generation or service action.
* Retain immutable original observation and key intents under one private home
  ledger and stable exclusive lock. Use no-follow descriptor-relative file access,
  reject aliases and changed device/inode/ownership/mode, and check the same open
  file before and after bounded reads or writes.
* Persist the original key intent before creating `.ssh` or its file; persist
  original file identity/bytes and expected result before appending one restricted
  public-key line. Preserve unrelated bytes, existing file identity and history.
  New directories/files use modes0700/0600; unsafe existing entries are refused,
  never chmodded, truncated, renamed or replaced.
* After interruption, inspect the original file under the retained intent. Only
  the exact expected full bytes on that same file permit a local completion
  receipt. Partial writes, changed/missing records, changed input or conflicting
  identities remain fenced. No retry appends a second key. Partial publications
  remain intact; a missing immutable receipt can be republished from verified
  original evidence without repeating the key effect.

Every receipt explicitly reports `ready:false` and `trustAccepted:false`. A local
`publicKeyInstalled` observation describes file bytes, not authentication or
serving readiness. The restricted-Lume candidate now inspects the owning VM's
actual runtime shares and serves receipts through authenticated private IPC;
the Rust client validates and journals them in a separate candidate admission
ledger. Its provisioning-bound host launcher now retains the original private
reference, dispatch fence, owned-child outcome and authenticated reconnect.
It does not promote production account/SSH trust. Approved artifact/catalog
acquisition, the helper's authenticated guest-side channel acquisition, signed
helper packaging, and seamless guest launch remain missing. Fixtures do not prove
live owner/share behavior, macOS26 provisioning or SSH acceptance. No profile or
dependency was installed to run these tests. VNC is disabled in this candidate
because its private server's listener binding remains unverified.
The [offline input audit](../integrations/lume-bootstrap/OFFLINE-BUILD.md) records
the exact missing source/dependency revisions; focused fixture/typecheck results
do not constitute a full upstream candidate build.

## Human steps and background behavior

Apple documents [normal Mac setup](https://support.apple.com/guide/imac/set-up-your-mac-apd831707cb3/mac)
and [Remote Login](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac).
These documents describe supported interactions, not tested macOS26 VM coordinates
or a fixed screen ordering. Hardware, locale, OS build and account state can alter
what appears. Apple also describes [managed Setup Assistant controls](https://support.apple.com/guide/deployment/manage-setup-assistant-depdeff4a547/web);
MDM enrollment is not assumed or introduced here.

TerminalX's human-only policy must cover the following when present: license/terms
acceptance; local account identity/password; optional Apple Account/2FA or recovery
choices; FileVault/security policy; Remote Login/account access and admin prompts;
Gatekeeper/volume-access consent; Driver Accessibility, Screen Recording or other
OS permissions; and guest-owned provider/device authorization. Some optional
choices may be skipped by the person. Do not claim Apple requires every pane on
every VM, or automate a security decision merely because it is clickable.

Offer a single guided setup visit with exact VM identity. The embedded console
opens only when the person chooses it; it must not raise Screen Sharing, switch
host focus or touch the comparison VM. Outside that visit, observation and
non-consent work use the background broker. Hide secret-entry frames from agent
capture, logs and retained artifacts. Human control suspends automation under the
same lease. Returning control requires a fresh frame/identity check, not a queue
of previously planned input. Until screen transitions are genuinely verified,
normal Setup Assistant stays human-operated rather than advertised as unattended.

## Apple macOS26 restore metadata and checksum path

Apple's documented `VZMacOSRestoreImage.latestSupported` returns the latest image
supported by the host, with URL, OS/build and configuration metadata. It has no
documented version26 selector or whole-image SHA256 property. Local
`image(from:)` requires a file and the Virtualization entitlement; it is a later
image-validation step, not a metadata-only network importer.
[Apple API](https://developer.apple.com/documentation/virtualization/vzmacosrestoreimage),
[Apple installation guide](https://developer.apple.com/documentation/virtualization/installing-macos-on-a-virtual-machine).

The live Apple HTTPS [IPSW metadata feed](https://mesu.apple.com/assets/macos/com_apple_macOSIPSW/com_apple_macOSIPSW.xml)
was read on 2026-10-28 without requesting any IPSW bytes. Its `VirtualMac2,1` entry
advertised **27.2 / 26B123**, not macOS26. That VM entry had no `FirmwareSHA1` or
SHA256 field. Other hardware entries supplied SHA1; do not promote those to a
verified VM image digest. The retained 98,974-byte metadata file's SHA256 is
`4b9fa1c38979e9dd585d24ee7047524b4f9044bf188a8d7f316e1dda77713087`;
**this hashes the metadata, not an IPSW**. The feed is Apple-origin evidence but
its schema is not a documented stable API and it is not a historical release list.

The new `scripts/macos-restore-metadata.py` reads only that fixed metadata URL, or
an explicitly untrusted-origin offline plist. It selects only VirtualMac2,1 and
major26, rejects redirects/conflicts/foreign URLs and always reports
`catalogEntryEligible:false`. It never follows a firmware URL, downloads an
IPSW, computes an imaginary image digest, or writes the production catalog.

The supported acquisition sequence for an older **26.x** build is:

1. Retain an Apple-origin 26.x descriptor from the Apple Developer
   [More Downloads](https://developer.apple.com/download/all/) portal or a genuine
   previously archived Apple metadata response. The portal was inaccessible
   without its normal access flow in this research; no historical26 descriptor
   was obtained. Do not substitute an ipsw.me/Mist checksum, `latest`, a guessed
   CDN URL or macOS27. A third-party index can only be a discovery hint pending
   Apple-origin verification.
2. In a separately authorized acquisition, obtain those exact bytes over verified
   Apple HTTPS, retain response/redirect/source provenance, byte length and an
   independently computed SHA256. Validate a published publisher digest if one
   accompanies that exact descriptor; no SHA256 was published in the observed
   VM feed. TLS failure is not permission to disable certificate verification.
3. Use Apple's local restore-image API to verify OS major26, exact build and
   supported hardware/configuration; retain the actual validation result. Image
   metadata parsing alone is not installation/signature acceptance. Apple's
   installation/trust checks and the fresh VM acceptance remain subsequent gates.
4. Review the immutable catalog entry containing that real URL/build/size/SHA256
   and evidence. Production catalog stays empty until then.

The optional `gdmf.apple.com/v2/pmv` discovery read failed certificate validation;
it was not retried insecurely and contributes no evidence. No IPSW download or
catalog entry was made.

## Review decision and smallest acceptance

**Recommended decision:** accept the source direction of a separately signed
`lume-terminalx-bootstrap-v1` extension on the exact base above, reusing noVNC1.7.0
and the two-share receipt protocol. The user has now authorized reversible source
development in that direction, and the concrete candidate is linked above.
Dependency/profile adoption, artifact approval, installation, live activation and
owner replacement remain separate decisions. The alternative is a TerminalX-owned
Virtualization runner/console, a larger dependency replacement; it also requires
background input and signing/distribution acceptance and is not presumed approved.

Before any activation, the bounded proof must cover: no unsolicited SSH or secret
logs; exact original VM/owner/socket/share binding; verified loopback-only VNC
behavior; no host focus changes; human-only control and redaction; virtiofs access
from the actual GUI account (do not assume LaunchAgent access); original receipt
recovery after interrupted helper/input/key installation; conflicting identities
refused; and successful strict pinned SSH only after the share trust ceremony.
Fake fixtures can establish protocol/state-machine behavior, not these live facts.

The smallest future coordinated live step is **one explicitly approved disposable
macOS26 VM**, using a separately reviewed restore image and bootstrap build, for
one guided setup/security-consent visit and background console/share/key/readback
proof. It must be separate from both retained VMs and does not require stopping
the old pilot. That VM creation, image download, key/account operation, profile
activation and any cleanup need their own concrete authorization. None is
requested or implied by this source/research turn. Host lock/sleep/restart and
production/pilot replacement remain separate holds. Acceptance and PR readiness
remain false.
