# macOS26 guest observation channel and remaining authentication boundary

This source candidate removes the pre-launch requirement for guest mount inode,
UID and OS-build observations. It does **not** authenticate the guest helper or
enable fresh creation. The restricted Lume profile is still unadopted; its exact
upstream base is `3350f504014c85416009a90fcb339fe556ce02fc`.

## Verified transport contract

macOS guests can initiate stream vsock connections. An Apple engineer confirms
that the host must receive them through `VZVirtioSocketDevice`; guest sockets use
the macOS kernel's transport to Virtualization. This is supported guest transport,
not a localhost TCP approximation. [Apple's explanation](https://developer.apple.com/forums/thread/731132).

The installed Xcode SDK's `sys/vsock.h` and `vsock(4)` specify `AF_VSOCK`, a
12-byte `sockaddr_vm`, `VMADDR_CID_HOST = 2`, and guest-initiated stream connections.
Nonblocking connect requires polling and checking `SO_ERROR`. The Rust connector
uses these installed libc constants and struct, fixes candidate port 49871 and
offers no alternate endpoint, inherited configuration or fallback. Tests never
call this connector or create an AF_VSOCK socket.

The candidate adds one `VZVirtioSocketDeviceConfiguration` in bootstrap mode and
installs a listener on the exact owning runtime device. The callback must match
that device and listener object and the fixed destination port. It retains the
`VZVirtioSocketConnection`, which owns the descriptor, during the exchange. These
are the actual installed SDK interfaces, typechecked against Virtualization.
[Socket devices](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/socketdevices),
[listener delegate](https://developer.apple.com/documentation/virtualization/vzvirtiosocketlistenerdelegate),
[connection](https://developer.apple.com/documentation/virtualization/vzvirtiosocketconnection).

**Those interfaces supply no remote guest PID, UID, executable digest or code
signer.** A guest process can claim another account's name. A fresh public nonce
read from a share does not repair that omission. The installed SDK exposes only
the runtime device, connection ports and descriptor at this boundary. Unix peer
credentials remain appropriate for the separate host control socket, never for
claiming remote guest account identity.

The exact upstream source configures no socket device or guest helper launch. Its
optional serial attachment has no host-to-guest reader and supplies no account
authentication. Adding a device does not install an agent into macOS.
[Pinned virtualization source](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Virtualization/VMVirtualizationService.swift).

## Implemented source flow

1. Under the original provisioning lock, the internal writer derives a version-2
   host plan from the retained created-VM target, account intent and host parent /
   expected artifact intent. It creates one epoch, nonce and pair of share IDs.
   The launcher adds its actual opened host share inode/device pins. No guest
   UID, mount inode, OS build, host key or proof flag can enter this typed plan.
   Reopen retains the original version and history; version-1 operations are not
   migrated. Missing/partial/changed planning remains fenced.
2. The host plan is shared read-only as `host-plan.json`. The historical private
   filename `expected-helper.json` and binding digest field remain versioned
   storage names; version 2 is **not** an executable helper manifest. It cannot
   be consumed by the original authorized-key helper or account receipt admission.
3. The real VZ callback admits at most one guest connection. Before publishing a
   fresh challenge, the owner exclusively persists its original attempt. It
   checks the live VM, exact runtime share names/URLs/read-only flags, retained
   config and paths. An unknown or partial attempt never permits replacement.
4. The guest protocol uses opened directory descriptors and local source
   observations. Local account/home/OS observation no longer requires a prebuilt
   authenticated `Channel`; it is still only a local observation. The guest checks
   the host plan and fresh probe against its input descriptor, then journals
   before a single bounded echo through its output descriptor. It neither reads
   host credentials nor performs account/key effects. Alias, ownership, account,
   artifact, challenge and partial-write mismatches refuse.
5. The owner checks that echo through the exact pinned output share and records
   the claims in its private operation journal. This establishes a VM route and
   a share round trip. Every result explicitly has `accountAuthenticated:false`,
   `helperAuthenticated:false`, `trustAccepted:false` and `ready:false`.
6. Host reconnect reads the immutable observation through the original private
   owner socket and a fresh mutual MAC challenge. It never reruns the guest
   exchange. Changed receipts or attempts to assert account trust refuse.

No private host control capability goes to a guest share or vsock frame. Probe
nonces are freshness challenges, not secret credentials. A malicious guest actor
can consume the one attempt and deny progress; the source deliberately retains
that uncertainty instead of trying a second actor or a replacement owner.

## Exact closed seam and next integration choice

The code cannot create a genuine final expected-helper/account manifest from
these observations. `Channel::acquire` refuses before opening a socket or probing
account/mount/key data. The source has no request-deserializable proof constructor.
The host-context writer likewise does not assert human approval: production still
needs the authenticated parent/human-approved intent path and a trusted helper
catalog before it can use that intent. File presence is neither approval nor
helper authentication.

No automatic guest mount path or host-to-guest UID mapping is assumed. The
protocol consumes already-opened, owner-checked descriptors; discovering them as
authenticated original shares is still closed. Kernel mount metadata, a matching
filename or a public nonce echo alone cannot construct those capabilities.

The missing primitive is **trusted first delivery and launch of a particular
helper, with exclusive access to a guest enrollment capability bound to the
original VM/account/share operation**. The current Lume/Apple socket interfaces
do not provide that primitive. The account/host-key/public-key installation
engine must remain downstream of it. Guest-reported signature checks or a
request-supplied enrollment token would not prove exclusive delivery.

The next source direction should therefore specify and verify a signed first-boot
helper delivery/launch chain before extending this protocol to account authority.
It must establish who can obtain the enrollment capability, how the selected
person-approved account obtains it, and how the host authenticates that original
launch without trusting a shared file or guest assertion. No such supported
delivery interface has been verified in the pinned dependency set. Choosing an
image customization/delivery dependency is a distinct, reviewable dependency
proposal; it is not accomplished by enabling this listener. A person-launched
helper may support coordinated acceptance experiments, but is not the required
seamless final onboarding and is not implemented as a product fallback here.

The proposed chain is specified in [signed first-boot helper delivery](LOCAL-VM-HELPER-DELIVERY.md):
a privileged offline seed of a root-only per-VM enrollment key and LaunchDaemon
before first boot, then a MAC proof on this listener. It is a design, not source.

## Evidence scope

Native Swift/Python and Rust/Swift fixtures use inherited Unix socketpairs,
synthetic identities and disposable directories. They exercise actual framing,
filesystem journaling, strict content handling, interruption, same-owner readback
and no-replay behavior. The VZ adapter is typechecked; no VZ object or live guest
is instantiated. Production catalog/acquisition, signed helper delivery, actual
mount acquisition and live acceptance remain unavailable/unverified.

The full exact-source / 18-locked-dependency offline build blocker is unchanged;
this continuation neither repeated cache preflight nor resolved dependencies.
See [the retained offline build plan](../integrations/lume-bootstrap/OFFLINE-BUILD.md).
macOS26, separate Attach desktop tools / Run task in VM, human-only safeguards,
and acceptance/PR holds remain unchanged.
