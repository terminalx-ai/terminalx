# macOS26 signed first-boot helper delivery and enrollment

Design proposal, 2026-10-29, based on PRO-114 checkpoint `7536499c`. It answers
the closed seam in [the guest channel contract](LOCAL-VM-GUEST-CHANNEL.md#exact-closed-seam-and-next-integration-choice).
**Nothing here is implemented.** No VM, disk image, restore image, privileged
component, installed profile, account or credential was created or changed.
The only experiment used a disposable 64 MB APFS image unrelated to any VM.

## The missing primitive, restated

`VZVirtioSocketConnection` gives the host a route into one VM, not the identity
of the guest process on the other end. A share echo or a guest-reported account
cannot repair that. The design replaces the missing peer identity with
**possession of a per-VM enrollment key that only guest root can read**, which
the host places on the guest disk before the guest has ever run. The host then
authenticates the helper by a MAC over a fresh challenge on the existing
port-49871 listener. The key never crosses a share or the socket.

## Recommended chain

| # | Stage | Actor | Effect | What it establishes |
| --- | --- | --- | --- | --- |
| 1 | Consent | Person, TerminalX guided Create | Chooses macOS26, the intended account name, and approves installing the TerminalX VM helper in this VM | Host-side human intent; never agent-callable |
| 2 | Restore | Existing pinned `lume create --ipsw` | VM created and stopped | Existing `createReceipt` |
| 3 | Offline seed | New privileged seeder | Writes exactly three root-owned items to the guest Data volume | Seed receipt from readback with ownership enabled |
| 4 | First boot | Existing `run` | launchd starts the helper before any login | Nothing by itself |
| 5 | Enrollment | Helper ↔ restricted owner listener | HMAC proof of the seeded key | `helperAuthenticated`: guest root in this exact VM holds the key |
| 6 | Setup Assistant | Person, in the owned console | Creates the account and makes any security choices | Human-only; unchanged from the console proposal |
| 7 | Account confirmation | Helper reports; person confirms in TerminalX | Authenticated account observation matched to stage-1 intent | `accountAuthenticated` for that one account |
| 8 | Account effects | Helper child after dropping to that account | Existing restricted `authorized_keys` engine | Existing receipts |
| 9 | Retirement | Helper | Deletes key, binary and plist | Retirement receipt |

`ready` stays false throughout. Stages 5 and 7 replace the refusal in
`acquire_authenticated()` (`src-tauri/src/local_vm/macos_guest_channel.rs:286`);
stage 8 reuses `macos_bootstrap_helper.rs` unchanged in substance.

## What the seed writes, and what it never writes

| Path on the guest Data volume | Owner / mode | Content |
| --- | --- | --- |
| `/Library/LaunchDaemons/com.terminalx.next.vm-bootstrap.plist` | `root:wheel 0644` | `Label`, absolute `Program`, `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`. No arguments, environment, `UserName` or secrets. |
| `/Library/Application Support/TerminalX/VMBootstrap/terminalx-vm-bootstrap` (parents `root:wheel 0755`) | `root:wheel 0755` | Catalog-pinned, Developer ID signed arm64 helper. No extended attributes, so no quarantine. |
| `/private/var/db/com.terminalx.next.vm-bootstrap/enrollment.json` (directory `root:wheel 0700`) | `root:wheel 0600` | `{version, bootstrapId, targetDigest, seedId, key}`: 32 bytes from the host CSPRNG, base64. |

The seed **never** creates or edits accounts, `.AppleSetupDone`, autologin,
`kcpassword`, `sshd` state, power/lock preferences, SIP/NVRAM, profiles, or the
sealed system volume. That is the difference from the pinned upstream
[offline patcher](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Unattended/MacOSOfflineSetupPatcher.swift),
which writes all of these to create a fixed `lume/lume` account and skip
Setup Assistant. Only its mechanism (attach a stopped VM's raw disk, locate the
APFS volume with the `Data` role, write before boot) is reused.

## Why the seed needs host root

- `launchctl(1)` on this host: "All system-wide daemons (LaunchDaemons) must be
  owned by root. Configuration files must disallow group and world writes."
- `diskutil(8)`: with ownership disabled, owners "appear to the user and
  programs as the current user"; enabling ownership is how "exact settings are
  written to the disk", and "Running as root is required."
- Upstream attaches with `hdiutil attach -readwrite -nomount` and plain
  `diskutil mount` as the invoking user, with no `chown` or owners flag
  ([DiskImageSession](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Utils/DiskImageSession.swift)).
- The disposable fixture (see Evidence) reproduced that sequence on this host.
  Files read back as `501:20` both with ownership disabled and after
  re-attaching with `-owners on`, and `chown 0:0` failed with "Operation not
  permitted" in both modes.

So an unprivileged seed would leave a LaunchDaemon that launchd refuses. Its
"root-only" key would also belong to whichever guest account holds that UID,
commonly the first account Setup Assistant creates. Exclusivity needs a
privileged host write followed by an ownership-enabled readback.

## Decision: the privileged host step

TerminalX ships no privileged host component today. On 2026-10-30 the user
selected **Option A** as the architectural target. Its validation is planned in
[the helper validation plan](LOCAL-VM-HELPER-VALIDATION-PLAN.md); nothing in it
has run. The options considered were:

| Option | Mechanism | Cost |
| --- | --- | --- |
| **A. Bundled seed daemon** | `SMAppService.daemon(plistName:)` (macOS 13+); plist in the app's `Contents/Library/LaunchDaemons`; one XPC request type, restricted to the TerminalX app's code requirement | One-time approval in System Settings, revocable (`SMAppServiceStatusRequiresApproval`). A persistent root component on the person's Mac that needs its own security review, signing and notarization. |
| B. Per-Create admin prompt | One-shot root tool | `AuthorizationExecuteWithPrivileges` is deprecated in the installed SDK ("should no longer be used"). `osascript … with administrator privileges` is a scripting facility, not an app-grade boundary. Prompts on every Create. |
| C. Keep the person-launched helper | Scaffolding from the console proposal | No host privilege, but not seamless; the existing docs already reject it as final onboarding. |

**Recommendation:** treat A as the target, but do not build it yet. First, in
the one approved disposable acceptance VM, have the person run the seed once by
hand with `sudo` to establish the guest-side facts listed below. Option A is
only worth its review cost if those facts hold.

## Seeder contract

1. Accept only an original provisioning operation in state `created` with no
   run record, and only for the restricted bootstrap profile. Take the same
   config-file lock Lume uses to prove the VM is stopped. Pin the disk image's
   device, inode, size and owner, and require the owner to equal the caller's
   audit-token UID.
2. Attach with `hdiutil attach -readwrite -nomount -noautofsck`. Require
   exactly one APFS volume with each of the `System` and `Data` roles. Mount
   `System` read-only and check that `SystemVersion.plist` is major 26 with
   the build retained by the restore record.
3. Mount `Data` with ownership enabled plus `nobrowse,nosuid,nodev` at a fresh
   root-owned `0700` mount point. Refuse unless the volume is pristine: no
   `/private/var/db/.AppleSetupDone`, no local user records with UID ≥ 501, and
   none of the three TerminalX paths. This also prevents retrofitting either
   retained live VM.
4. Write by descriptor only: `openat` with `O_NOFOLLOW` per component, check
   every directory's `st_dev` equals the mounted Data volume, then
   `O_CREAT|O_EXCL`, `fchown`, `fchmod`, write, `fsync`. A symlink or a foreign
   device anywhere is a refusal: a root writer must never follow
   guest-controlled links onto the host.
5. Read back after unmount and a fresh ownership-enabled mount: owner, mode,
   size and SHA256 of each item. Detach, then journal the seed receipt.
6. Journal `created → seedOutcomeUnknown → seeded`. `run` for this profile
   requires `seeded`. An unknown outcome is resolved only by readback. Exact
   expected items complete the seed; partial or foreign content fences the
   operation. Never reseed, delete or repair automatically.

The enrollment key uses the existing private reference lifecycle in
`macos_keys.rs`: intent before material, `0600` storage in the operation
directory, a terminal receipt, and `retire`. It never appears in argv, logs,
events, shares or socket frames.

## Enrollment protocol (TXGuestProtocol version 2)

- Hello: `{version: 2, clientNonce, bootstrapId, seedId}`.
- Challenge: the current challenge fields plus `bootstrapId`, `seedId` and the
  seed receipt digest. Each attempt's challenge is journaled before it is sent.
- Proof: `tag(K, "enrollment", [challengeSha256, claimsSha256])`, using the
  existing length-prefixed, domain-separated HMAC-SHA256 construction
  (`macos_owner_channel.rs` `mac`/`verify`, Swift `txTag`/`txEqualTag`), with a
  new domain prefix so tags cannot cross protocols.
- Session: an HKDF-SHA256 key (`hkdf` 0.12 is already a dependency) over both
  nonces, the binding digest and the owner epoch. Every later frame in both
  directions carries a sequence number and a tag under that key.
- Admission: unlike today's single `claimed` connection, an attempt whose proof
  fails changes no state beyond a bounded refusal record, so a non-root guest
  process cannot deny enrollment just by connecting first. Exceeding the
  refusal budget fences the operation for inspection.
- On success the owner journals `helperAuthenticated: true`, which means
  exactly: *a guest-root context in the VM behind this exact socket device holds
  the seeded key*. `accountAuthenticated`, `trustAccepted` and `ready` stay
  false.

Shares are no longer the trust path. The read-only input share may still carry
bulk artifacts, accepted only against digests sent over the authenticated
session. The version-1 share-echo observation remains for retained histories.

## Account confirmation and effects

- The helper waits for the person to finish Setup Assistant. It never drives
  Setup Assistant or creates accounts.
- It observes local accounts with UID ≥ 501 through the existing `getpwuid_r`
  lookup (no password fields), plus home device/inode and the OS version/build,
  and reports them over the authenticated session.
- The host matches a candidate to the stage-1 intent. TerminalX then asks the
  person to confirm that exact account in the parent session's UI. This click,
  bound to the parent session/tab/conversation, is the human-approved intent
  writer the remaining gates call for.
- The host sends the confirmed intent over the session. The helper forks a
  child that calls `initgroups`/`setgid`/`setuid` to that account and verifies
  real and effective IDs. The child opens the home by descriptor and runs the
  existing restricted `authorized_keys` engine. Account files are never written
  as root.
- The SSH host public key still requires the person to enable Remote Login
  (human-only); its absence is a wait state. A separate later choice could
  carry the runtime over this authenticated session instead of SSH, which would
  remove that step. That choice is not part of this design.

## Retirement and person control

After the host acknowledges the final receipt, the helper unlinks the key,
binary and plist by descriptor, journals the result and exits 0, so `KeepAlive`
does not restart it. Leftovers become an inspection item and are never
reseeded. The person can disable the item in System Settings > General > Login
Items at any time. Apple's `statusForLegacyURL` exists so apps "still want to
know when a user disables its legacy daemons" in `/Library/LaunchDaemons`. A
disabled helper is a wait state that TerminalX explains and never re-enables.

## Trust boundary

| Actor | Can read the key? | Consequence |
| --- | --- | --- |
| Host user account | Yes, via the private reference | Already inside the trusted-host boundary |
| Privileged seeder | Writes it | New trusted component; kept narrow by the contract above |
| Guest root / admin (the person) | Yes | Accepted: the person owns this VM |
| Guest non-root processes | No | Can only spend the bounded refusal budget |
| Another VM | No | Different socket device; the listener is bound to the exact device |

This does not prove which guest binary holds the key, that the guest kernel is
intact, or anything resembling hardware attestation.

## Facts the first coordinated acceptance must establish

Each is unverified here and blocks Option A. The
[validation plan](LOCAL-VM-HELPER-VALIDATION-PLAN.md) assigns each one a run,
evidence and pass/fail criteria (G1–G6 there):

1. A restored macOS26 Data volume can be attached and mounted on the host before
   first boot, unencrypted. Upstream's `tahoe` preset implies this; it is
   not verified here.
2. A root-owned `0644` LaunchDaemon seeded offline is loaded on first boot
   before Setup Assistant completes, under Background Task Management defaults.
3. A pre-login root daemon can connect `AF_VSOCK` to `VMADDR_CID_HOST`;
   `vsock(4)` states guest-initiated streams are supported, with no login
   condition documented.
4. Setup Assistant and first boot leave the seeded items intact.
5. The restricted owner's real `VZVirtioSocketListener` accepts the connection.
   It is typechecked only today.
6. Disabling the item in Login Items prevents the launch, and the person sees
   the helper attributed to its signing team.

## Source slices after the decision

1. Seeder core with descriptor-relative writes and readback, tested against
   disposable APFS images. Non-root fixtures cover layout, no-follow and
   pristine checks; root ownership needs the acceptance run.
2. Version-2 enrollment in the Swift owner and the Rust helper, with
   cross-language socketpair fixtures for proof, refusal budget, replay and
   tampered frames.
3. An authenticated `Channel` constructor fed by the session, replacing
   `acquire_authenticated()`, plus the privilege-dropping account child.
4. Seed journal states in `macos_provision.rs` and the `run` precondition.
5. Option A packaging, reviewed separately; it is not started by this document.

## Evidence

Retained under `~/.raccoon/task-coordination/pro114-pro117/passes/20261029-helper-delivery/`:

- `primary-source/Unattended_MacOSOfflineSetupPatcher.swift`
  `2b64fc869341d15b3941434e078a3bddb3e396036191ee311ed876b643d2f582`
- `primary-source/Utils_DiskImageSession.swift`
  `4f46fe9c28e13432be693c1027d9610e1e3bb8df084e398549f6ddc7aac45208`
- `primary-source/Commands_Sip.swift`
  `3176be6c6a8db4069f6aad2432f57758c0fcbbbccda3f5fa626b36f7e85c4b31`
- `ownership-fixture.txt`
  `10789cc966003331c8b9c52e418908bd11667646ee9cec0a8c463eafbbee6006`.
  Host macOS 26.3.1, SDK 26.5, euid 501; the image was detached and deleted.

All upstream files are from commit `3350f504014c85416009a90fcb339fe556ce02fc`.
Apple sources are the installed SDK headers (`SMAppService.h`,
`Authorization.h`), the local `launchctl(1)`, `diskutil(8)`, `hdiutil(1)` and
`vsock(4)` pages, and the
[background tasks deployment guide](https://support.apple.com/guide/deployment/depdca572563/web).
No dependency, profile, privileged tool, VM, image or account operation was
used. Acceptance and PR readiness remain false.
