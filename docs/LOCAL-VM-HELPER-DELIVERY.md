# macOS26 signed first-boot helper delivery and enrollment

Design proposal, 2026-10-29, based on PRO-114 checkpoint `7536499c` (design
commit `394fe794`). It answers the closed seam in
[the guest channel contract](LOCAL-VM-GUEST-CHANNEL.md#exact-closed-seam-and-next-integration-choice).

**When it was proposed (2026-10-29), nothing here was implemented.** No VM,
disk image, restore image, privileged component, installed profile, account or
credential was created or changed. The only experiment used a disposable 64 MB
APFS image unrelated to any VM.

**Since then (2026-10-30 to 2026-10-31), parts are implemented in source.**
They are recorded in the dated notes below and in
[source slices](#source-slices-after-the-decision).

These are source, fixture and local-build results only:

- **Local builds, ad hoc signed.** The validation probe and seed tool
  ([validation plan](LOCAL-VM-HELPER-VALIDATION-PLAN.md#prerequisites-what-exists-and-what-is-missing)
  P3 and the [run sheet](LOCAL-VM-HELPER-RUN-SHEET.md)) and the restricted Lume
  owner (P6) were built locally and carry only the linker's ad hoc signature.
  The guest helper's enrollment, account child, key install and host-key
  report are implemented and fixture-tested in `native/vm-bootstrap`. Its
  executable `terminalx-vm-bootstrap` exists only as a local ad hoc candidate
  build ([guest helper executable](#guest-helper-executable)).
- **Nothing is distributed or adopted.** Nothing is Developer ID signed,
  notarized, catalog-approved, installed, adopted or accepted, or run in a
  real VM or guest.
- **Still absent or held.** The restore catalog is still empty. The bundled
  seed daemon (Option A) is not implemented, and its packaging is held for a
  separate review.
- **Host requests, not person approvals.** On 2026-10-31 the user rejected a
  per-operation human-presence approval and confirmed that host agents may
  control VMs. Account confirmation, key install and host-key pin are trusted
  host requests with their exact bindings kept
  ([host requests and the guest boundary](#host-requests-and-the-guest-boundary)).
  They stay unreachable in production while the owner artifact, admission and
  runtime gates refuse. Readiness and acceptance stay false.
- **Resources used.** No live, privileged or restore-image operation was
  performed. The only downloads were source repositories for the offline Lume
  build, and the only disk images were disposable test images.

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
| 1 | Consent | The person, or an agent on the trusted host, through TerminalX guided Create | Chooses macOS26, the intended account name, and installing the TerminalX VM helper in this VM | Host-side intent. Host agents may send it (decision 2026-10-31, [host requests](#host-requests-and-the-guest-boundary)). The seed daemon's own approval stays in macOS System Settings (H3) |
| 2 | Restore | Existing pinned `lume create --ipsw` | VM created and stopped | Existing `createReceipt` |
| 3 | Offline seed | New privileged seeder | Writes exactly three root-owned items to the guest Data volume | Seed receipt from readback with ownership enabled |
| 4 | First boot | Existing `run` | launchd starts the helper before any login | Nothing by itself |
| 5 | Enrollment | Helper ↔ restricted owner listener | HMAC proof of the seeded key | `helperAuthenticated`: guest root in this exact VM holds the key |
| 6 | Setup Assistant | Person, in the owned console | Creates the account and makes any security choices | Human-only; unchanged from the console proposal |
| 7 | Account confirmation | Helper reports; the host confirms in TerminalX | Authenticated account observation matched to stage-1 intent | `accountAuthenticated` for that one account, after the helper's acknowledgement. The confirmation is a trusted host request, never recorded as a person's approval |
| 8 | Account effects | Helper child after dropping to that account | Existing restricted `authorized_keys` engine | Existing receipts |
| 9 | Retirement | Helper, after the owner's acknowledgement | Deletes key, binary and plist | Retirement receipt (the helper's own claim to the owner) |

`ready` stays false throughout.

- **As proposed:** stages 5 and 7 were to replace the refusal in
  `acquire_authenticated()` (`src-tauri/src/local_vm/macos_guest_channel.rs:286`),
  and stage 8 was to reuse `macos_bootstrap_helper.rs`.
- **As implemented (2026-10-31):** stages 5, 7 and 8 run over the enrollment
  session between the native helper and the restricted owner, and
  `acquire_authenticated()` still refuses
  ([source slices](#source-slices-after-the-decision)).
- **Order:** the helper enrolls only after stage 6
  ([guest helper executable](#guest-helper-executable)).

## What the seed writes, and what it never writes

| Path on the guest Data volume | Owner / mode | Content |
| --- | --- | --- |
| `/Library/LaunchDaemons/com.terminalx.next.vm-bootstrap.plist` | `root:wheel 0644` | `Label`, absolute `Program`, `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`. No arguments, environment, `UserName` or secrets. |
| `/Library/Application Support/TerminalX/VMBootstrap/terminalx-vm-bootstrap` (parents `root:wheel 0755`) | `root:wheel 0755` | Catalog-pinned, Developer ID signed arm64 helper. No quarantine attribute. `com.apple.provenance`, which a provenance-tracked writer cannot remove, is recorded and compared on readback. |
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
   size, SHA256 and extended attribute names of each item. Detach, then journal the seed receipt.
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

### Implemented wire form (2026-10-31)

Source: `integrations/lume-bootstrap/Sources/TerminalXEnrollment.swift` (owner)
and `native/vm-bootstrap/src/enroll.rs` (guest helper). All frames use the
existing TXWire framing and canonical JSON.

| Step | Frame | Checked |
| --- | --- | --- |
| Hello | `{bootstrapId, clientNonce, seedId, version: 2}` | Exact keys, canonical; both ids equal the binding. A refused hello gets no challenge and no journal entry. |
| Challenge | `{bindingDigest, bootstrapId, clientNonce, ownerEpoch, seedId, seedReceiptSha256, serverNonce, version: 2}` | Journaled before it is sent. The helper sends no proof unless every field matches its seed and its own hello. |
| Proof | `{challengeSha256, claims, proof}` | `proof = tag(K, "enrollment", [challengeSha256, sha256(claims)])` under the prefix `terminalx-vm-enrollment-v2`, distinct from `terminalx-lume-owner-v1`. Claims are a flat object of at most 16 values. |
| Session | `{body, seq, tag}` | Key: HKDF-SHA256 with `K` as input, both nonces as salt and `"terminalx-vm-enrollment-v2 session " + challengeSha256` as info. Each direction counts `seq` from 0. Tag: `tag(session, "frame", [direction, seq, sha256(body)])`. |
| Acceptance | owner frame 0 | Body `{accountAuthenticated: false, challengeSha256, helperAuthenticated: true, ready: false, trustAccepted: false}`; the helper refuses any other body. |

`TXEnrollmentGate` admits one attempt at a time. A failed attempt spends one
unit of a bounded refusal budget and never claims. The first valid proof
claims, after which nothing more is admitted. A spent budget fences the gate
for inspection. Cross-language fixtures (`Tests/enrollment_test.py`, run by
`verify.py`) cover the following, with an independent standard-library
reference playing a hostile peer on each side:

- Rust helper ↔ Swift owner;
- wrong keys, changed claims, replayed and redirected proofs;
- hellos and challenges for another seed or binding;
- non-canonical, oversized, closed and silent streams;
- refusal budget and claim;
- promoted or mistagged acceptance;
- out-of-sequence, tampered and reflected session frames.

**Listener (2026-10-31).** A version-3 owner binding adds exactly `seedId` and
`seedReceiptSha256`; versions 1 and 2 keep their exact forms and behavior. For
version 3:

- The restricted owner reads the key only from `enrollment.key` in its private
  operation directory (owner-only, single link). The key is never in the
  binding, argv, a share or a frame.
- The VZ listener runs `TXEnrollmentService` for each admitted connection. Each
  admitted attempt journals `enrollment-attempt-N.json`.
- A verified proof writes `enrollment.json` before the acceptance frame is
  sent. That file holds digests, ids and `helperAuthenticated: true`, with
  account authentication, trust and readiness false.
- A durable receipt claims even if the reply is lost, so enrollment is never
  repeated.
- The owner channel serves only the `enrollment` action for version 3, and
  never serves it for version 2.

`protocol_test.py` runs the real service after a genuine launch hand-off with
the real Rust helper. It covers refusals, the budget fence, the claim, a lost
reply, a missing key and a malformed seed binding.

**Host (2026-10-31).**

- `macos_seed.rs` generates the key and seed id and journals intent, then an
  exact readback receipt or a fence. It never reseeds.
- The launch writes a version-3 binding and an owner-only `enrollment.key` hand-off
  only for an exactly seeded guest. An unresolved or fenced seed never launches.
- `Reference::enrollment()` accepts only an exact helper-authentication receipt.
- `Reference::stop()` asks a version-3 owner to stop its VM. The owner journals
  `stop-requested.json` once, answers, and only then stops. Exit evidence is
  only the original child-wait record.

**Account confirmation (2026-10-31).** After acceptance the helper reports
the local personal accounts it observes (UID at least 501, `/Users/<name>`,
home device and inode). The owner journals that as `account-observation.json`,
with helper authentication only.

**Host request (since 2026-10-31).** The person, or an agent on the trusted
host, confirms one of those accounts through `environment.confirmGuestAccount`
([host requests](#host-requests-and-the-guest-boundary)). Until 2026-10-31 this
step refused for want of a verified person approval; that gate is removed and
kept only as history ([person approval](#person-approval-for-person-only-actions)).
Production still cannot reach it: no version-3 owner launches
(`Artifact::production()` refuses) and personalized admission is closed.

- The onboarding capability, `confirm: true` and the parent IDs scope the
  request to this bootstrap's original conversation. They are not evidence of
  a person's consent, and nothing records them as such.

The confirmation works like this:

- It is gated by the onboarding capability and needs `confirm: true`.
- It must quote the exact observation digest and one account from it, from the
  original parent session, tab and conversation.
- The host records `account-confirmation.json` exclusively before relaying it.
  A retry re-presents those same bytes, and a different account is refused
  for good.

The owner checks the confirmation against its journaled observation and
journals `account-confirmation-relay.json` exclusively; a lost-reply retry gets
the same record. It then sends the confirmation over the tagged session.

The helper accepts only an account it reported that still matches locally, and
acknowledges with the confirmation digest. Only that acknowledgement makes
`accountAuthenticated` true, recorded in `account-confirmation-answer.json` for
that one account. Trust and readiness stay false.

The confirmation request's payload digest joins all three owner-channel MACs.

**On-screen confirmation.** Each conversation's Local VM section lists only the
bootstraps whose original parent is that session, tab and conversation
(`environment.guestAccountConfirmations`). It shows the exact reported
accounts.

- **Prepared flow.** It requires a selection and an explicit consent checkbox
  before `environment.confirmGuestAccount`. It drops a selection when the list
  changes and explains stale-list refusals and safe retries. It shows a
  pending choice as immutable and states that confirmation is not trust or
  SSH readiness. Nothing is confirmed on load.
- **No approval lock.** Since 2026-10-31 status reports no
  `personApproval`, and the section offers each step whenever the evidence
  allows it. It stays read-only in a read-only tab.

The checkbox is an interface step for whoever uses the section. It is not
recorded as proof of consent, and an agent's identical request is accepted on
the same terms.

**Record publication.** The owner's `writeNew` and the host's `write_new` now
write under a unique hidden name and rename with `RENAME_EXCL`. Readers see no
record or the complete one, and an existing target of any kind is never
replaced. A fixture confirmed that the old writer let readers see prefixes.

**Account child.**

- `ConfirmedAccount` and `KeyGrant` can be built only from tagged session frames
  (`#[non_exhaustive]` outside the crate).
- `drop_to` returns a `Dropped` proof. `keys::install` requires that proof and
  the exact confirmed home (device, inode, owner), so no account file is opened
  earlier.
- The install uses the desktop engine's `authorized_keys` transformation,
  shared as one source file (`authorized_keys_text.rs`) compiled into both
  crates with the same tests.
- It journals intent before any effect in an account-private journal: no-follow
  `.ssh` and `authorized_keys`, a private file mode, a lock, the before-snapshot,
  and a single append.
- Interruptions reconcile without replaying creation or appending twice, and a
  changed file is reported as an unknown outcome.

**Key grant (2026-10-31).** Granting needs the helper's confirmed answer. The
host records `key-grant.json` exclusively. It binds the key reference and the
SSH public key (never a private key) to:

- the confirmation digest and the exact answer bytes;
- the account's name and uid;
- the original parent session, tab and conversation.

A retry re-presents the same grant, and a different key or reference is
refused for good.

The owner checks the grant against its relay and answer journals and journals
`key-grant-relay.json` once. It sends `{keyGrant: {keyReference, publicKey}}` over
the session and journals the helper's `{keyResult: {keyReference, stage}}` as
`key-install-result.json`. Only `publicKeyInstalled` counts as installed;
`outcomeUnknown` and `refused` never become success.

The helper's `child::Forking` installer works as follows:

- The root parent never opens an account file. A forked child drops permanently
  to the account, opens the confirmed home and an account-private journal, and
  installs. A failed or unreadable child result reports `refused` or
  `outcomeUnknown`.
- Without root it refuses before any fork or write. That refusal is what the
  host, owner and helper fixture records end to end.

**Per-VM key producer (2026-10-31).** `environment.grantGuestKey` (onboarding
capability, `confirm: true`, original parent session, tab and conversation
only) takes no key material and refuses `publicKey`, `privateKey` and
`keyReference` parameters. Since 2026-10-31 it is a trusted host request, no
longer refused for want of a person approval. The host:

1. Requires the helper's exact acknowledgement of the confirmed
   account. Before it, and after a refusal, nothing is bound, reserved or
   generated.
2. Binds the key to immutable identities verified through the owner: the
   binding digest and owner epoch, environment, generation and VM fingerprint,
   seed and seed receipt, the enrollment challenge and claims, the
   confirmation and exact answer digests, the account, the original parent,
   and the provisioning intent's digest.
3. Uses the SSH key reference the provisioning intent minted before the VM
   existed (`AccountPlan.ssh_key_reference`). That is the reference the
   post-trust transport requires, so no second reference is ever minted.
4. Reserves that reference in the existing key lifecycle
   (`macos-personalization-keys/<reference>`, state `reserved`), then
   publishes `key-intent.json` exclusively in the bootstrap journal.
5. Produces with the fixed OpenSSH producer under the existing lease and
   receipt rules, verifies the retained private file and pairing, and grants
   only the public half through the existing exact grant relay.

| Situation | Result |
| --- | --- |
| Lost reply or retry | The same reference and public key; the same grant record |
| Concurrent claims | One generation; the others get "in use" or the original key |
| Crash before publication or before generation | The same planned reference is generated once |
| Interrupted generation | `outcomeUnknown`; recovered only from the original child's receipt, never repeated, never granted |
| Missing reference, corrupt record or intent, changed private file | Fenced; nothing is generated |
| Changed enrollment, answer, account, epoch or parent | Refused: the key "belongs to another" binding |
| The planned reference already holds another binding's history | Fenced |

The private key stays in its owner-only reference. Tests check that no
bootstrap journal, intent, grant or relay contains it. The existing
post-trust producer is unchanged and still gated by `require_available()`.

`environment.guestAccounts` reports the key as `notGranted`, `keyPending`
(intent published, no grant yet; retrying uses only that key),
`grantPending`, or the helper's own result. In the prepared flow, the
confirmation control offers **Install SSH key** only after the helper's
acknowledgement, and **Retry with the original key** while pending. It never
offers a retry after a result. In this build the control shows the key state
with these actions disabled.

**Host-key review (2026-10-31).** This is the design's "Final trust
confirmation", up to but not including the first SSH connection.

1. **Helper.** Only after its own `publicKeyInstalled`, `hostkey::report_host_key`
   reads the existing `/etc/ssh/ssh_host_ed25519_key.pub`:
   - The directory and file must be root-owned, writable by no one else,
     not linked or aliased, bounded, and unchanged across the read.
   - Only `ssh-ed25519 <blob>` is reported, with the comment dropped.
   - The private host key is never opened. Nothing is generated, and sshd
     and Remote Login are never changed.
   - While the key is absent, the helper sends `hostKeyPending` about once a
     second, then `{hostKey: {keyReference, publicKey}}`.
2. **Owner.** It accepts pending frames only for the installed reference and
   within its conversation deadline. It journals `host-key-observation.json`
   once, binding the grant and key-result digests, with
   `trustAccepted: false` and `ready: false`, and serves it as
   `hostKeyObservation`.
3. **Host.** `environment.guestAccounts` reports the host key as
   `awaitingHostKey`, `awaitingReview` (with the fingerprint), `confirmed` or
   `changed`, always with `sshVerified: false` and `ready: false`.
   `environment.confirmGuestHostKey` (onboarding capability, `confirm: true`,
   original parent only) takes the observation digest and the exact
   fingerprint shown for review. It refuses `hostKey`, `publicKey` and
   `knownHosts` parameters. Since 2026-10-31 it is a trusted host request,
   no longer refused for want of a person approval. It then:
   - records `host-key-confirmation.json` exclusively; a different
     observation or key is refused for good and never re-pinned;
   - requires that the confirmed account is the account planned at Create;
   - writes the existing ledger's account and trust receipts together, once,
     under the ledger lock (`retain_confirmed_trust`).

   The existing `ssh_plan` then pins exactly that key: one `known_hosts`
   line, `StrictHostKeyChecking=yes`, no accept-new, and the produced
   original key as the only identity.
4. **UI.** The review shows the fingerprint and how to check it in the VM's
   own Terminal. **Pin host key** needs an explicit checkbox in the UI, which
   is an interface step, not a recorded approval. A pinned key is
   described as not yet a verified SSH connection, and `changed` is an alert
   with no action.

No SSH scan, connection or real host key is used. Native tests pin
synthetic keys against the compiled owner, and the Python suite drives the
real owner with the protocol's reference helper, because an unprivileged
Rust helper stops at `refused`.

**Transport join.** After the pin, the post-trust transport's
`macos_keys::resolve` accepts the version-3 key record for the same
reference. It requires the record to name exactly the transport binding's
reference, bootstrap, environment, generation, VM and full account, and its
acknowledged-answer digest must be the evidence behind the ledger's account
receipt. Every other record still needs the transport binding itself.
Before the pin the ledger is not `trustObserved`, so nothing resolves.

**Still to join, as written before 2026-10-31.** The first strict SSH
connection, which verifies the pin and the account, home and target, was not
wired. Transport admission (`require_available()`) and live runs remain
closed.

**First strict SSH connection (source and fixtures only, 2026-10-31).**
`macos_first_connection.rs` adds it behind those gates. Nothing has
connected to anything.

- **Connection.** It is built only through the existing transport plan
  (`command_for`, which `command_using` now wraps):
  - `-F none` and `StrictHostKeyChecking=yes`, against the single retained
    `known_hosts` line for the pinned key;
  - the produced private key as the only identity, just re-verified against
    its retained public key;
  - no agent, password, forwarding, proxy or control socket.

  Nothing accepts new keys, runs `ssh-keyscan` or writes a pin other than the
  existing exact one.
- **Remote check.** It is fixed, uses base-system tools only and has no
  effect. In the guest it checks:
  - the account's uid, gid, name and directory-service home;
  - the home's identity: not a link, same owner, device and inode;
  - that `.ssh` and `authorized_keys` are private, not links, owned by the
    account, with one link;
  - the exact `restrict <key> terminalx-bootstrap:<id>` line exactly once (the
    line now comes from the shared `authorized_keys_text::line`);
  - the guest's own root-owned public host key, equal to the pin.

  Only then does it read a fresh nonce from stdin and echo it.
- **Reply.** It must be at most 4 KiB and exactly
  `{stage: firstConnectionVerified, bootstrapId, uid, nonce}`. Then
  `first-connection.json` is recorded exclusively, with the binding, target,
  account, trust digest, key reference, `known_hosts` digest, public-key
  digest, remote-command digest and nonce, and `ready: false`. A failed,
  timed-out, oversized, refused or different reply records nothing; the check
  has no effect, so it may run again.
- **Stale receipts.** A receipt that no longer matches the binding, trust, key
  or pin stays fenced and is never replaced.
- **Delivery.** `deliver` runs the verification after the key is ready. The
  first `upload` refuses unless the receipt matches.
- **Admission.** `verify` and `deliver` both refuse at `require_available()`
  before any process, key access, pin write or network effect.
- **Tests.** They use a synthetic SSH stand-in, a script in a disposable
  fixture root that checks the strict argv, the pinned line, the sole
  identity and stdin. They cover:
  - the exact receipt and its single run;
  - nine bad replies: exit, timeout, oversized, not JSON, refusal, another
    nonce, account or bootstrap, extra field;
  - a changed VM or pin refused before any process starts;
  - four altered receipts;
  - delivery's upload waiting for the receipt;
  - the production entries refusing.
- **Not done.** No real `ssh` ran, not even to localhost. A recorded check
  here comes from fixtures and is not live acceptance, trust or readiness.
- **Status (later the same day).** A pinned host key in
  `environment.guestAccounts` (and the per-conversation list) now carries
  `firstConnection`, separate from the pin and from readiness.
  - **Closed admission.** While transport admission is closed, as in this
    build, the stage is `admissionClosed` and nothing past that check is
    read. A planted receipt changes nothing.
  - **Open admission (test seam only).** Status reads a snapshot of the
    journal (no lock, repair or rewrite) for the one current environment
    bound to this bootstrap. It then requires all of:
    - the existing binding and retained-ledger checks;
    - the transport's trusted host key equal to the recorded pin;
    - the canonical `recorded` receipt;
    - the receipt's key digest equal to the reference's retained public key,
      read from its record without opening the private key.
  - **Stages.** The result is one of `awaitingTransport`, `notVerified`,
    `verified` or `invalid` (with detail).
  - **`sshVerified`.** Only `verified` sets `hostKey.sshVerified`; a pin
    alone never does. `ready` stays false everywhere.
  - **No effects.** Status never runs SSH or the key verifier, opens a
    private key, writes, fences or starts anything.
  - **Panel.** It keeps the pin, the first connection and readiness apart.
    With admission closed it says SSH to this VM is not enabled in this
    build.

### Personalized environment record

**2026-10-31 (source and fixtures only).** The trace found no production
code that turned a pinned bootstrap into the Local VM environment its
transport needs; only tests built that environment. Delivery, the first
connection and every guest RPC need one.

- **Where each field comes from.** `macos_environment.rs` builds the
  environment only from records the host already verifies:

  | Field | Verified source |
  | --- | --- |
  | VM, environment id and generation | The original completed restore (`macos_provision::created_for_bootstrap`), whose endpoint pin is re-verified |
  | Sandbox | That pin's recorded `local:terminalx-<key>` (new read-only `macos_endpoint::pinned_sandbox`) |
  | Account and home | The ledger's account receipt (`retained`) |
  | Host key and trust | The ledger's trust receipt, which must equal the recorded pin in `host-key-confirmation.json` (key, fingerprint, observation digest, key reference, account) |
  | Per-VM key | The produced original reference, accepted only through `retained_public` (version-3 binding for this bootstrap, VM and account) |
  | Runtime | An `ApprovedRuntime` |

  The request supplies only the display name. The binding then passes
  `check_retained` and `macos_transport::binding`.
- **Recording.**
  - The environment is recorded once.
  - An identical retry returns the original record.
  - A different name or runtime, a deleted record, another environment with
    the same sandbox, or another claim on the bootstrap is refused, never
    replaced or recreated.
  - Stale evidence (a changed VM, pin, trust or key) is refused even on an
    identical retry.
- **Route and gates.** The route is `environment.bindPersonalizedTransport`
  (`confirm: true`, onboarding-gated). It refuses at `require_available()`,
  and then at `ApprovedRuntime::production()`, before reading or writing
  anything.
- **Dependency: approved runtime.** The profile names the runtime as "the
  signed runtime bundled with this TerminalX owner", and the guest checks it
  against its own executable's SHA-256 (`bootstrap::owner_runtime_sha256`).
  Nothing in source pins the TerminalX release signing identity or a runtime
  catalog entry. Taking the running executable's digest would bind a local
  development build. So no approved runtime exists in this build. That
  depends on the held signing and distribution work, not on either consent
  decision (both answered 2026-10-31).
- **Tests.**
  - **Native, against the compiled owner, after the real version-3 key,
    grant and pin:**
    - nothing is bound before the pin;
    - the exact binding is recorded once, and an identical retry returns it;
    - a conflicting name or runtime, a malformed digest and a deleted record
      are refused;
    - another pinned key, observation, key reference or account, a missing
      pin record, a forged key binding, another environment holding the
      sandbox, and a changed VM are refused, and nothing is recorded or
      replaced.
  - **Unit:** the production entry refuses before reading anything.
- **No real records.** No environment was created on the running
  installation.

### Guest helper executable

**2026-10-31.** `terminalx-vm-bootstrap` (`native/vm-bootstrap`, run loop
`src/helper.rs`, entry point `src/bin/helper.rs`) composes the pieces above.
launchd would start it as root from `com.terminalx.next.vm-bootstrap.plist`,
which has the validation plist's key set. A test checks its label and program
against the helper and the seeder's production profile.

- **Seed.** It reads `enrollment.json` once from
  `/private/var/db/com.terminalx.next.vm-bootstrap/`. The directory and the
  file must be root-owned and private, and the file must be one bounded link.
  Otherwise it refuses before waiting or connecting.
- **Order.** It enrolls only after Setup Assistant has finished
  (`.AppleSetupDone`) and a personal account exists, then reports the accounts
  at once. The implemented owner reads that report within its 3 s frame bound
  of the acceptance, and the first acceptance claims the VM's only
  enrollment. Enrolling earlier would spend the session before there is
  anything to report, so in practice stage 5 follows stage 6.
- **Attempts.** Connection tries are bounded per launch (every 10 s for 15
  minutes) and journal nothing.
  - Each enrollment attempt is journaled before it starts, at most three per
    seed across launches.
  - An acceptance is journaled as `enrolled.json`. Later launches then exit
    without connecting, because the owner admits nothing more.
- **Conversation.** `helper::converse` reports the accounts. It then waits for
  the relayed confirmation and answers `accountConfirmed` or
  `accountRefused`. Next it takes the key grant, which the forking account
  child installs. Only after `publicKeyInstalled` does it report the existing
  public host key, and then it waits for the owner's acknowledgement
  ([helper retirement](#helper-retirement)).
  - Each step waits up to the owner's own 6 h.
  - The stages reached are journaled in `session-result.json`, with no key
    material.
- **Exit.** It exits 0 on every path, so `KeepAlive {SuccessfulExit: false}`
  never turns a refusal into a restart loop. `RunAtLoad` starts it again at
  the next boot.
- **Defect fixed.** The forking installer handed the dropped account child a
  path under the root-only state directory. The account cannot traverse that
  directory, so every real install would have been refused. The root parent
  now opens the account's journal, and the child uses that descriptor. A
  fixture installs through it with the state directory closed to every path.
- **Tests.** In-crate fixtures play a conforming owner over socket pairs.
  They cover:
  - refusing a non-private state directory or seed before any connection;
  - waiting for Setup Assistant;
  - the one enrollment and its journal;
  - an install refused by the real, unprivileged forking installer;
  - the host-key report after an install;
  - bounded failed attempts and an unreachable host.

  The cross-language fixture's `confirm` mode now runs the same `converse`
  against the real Swift owner. The built binary, run unprivileged on this
  host, refuses at once without its state directory and exits 0.
- **Candidate build.** `node scripts/build-vm-bootstrap.mjs` from clean
  commit `c0b01b92` (rustc 1.97.1) produced:
  - `terminalx-vm-bootstrap`: 723,952 bytes, SHA-256
    `ad34558705c6af9c9b3d2c70068017d994989026b3c40ab1a0bbae43aa8082c2`, thin
    arm64, with only the linker's ad hoc signature and no team;
  - its plist: 477 bytes, SHA-256
    `17b2c2130e99bc15916636f97650fb329d7b102f660ea2b39f6aefb307301eed`.

  The same build also rebuilt the probe and seed tool with new digests,
  because the crate changed. The [run sheet](LOCAL-VM-HELPER-RUN-SHEET.md)
  keeps its reviewed `6aa26b4a` artifacts. Everything is retained under
  `~/.raccoon/task-coordination/pro114-pro117/passes/20261031-guest-helper/artifacts/`
  with `manifest.json`.
- **Not done.**
  - **Distribution:** the helper is not signed, catalog-pinned or seeded
    (held), and it has never run in a guest.
  - **Approval:** until 2026-10-31, every step past the account report
    waited on a person approval this build refused. They are now trusted
    host requests.
  - **Retirement:** added later the same day, see the next section.

### Helper retirement

**2026-10-31** (`f19d0cb5`). This is design stage 9, on both sides.

- **Owner acknowledgement.**
  - After journaling `host-key-observation.json`, the owner journals
    `retirement-acknowledgement.json` and sends one frame under the
    enrollment session:
    `{retire: {challengeSha256, hostKeySha256, observationSha256}}`.
  - That frame names the session's challenge, the digest of the helper's
    exact `{hostKey: …}` report and the digest of the committed observation.
  - Nothing is acknowledged without that final report: no acknowledgement
    follows a refused or unknown install, or a host key for another
    reference or of another type.
- **What the helper accepts.** An acknowledgement exists for the helper only
  from a frame tagged under its own verified session, at the next sequence
  number, naming its challenge and the digest of the report it sent. A
  missing, changed, extended, untagged or premature acknowledgement ends the
  session and removes nothing. Later launches then exit as already enrolled.
- **Recorded items.** Before connecting, the helper records the seed
  profile's plist, program and key.
  - Each parent is opened one component at a time without following links,
    and must be owned by root and writable by no one else. The key's parent
    must also be private.
  - Each item must be a single-link regular file owned by root, with its
    seeded mode.
  - Otherwise the helper refuses before any connection.
- **Removal.**
  - The helper journals `retirement-intent.json` exclusively, with the
    acknowledgement and the recorded identities.
  - It then requires every item and its parent to keep the recorded device,
    inode, mode, owner, size, mtime and ctime.
  - It removes the key, then the plist, then the program, each through its
    parent's descriptor with `unlinkat`. Each item is rechecked just before
    its removal, and confirmed absent after a directory `fsync`.
  - It journals `retirement.json` last, as one of:
    - `retired`: only when all three are confirmed gone;
    - `refused`: something changed, and nothing was removed;
    - `outcomeUnknown`: a removal failed; the record names what was removed.
- **Report.** The helper sends `{retirement: {acknowledgementSha256,
  stage}}`. The owner journals it as `retirement-report.json` with
  `helperReported: true` and `verified: false`, because the owner cannot see
  the guest's files. It refuses a report for any other acknowledgement or
  stage, or with any other shape.
- **Never repeated.** A later launch that finds `retirement.json` or a bare
  `retirement-intent.json` exits 0 without connecting. An interrupted
  retirement stays an inspection item: it is never resumed or repeated, and
  nothing is reseeded.
- **Nothing else is removed.** Only those three names are ever removed: not
  the state directory or its journals, the account journals, a neighbouring
  file or the host key.
- **Tests.**
  - **Rust fixtures:**
    - an exact acknowledgement leads to retirement and its report;
    - six missing, changed, untagged or premature acknowledgements;
    - six changed items: substituted, symlinked, hard-linked, rewritten,
      re-moded, or with a substituted directory;
    - a program replaced during the session;
    - interrupted and failed removals;
    - later launches.
  - **Real Swift owner with the reference helper:** the bound
    acknowledgement; none without the final report; refused reports.
  - **Real Swift owner with the real Rust helper:** the fixture's `retire`
    mode runs the production run loop over a disposable root owned by the
    caller. Only the three items go.
  - No item was removed from any real guest.
- **Candidate builds from clean commit `f19d0cb5`.**
  - The helper `terminalx-vm-bootstrap`: 765,616 bytes, SHA-256
    `4ed2448731f8f8798295c1f5676319f231269ad479828c796d240e02adf9901d`. It is
    thin arm64 with only the linker's ad hoc signature and no team. Its plist
    is unchanged (`17b2c213…`).
  - The restricted owner: built offline as `69933c32…` (patch `257f8022…`;
    [offline build](../integrations/lume-bootstrap/OFFLINE-BUILD.md)).
  - Retained under
    `~/.raccoon/task-coordination/pro114-pro117/passes/20261031-retirement/`.
- **Host view (2026-10-31, later).**
  - **Owner actions.** The owner serves two read-only actions, version 3
    only, each returning one record name: `retirementAcknowledgement`
    (`retirement-acknowledgement.json`) and `retirementReport`
    (`retirement-report.json`). There is no other path and no write.
  - **Host check, acknowledgement.** The host accepts the acknowledgement only
    as exactly the record the owner would write for:
    - this binding and epoch;
    - the challenge of the enrollment receipt it reads;
    - the digest of `{hostKey: {keyReference, publicKey}}` rebuilt from the
      observation it reads;
    - that observation's digest;
    - the acknowledgement digest;
    - trust and readiness false.
  - **Host check, report.** It accepts the report only for that
    acknowledgement, with one of the three stages, `helperReported: true`,
    and `verified`, trust and readiness all false.
  - **Status.** `environment.guestAccounts` (and the per-conversation list)
    adds `retirement` once the owner has observed the host key. It is one of:
    - `awaitingAcknowledgement`: no acknowledgement could be read. This covers
      both an owner that has not written one and an owner that cannot be
      reached; neither is presented as absence.
    - `acknowledged`: a valid acknowledgement, with no report read.
    - `helperReported`, with `reportedOutcome` `retired`, `refused` or
      `outcomeUnknown`.
    - `invalidAcknowledgement` or `invalidReport`: a record was read but does
      not match, and it never counts.
  - **Always false.** Every value carries `verified`, `trustAccepted` and
    `ready` as false. Reading writes nothing, never retries or removes
    anything, and never starts an owner or VM: it only connects to a running
    owner's socket.
  - **UI.** The Local VM confirmation panel shows one short line for each
    state. A reported outcome always says TerminalX cannot verify it inside
    the VM, and a mismatched record is an alert.
  - **Commit and build.** `17011ad4`. The restricted owner was rebuilt
    offline as `3682708e…` (patch `ef880012…`). The helper is unchanged, so
    `4ed24487…` stands. Evidence is under
    `~/.raccoon/task-coordination/pro114-pro117/passes/20261031-retirement-status/`.
- **Still open.**
  - A reported retirement is the helper's claim, not host-verified evidence.
  - Removing the seeded files in a real guest needs the held seeding,
    signing and live steps.

## Host requests and the guest boundary

### Decisions (answered 2026-10-31)

The user answered both open choices:

1. **Consent mechanism: "No."** The proposed Touch ID, login-password or
   Secure Enclave approval is rejected. No other per-operation human-presence
   approval replaces it, and neither desktop-only consent nor a platform-wide
   agent isolation redesign was selected.
2. **Existing onboarding: "No."** `configure`, `environment.create` and
   `environment.setupAction` stay available.

The user then said: "Agent running on my host reaching to VM is not an
issue." An agent on the host controlling a VM is intended, trusted-host
behavior. What matters is the guest's reach into the host.

### What changed in source

- **Trusted host requests.** `environment.confirmGuestAccount`,
  `environment.grantGuestKey` and `environment.confirmGuestHostKey` no longer
  require a person approval. The person, or an agent in the bootstrap's
  original parent conversation, may send them.
  - `person_approval.rs` is removed, with its test-only approver.
  - Status no longer reports `personApproval`, and the UI no longer locks the
    steps.
  - A record says what was requested and from which conversation. It never
    says a person approved.
- **Kept.**
  - The onboarding capability, `confirm: true` and the original parent
    session, tab and conversation.
  - The exact owner-verified observation digest and fingerprint, and the
    account planned at Create.
  - The one original per-VM key; caller-supplied keys and references are
    refused.
  - Exclusive once-only records: an identical retry returns the same record,
    and anything else is refused and never re-chosen or replaced.
  - The owner channel's MACs and sequence numbers.
  - Every production gate: `Artifact::production()`, `require_available()`
    and `ApprovedRuntime::production()`.
- **Host SSH agent.** `cua` and `lume` child processes no longer inherit
  `SSH_AUTH_SOCK` (the legacy SSH row below).

### Steps that stay human-only

These are human-only for reasons other than excluding host agents:

| Step | Why | Source |
| --- | --- | --- |
| Setup Assistant and the guest's first account | The person creates the account and its password in the guest. The helper never drives Setup Assistant. | [Account confirmation and effects](#account-confirmation-and-effects); validation F5 |
| Remote Login in the guest | A macOS setting inside the guest. TerminalX never turns it on or creates host keys. | Same section; the UI's `awaitingHostKey` text |
| Guest permission prompts and provider sign-in | macOS privacy prompts and the provider's own sign-in, inside the guest | Validation F5; setup action descriptions |
| Seed daemon approval | macOS keeps a registered daemon in `RequiresApproval` until the person enables it in System Settings. TerminalX never approves. | Validation H3 and F4 |
| Disabling the helper in Login Items | The person's control. TerminalX never re-enables it. | [Retirement and person control](#retirement-and-person-control) |
| Held live and packaging steps | The restore-image download, signing, the coordinated runs and acceptance each need their own approval | [Validation plan](LOCAL-VM-HELPER-VALIDATION-PLAN.md#draft-approval-scope-for-a-future-coordinated-run) |

### Guest-to-host boundary (source review, 2026-10-31)

What a process in the guest, including guest root, can reach on the host.
"Tests" names the evidence in source. Nothing here was run against a live VM.

| Channel | The guest can | The guest cannot | Tests | Not verified or open |
| --- | --- | --- | --- | --- |
| Task replies (`task.*`) | Return at most 32 MiB of JSON per call (`process::run`) and append its own events | Change the task, VM, generation, input or transport identity: the supervisor compares each reply with the host's record, and the personalized route rechecks request and response (`validate_route`, `validate_response`) | `transport.rs`, `macos_transport_tests.rs` | — |
| Artifact import (automatic on poll) | Have the host keep at most 128 artifacts and 256 MiB per task, each checked for size and SHA-256, under `local-vm/artifacts/<task>/<uuid>` | Choose a host path (ids must be UUIDs in the host's directory); exceed the budget, which a ledger counts across polls, retries, omissions, restarts and concurrent polls before fetching; change an imported artifact; send duplicate or malformed declarations | `artifact_import.rs` tests (since the artifact-limit checkpoint) | — |
| Patch import (`task.applyPatch`) | Supply patch bytes | Apply them: only a host request with `confirm` and a host-chosen repository root applies one, after `git apply --check --index`, once per receipt. A patch cannot write outside the work tree, into `.git` (any case) or through a symlink. | `real_git_patch_import_preserves_dirty_host_work`; `real_guest_patch_cannot_leave_the_checkout_reach_git_metadata_or_follow_a_symlink` (new) | The patch is code the guest wrote. Review it before running anything from that checkout. |
| Inputs sent to the guest | Read the files the host selected | Read other host files: at most 64 files and 10 MiB, canonicalized inside the chosen root, credential paths refused, bytes pinned to the approved hashes | `real_files_require_approved_bytes_and_reject_symlink_escape` | — |
| Host credentials and tokens | — | Receive the host control token, socket, hook tokens or Cua daemon tokens (`process::remove_control_credentials`). On the personalized path, any inherited variable (`env_clear`). | `process.rs`; the transport, delivery, first-connection and owner fixtures assert no `SSH_AUTH_SOCK`, `TERMINALX_NEXT_TOKEN`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Provider sign-in happens inside the guest; nothing is imported |
| SSH, personalized path | Answer as the pinned host key | Use any forwarding: `-F none`, `IdentityAgent=none`, `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes`, `ProxyCommand=none`, `ControlMaster=no`, `PermitLocalCommand=no`, `StrictHostKeyChecking=yes` against one pinned line | `ssh_plan_pins_guest_host_key_account_and_target_without_inherited_authentication` | Admission is closed; never run live |
| SSH, legacy path (pinned Cua 0.7.0, Lume 0.6.1) | Run as the guest account through the guest's `cua-spacesd` | Reach Lume's SSH through any TerminalX command. **Source protection** (`legacy_route`): every legacy Cua command runs `--embedded`, so no running cua daemon of another build takes it. `sb exec`, `sb cp` and `sb create` run only with TerminalX's prepared, digest- and signature-checked Cua and Lume. `sb exec` must stream (`-i`). `sb create` carries no `--env` and refuses a VM name for which Cua kept an `env-applied` marker. Any other Cua command is refused, and the host SSH agent socket is removed. | `legacy_route.rs` (6 tests, including refusal through `host::cua` before dispatch); `guest_session_tools_never_inherit_the_host_ssh_agent` | **Installed dependency behavior**, from the pinned source (`cua-sdk-v0.7.0`, retained under `passes/20261031-legacy-route/`): with `-i`, `sb exec` never takes its `lume ssh` path; `sb cp` uses `cua-spacesd`; a create runs `lume ssh` only with an environment or that marker. That the pinned release was built from this tag is assumed. The ssh_config is not read at all, because this route never starts `ssh`. Not verified live: B3 must show no `lume ssh` or `/usr/bin/ssh` process during these commands. Cua commands run outside TerminalX are not covered. A host process writing the marker between the check and the create is a host-only race. TerminalX's Lume candidate also fixes the fallback options (`TerminalXSSHPolicy`, patch `019f29dc…`) if it is adopted, which stays held. |
| Computer and MCP endpoints | Serve its own Driver tools to the host's attachment adapter, which carries back data | Reach the host desktop: the guest worker gets only guest native and browser tools (`desktop.rs`); provider MCP names only `local-vm-computer --stdio --task <bound target>`; no host Unix socket is forwarded or shared | `provider_mcp_configs_only_name_the_bound_guest_proxy` | — |
| Shares | Nothing on a version-3 VM, which has no host share since the share-free checkpoint. Versions 1 and 2, which have no production route, keep `bo/<key>/input` (read-only) and `bo/<key>/receipt` | Have a share at all on version 3: no input or receipt directory is created, bound or passed to Lume, and the owner refuses a version-3 run or VM with any share, or a binding that still names one. Read the enrollment key or `control.capability` (never in a share). Personalized Create passes no share. | Native: `native_seeded_launch_binds_version_3_and_accepts_only_exact_helper_enrollment`, `native_a_version_3_owner_refuses_a_mounted_share_and_a_binding_that_still_names_one`; Swift protocol suite; plan tests | VirtioFS confinement for versions 1 and 2 is Apple's and untested here. What `cua sb create` shares on the legacy path is not verified. |
| Network | Use NAT egress, and reach host services listening on all interfaces, as a LAN peer would: TerminalX's nearby pairing listener on `0.0.0.0:6768` (`pairing/direct.rs`) and anything else the user runs that way | Reach host loopback services: TerminalX's local listeners bind `127.0.0.1`, as does Lume's API at the pinned commit (`127.0.0.1:7777`) | — | Live vmnet reachability and the user's other listeners are not verified |
| Restricted Lume owner | Reach its vsock listener for this exact VM and, with the seeded key, deliver only the allowlisted records (enrollment, account observation, key result, host-key observation, retirement), each MAC'd | Promote trust: every record keeps `trustAccepted` and `ready` false and the host revalidates it. No display, VNC or clipboard is enabled. | Swift protocol suite; native owner tests | Never run against a real VM (G5) |
| Seed daemon (planned, held) | — | Reach it: it writes three items to an unbooted guest volume before first boot, and accepts requests only from the signed TerminalX app (H4) | Seeder-core fixtures on disposable images | Not implemented (slice 5) |
| Guest text read by host agents | Put any text in transcripts, outcomes, artifacts and screenshots | Act on the host by itself | — | A host agent that follows instructions written by the guest acts with its own host authority. Treat guest output as untrusted input. |
| Hypervisor escape | — | — | — | Not assessed. Virtualization.framework isolation is assumed, not tested. |

**Answer to "the VM cannot do sensitive things to the host, right?"** By
source review, within its own channels the guest cannot do any of these:

- read host files beyond what the host sends;
- obtain host tokens, or the host SSH agent through the environment;
- reach the host desktop or loopback services;
- write anywhere on the host except its task's bounded artifact store;
- change a host checkout without a host request.

Four limits remain:

- **Disk use.** Artifact import is bounded per task (128 artifacts, 256 MiB),
  and each new task adds its own budget.
- **Network.** It can reach host services listening on all interfaces, as any
  LAN peer can.
- **Legacy SSH fallback, live.** TerminalX's legacy commands are held to
  routes that the pinned Cua source shows never start `lume ssh`, so the
  user's ssh_config is never applied to them. That rests on the pinned
  release's source and is not yet observed live (B3). Cua commands run outside
  TerminalX keep Cua's own behavior.
- **Guest-written content.** Patches and text it writes reach the host as
  data. Host agents and people must review that data before acting on it.

None of this has been checked live, and no claim is made about hypervisor
escape.

## Person approval for person-only actions

**Superseded on 2026-10-31.** The user rejected this design and confirmed
that host agents may control VMs
([decisions](#decisions-answered-2026-10-31)). The approval contract below was
implemented and then removed the same day. This section is kept as the record
of what was proposed and why.

### What the source shows (2026-10-31)

Who can reach what today:

| Path | Who can use it | Evidence |
| --- | --- | --- |
| Owner `local_vm.request` → `host::request` | Any holder of the runtime control token. App-launched tabs get it as `TERMINALX_NEXT_TOKEN`; the desktop client reads the same `run/control.token`. The onboarding check is client-side only. | `control.rs` `execute`, `local_runtime/sessions.rs` `local_vm`, `session.rs` tab environment |
| `runtime.attach`, then `runtime.window.register` | Any token holder gets a lease. A window registration is exclusive only while one is valid, so when no desktop is attached an agent can register its own socket in the run directory. | `local_runtime.rs` `command`, `local_runtime/window.rs` `register` |
| Restricted Lume owner channel | Anyone who can read `bo/<key>/control.capability`, a 0600 file owned by the user, which includes any same-user agent. The owner relays a confirmation or grant MAC'd with it. | `macos_owner_launch.rs`, `TerminalXBootstrapOwner.swift` |
| Desktop issue question (`issue_control::Ask`) | Creating a question: any token holder, which is acceptable because agents may request. Reading and answering: only the `main` webview, through in-process IPC (`issue_confirmation_pending`/`_reply`). One question at a time, a 40 s TTL, a one-shot answer, late or stale answers ignored, back-off after refusal. | `issue_confirmation.rs`, `cloud_control.rs` |
| Click guard while a question is shown | Pauses only TerminalX's own `computer.*` actions, not other same-user Accessibility automation. | `computer/mod.rs` `call` |

The existing question cannot carry Local VM consent:

1. Its result is a boolean in the desktop's memory. Local VM effects run in
   the persistent owner and in the restricted Lume owner, and neither can
   verify it. Relaying it through the token channel or the registered window
   can be impersonated.
2. The restricted owner trusts a file capability that agents can read. A
   host-only gate cannot stop an agent that talks to that owner directly.

### Missing primitive

A verifiable, one-time approval with these properties:

- Its proof needs physical presence through an OS-protected prompt.
- The same-user agent can neither produce nor read it.
- The host owner verifies it before any effect, and the restricted Lume owner
  verifies it before relaying, so the file capability alone no longer
  suffices.

**Proposed candidate (consent option A below).** It is a design proposal,
neither implemented nor proven:

- a Secure Enclave P-256 key with `userPresence` access control (Touch ID or
  the login password);
- usable only by the Developer ID–signed TerminalX app, through a keychain
  access group;
- signing the canonical approval document below;
- its public key pinned in the version-3 binding at Create, with P-256
  verification added to the restricted Lume owner.

It needs verification on the platform before anything relies on it:

- that the key can be limited to the signed app this way, and which
  entitlement and provisioning that takes;
- that same-user Accessibility automation cannot satisfy the system prompt;
- that the restricted owner can verify the signature.

Developer ID signing and the entitlement are separately held.

### Consent options

These letters are separate from the delivery decision's Option A, the bundled
seed daemon, above. The columns give each design's expected effect, not
verified results.

| Option | Closes the token, CLI and raw-request paths | Closes the file capability | Closes Accessibility clicks | Needs |
| --- | --- | --- | --- | --- |
| **A. Secure Enclave user-presence approval (proposed, recommended)** | Yes | Yes, once the restricted owner verifies | Expected, to be verified: the system prompt needs presence, not a click | Platform verification; Developer ID signing and a keychain-access-group entitlement (held); P-256 verification in the restricted owner |
| B. Desktop question plus executing in the desktop | Yes | No, unless the owner capability leaves disk, which breaks reopen after a restart | No | Moving effects into the desktop process |
| C. Isolating agent tabs: a separate macOS user or sandbox, a scoped tab token, no Accessibility | Yes | Yes | Yes | A platform-wide change to how tabs run |

Proposed recommendation, pending the user's choice and the platform
verification: consent option A, with C's scoped tab token later as defense
in depth. Nothing of consent option A is implemented.

### Approval contract (implemented, then removed on 2026-10-31)

- **Document.** Canonical JSON with exactly these fields: `version` 1,
  `approvalId` (UUID), `action`, `bootstrapId`, `inputsSha256`,
  `parentSession`, `parentTab`, `parentConversation`, `issuedAt` and
  `expiresAt` (Unix milliseconds, at most 120 s apart). The proof is the
  approver's verification over the exact bytes.
- **Inputs.** The host computes them from current owner-verified evidence;
  the caller supplies none.

  | Action | Inputs (each also includes `bootstrapId`, `bindingDigest`, `ownerEpoch` and the original parent) |
  | --- | --- |
  | `environment.confirmGuestAccount` | the account-observation digest and the full chosen account |
  | `environment.grantGuestKey` | the acknowledged answer digest, the account's name and uid, and the planned key reference |
  | `environment.confirmGuestHostKey` | the host-key observation digest, the fingerprint, the key reference, and the account |

- **One use.** `approval-<id>.json` is recorded exclusively before any
  effect.
  - **Lost reply or interrupted action:** retrying the identical approval
    within its lifetime proceeds. Every underlying action is idempotent, so
    the result is the same record.
  - **Replay:** another action or other inputs under a used id is refused.
  - **Cancellation:** `cancelled` recorded first makes the approval
    unusable.
  - **Expiry:** checked on every use; after it, a new approval is needed.
  - **Replacement:** a new approval for the same inputs is allowed, and the
    effect is still single. One for other inputs reaches the action's own
    refusal, which never re-chooses.
- **Who can issue and consume.** Only the chosen primitive can issue. The
  host consumes inside the owner, at the action itself
  (`Reference::confirm_account`, `grant_guest_key_using`,
  `confirm_host_key` each take a verified approval). The shared token cannot
  issue, because an approval is a proof over the document, not a request
  field. The restricted Lume owner does not verify approvals yet.
- **This build.** The approver is `Unavailable`, so the three version-3
  person-only actions fail closed before any effect, whatever the caller
  sends. `environment.guestAccounts` and `guestAccountConfirmations` stay
  read-only and report `personApproval: {available: false}`, and the UI
  keeps the observed accounts, key and host-key state visible with the
  actions disabled and the reason shown.
  - Fixtures exercise the contract only with a test-only HMAC approver. No
    person's approval was given, tested or achieved.
  - Because the restricted owner does not verify approvals, a same-user
    process that reads `control.capability` could still ask a running
    version-3 owner to relay a confirmation or grant. Only owner-side
    verification closes that path.
  - Release builds launch no version-3 owner, because
    `Artifact::production()` refuses.
- **Not changed.** `environment.create` and `environment.setupAction`, the
  existing shipped onboarding consent for compatible VMs, have the same
  token-level weakness. Closing them now would disable that onboarding, so
  they stay as they are pending the decision. So does `configure`, the
  Settings opt-in toggle, which is also reachable with the token.
  `environment.createPersonalized` is already closed by `require_available()`.

### Decision required (answered 2026-10-31)

The two choices this section asked for were:

1. **The consent mechanism** (the consent options above).
2. **Existing onboarding consent.** Whether `configure`,
   `environment.create` and `environment.setupAction` should also fail closed
   until that mechanism exists.

The user answered "No" to both. Consent option A was not adopted, and the
existing onboarding stays available
([decisions](#decisions-answered-2026-10-31)). No acceptance run counts any
of these steps as a person's consent, because none records one.

## Account confirmation and effects

- The helper waits for the person to finish Setup Assistant. It never drives
  Setup Assistant or creates accounts.
- It observes local accounts with UID ≥ 501 through the existing `getpwuid_r`
  lookup (no password fields), plus home device/inode and the OS version/build,
  and reports them over the authenticated session.
- The host matches a candidate to the stage-1 intent. The parent session's UI
  offers that exact account; the person or an agent in that conversation
  confirms it as a trusted host request
  ([host requests](#host-requests-and-the-guest-boundary)). The click, its
  checkbox and the parent IDs are not recorded as anyone's approval.
- Only after the host records that confirmation does it send the confirmed
  intent over the session. The helper forks a
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
reseeded. Implemented in source on 2026-10-31; the acknowledgement contract
and the checks are under [helper retirement](#helper-retirement). The person
can disable the item in System Settings > General > Login Items at any time. Apple's `statusForLegacyURL` exists so apps "still want to
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
   It is compiled in the offline build (validation plan P6) but has never run
   against a real VM.
6. Disabling the item in Login Items prevents the launch, and the person sees
   the helper attributed to its signing team.

## Source slices after the decision

Status as of 2026-10-31. "Implemented" means source and fixtures, never a
signed, installed or live-accepted artifact.

1. Seeder core with descriptor-relative writes and readback, tested against
   disposable APFS images. Non-root fixtures cover layout, no-follow and
   pristine checks; root ownership needs the acceptance run. Implemented in
   `native/vm-bootstrap` (`seed.rs`, `disk.rs`) and fixture-tested on
   disposable APFS images (`6aa26b4a`). The Run 1 tool `terminalx-vm-seed`
   uses it, built ad hoc signed (`29bde7fd…`). Root ownership remains.
2. Version-2 enrollment in the Swift owner and the Rust helper, with
   cross-language socketpair fixtures for proof, refusal budget, replay and
   tampered frames. Implemented (wire form above, `08d126b3`). The listener
   switch is done too: the version-3 owner listener runs it (`373deb08`).
3. An authenticated `Channel` constructor fed by the session, replacing
   `acquire_authenticated()`, plus the privilege-dropping account child.
   - **Account child:** implemented (`ecf5fc79`, `3c1018a6`, `76cbf4d6`),
     with the account confirmation, key grant and host-key report described
     above. The [guest helper executable](#guest-helper-executable) runs it,
     and its journal is now handed to the child as an open descriptor.
   - **`Channel` constructor:** not implemented, and no longer on the
     version-3 path. `acquire_authenticated()` keeps refusing
     (`macos_guest_channel.rs:286`), and no consent choice changes that.
     - Its only caller, `macos_bootstrap_helper::run`, belongs to the
       version-1 share design. That design passes manifests and receipts
       through mounted input and output shares, and runs a helper named
       `terminalx-bootstrap-helper` as the account. It has no route, and
       `mod.rs` keeps it as dead code.
     - A constructor would need the original shares acquired as verified
       mount descriptors. No supported interface provides that, and the
       version-3 design no longer uses shares: since the share-free checkpoint
       its launch binds, creates and mounts none.
     - Enrollment, account observation, key install and the host-key report
       now run over the session in the native helper.
4. Seed journal states in `macos_provision.rs` and the `run` precondition.
   Implemented: `macos_seed.rs` journals the seed beside the provisioning
   record (`db550455`), and only an exactly seeded guest launches a version-3
   owner (`e0cf678a`).
5. Option A packaging, reviewed separately. Not started; it stays held for
   its own review.

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
used for the 2026-10-29 proposal. Later implementation evidence is retained
under `~/.raccoon/task-coordination/pro114-pro117/passes/20261030-helper-impl/`
and the dated `20261031-*` directories beside it. Acceptance and PR readiness
remain false.
