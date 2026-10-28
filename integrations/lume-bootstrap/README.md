# Restricted Lume bootstrap candidate

Reviewable source candidate for PRO-114, based exactly on Cua/Lume commit
`3350f504014c85416009a90fcb339fe556ce02fc` (the retained 0.6.1 source baseline).
The user authorized this source direction on 2026-10-28. This is not an adopted
profile, installed executable, approved signed artifact or enabled product route.
The existing Lume pin and all production catalogs remain unchanged.

`bootstrap.patch` applies to that commit's repository root. It changes the run
path and adds the Swift sources in this directory. `upstream.json` records the
actual upstream file SHA256 values and candidate patch SHA256. `make_patch.py`
refuses any different base bytes and reproduces the patch; `verify.py` applies it
only to disposable copies. Upstream context is MIT-licensed; see
`UPSTREAM-LICENSE.md`.

## Implemented candidate behavior

The new candidate-only `--terminalx-bootstrap-fd` option takes an inherited Unix
stream descriptor, never a secret, URL, manifest pathname or attestation boolean.
It is not an option in the installed profile. The ordinary run path remains the
default when this option is absent.

Bootstrap mode requires macOS, explicit original storage/name, `display none`,
VNC disabled, exactly two pinned shares, and no clipboard, detach wrapper,
recovery, disk/NVRAM/network override, extra disk or USB attachment. It refuses
image references and implicit image pulls. It also:

* Suppresses the independent default-account SSH task, SSH clipboard startup,
  VNC credential share, VNC secret-bearing log path and native viewer attachment.
* Creates no VNC listener. The private `_VZVNCServer` address-binding guarantee is
  still unknown; a localhost URL or proxy would not establish it. Console access
  always reports unavailable, with no caller-selected TCP/WebSocket route.
* Refuses the upstream emergency config-lock cleanup after contention. It retains
  the original config lease, forbids dynamic shares and guest file-drop/clipboard
  actions, and avoids registering this run in the ordinary shared-VM routing table.
* Disables the hidden `.lume-live-share` placeholder and mounts only the original
  `input` read-only and `receipt` read-write directories. It never shares the
  operation directory containing the private control reference.
* Attaches the broker to the actual `DarwinVirtualizationService` VM handle. On
  that handle's queue, every request checks the same VM is running and inspects
  its runtime `VZVirtioFileSystemDevice`/`VZMultipleDirectoryShare`, including the
  actual mount names, URLs and read-only flags. Swapping the two mount names is
  refused even if the path/permission set is unchanged. Caller JSON cannot supply
  this observer.

The Apple runtime device interface is supported in the installed SDK and is
typechecked here; see [runtime directory sharing devices](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/directorysharingdevices)
and [shared directory URL/read-only properties](https://developer.apple.com/documentation/virtualization/vzshareddirectory).
No VM was instantiated to verify those APIs. The upstream source seams are
[Run](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Commands/Run.swift),
[VM lifecycle](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/VM/VM.swift),
and [sharing configuration](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Virtualization/VMVirtualizationService.swift).

## Original launch and reconnect contract

The candidate host launcher retains one original private
operation, exact artifact and VM/config/disk/NVRAM/share pins, parent
session/tab/conversation, bootstrap/generation/epoch/nonce, helper manifest digest
and a private 32-byte control capability. The reference is not a provider or SSH
credential and never enters guest shares, logs, argv or the environment. This
candidate supplies receiver, client and launch lifecycle behavior; production
catalog/acquisition is still unavailable. Tests provide synthetic capability bytes in
disposable directories, not a production credential generator.

The owner receives the canonical binding and capability through the inherited
socket. It verifies the peer UID and parent PID, checks its own executable bytes
against the retained digest, and validates original canonical paths, inodes,
ownership/modes and config bytes. This is an original private-launch contract,
not hardware attestation or protection against a compromised host account.
Signature/catalog approval must precede a future production launch.

`owner-intent.json` must already match the exact inherited binding. The owner
exclusively creates and syncs `owner-started.json` before any VM-start or socket
effect. A partial record, missing original intent or prior start is a refusal;
neither a different epoch nor a dead PID permits replacement. The same retained
files are checked on subsequent requests. Receipt content never authorizes an
account operation or VM restart.

After the actual VM starts and its shares are verified, the owner creates one
`0600` `owner.sock` beneath the original private operation directory. It returns
the socket inode/device and process identity over the inherited channel, MAC-bound
to the original binding and epoch. Existing sockets are never removed/replaced.
Closing the broker closes only its owned descriptor; its socket/start history
remains. It sends no signal and makes no claim that a different owner has exited.

Reconnect uses that retained socket identity, native peer credentials and fresh
mutual HMAC-SHA256 challenges. Separate domain tags bind owner authentication,
host authentication and the response to the original binding digest, epoch,
action, request ID, client nonce and fresh server nonce. Response authentication
also covers the exact payload digest. MAC comparison is constant-time. Socket
existence, PID, metadata, a stale response or a client-supplied `proof` is not
accepted in place of this exchange.

Frames are bounded to 256KiB, original binding/helper manifests to 32KiB and
receipt reads to 64KiB. The owner has absolute frame deadlines. These deadlines
only refuse a connection; they never release a VM, task, desktop or unknown owner.
The fixed operations are `observe`, `accountReceipt`, `keyReceipt` and
`guestObservation`. Version-2 account/key admission refuses until genuine helper
authentication is available. Receipt
names are fixed inside the original writable share. No request can choose a
filename, host endpoint, VM, share, account, input action or termination target.

## Original host launch lifecycle

`src-tauri/src/local_vm/macos_owner_launch.rs` is a child module of the existing
channel implementation and is wired into `environment.runPersonalizedProvision`.
Production selection refuses before reading a tool/reference path because the
restricted artifact catalog is unavailable. Neither UI parameters nor a local
file can supply an approved executable/signature or bypass this gate.

The actual source executor requires the completed original restore record and
retained endpoint/VM pin, plus the original personalization account plan. It
shares the original provisioning lock and retains an immutable launch intent in
that ledger. An ordinary legacy run refuses once that restricted launch intent
exists. Fixed private `bo/<bootstrap-id>` state holds the original reference and
two guest shares; the Unix socket path must fit the native bound, with no alternate
endpoint. Artifact selection binds the exact source commit, candidate patch,
executable digest and inode, and uses only the catalog-derived artifact path.

Before the only subprocess effect, it writes the original binding, expected
helper manifest, private control capability and preparation receipt, then a
durable spawn-attempt fence. The child receives a fixed argument list (`run`,
original VM/storage, display none, VNC disabled, the two exact shares and inherited
descriptor number), an empty-then-allowlisted environment and private empty HOME
and TMPDIR. Stdio is not inherited. Capability bytes never enter argv, environment,
shares or logs. Tests verify the actual child's observed argv/environment.

The child-handle identity is retained before capability delivery. A lost startup
announcement can reconnect only to that original child, with the original
operation/start history, native peer identity and a new mutual challenge. Socket
metadata merely locates the peer; it cannot authenticate the owner. Missing or
partial preparation, an uncertain spawn before the child receipt, changed
artifacts/account/parent/VM, or a dead owner remain fenced. No retry regenerates a
capability, spawns a second owner, clears a lock, signals a PID or promotes trust.
An owned-child waiter records exit through the retained original directory
descriptor; exit is historical evidence, never replacement authorization.

The internal version-2 writer now derives `owner-helper-plan.json` from host-only
intent, the original restore target and account plan. It persists epoch/nonce/share
IDs before effects and adds actual host share pins during preparation. No guest
mount inode, UID or OS-build observation is needed before launch. Existing v1
operations retain their exact original manifests/history. Production parent/human
approval and helper catalog acquisition remain gated; intent files are not proof.

The candidate adds a real VM-scoped VZ socket listener and a guest-side Darwin
vsock connector, with no arbitrary endpoint. Native cross-language fixtures test
framing, fresh challenges, original-intent journaling and a bounded share round
trip. A completed observation remains explicitly unauthenticated for account and
helper identity; the owner control channel can re-read it without guest replay.
The final executable helper manifest and `Channel::acquire` remain unavailable.
See [the verified transport contract and precise authentication gap](../../docs/LOCAL-VM-GUEST-CHANNEL.md).

## Host receipt admission

`src-tauri/src/local_vm/macos_owner_channel.rs` implements the native Rust client,
private reference reopening, launch authentication, fresh reconnect exchange and
durable candidate receipt admission. Its authenticated receipt type has no
deserializer or public proof constructor. Production acquisition refuses before
opening any channel or credential path.

Admission first retains a request intent under an exclusive original lock, then
reads through the authenticated owner. It retains even rejected authenticated
payloads, so a changed guest file cannot silently replace the original outcome.
Account observations must match the original typed helper manifest, exact account,
VM/generation/epoch/nonce/share/parent, OS and host public key. Public-key receipts
also require the retained account observation and original host-side public-key
intent. Unknown replies can re-read that original read-only operation; there is
no account/input/install replay. Missing locks/history and partial or conflicting
receipts remain fenced.

The result is `candidateReceiptAdmitted`, always `ready:false` and
`trustAccepted:false`. It is recorded in the candidate operation ledger, not the
production personalization trust ledger. The signed helper's real launch and
guest-side authenticated channel acquisition remain missing; the existing helper
`Channel::acquire` still refuses. A host-authenticated share read does not by
itself prove helper execution, guest mount identity or completion of onboarding.

## Verification and limits

With the exact upstream source already available locally:

```sh
python3 integrations/lume-bootstrap/verify.py --source /path/to/exact/libs/lume
```

This performs no network access or dependency resolution. It checks exact source
hashes, patch application/reproducibility and patched Swift syntax; typechecks
the new owner plus real Apple adapter using a narrow upstream-handle interface
stub; then compiles and runs the owner protocol against disposable native
process/filesystem fixtures. The fake VM observer exists only under
`TERMINALX_BOOTSTRAP_FIXTURES`; its binary never imports or instantiates a VM.
The interface stub is typecheck-only and is absent from the candidate patch.

The Rust tests additionally exercise typed helper receipt validation, recovery
history and refusal of forged local proofs. An explicit ignored test runs the
actual Rust client against the compiled Swift fixture and real helper-generated
synthetic filesystem receipts. It covers authenticated admission, reopening,
changed key intent, changed rejected receipt, and an absent owner without fallback.

The complete upstream Lume executable has **not** been built or run. Its package
dependency graph was not resolved or installed. Patch syntax and the focused
adapter typecheck do not replace that build or prove the whole run path at runtime.
No installed Lume, VM/container, account/key/SSH, provider, owner or viewer was
operated. Earlier prepared runtime/Dev artifacts remain unchanged.

Remaining gates are full upstream candidate build/signature review, production
artifact/catalog acquisition, authenticated guest helper preparation and seamless
background delivery/launch, genuine macOS26 restore provenance, and coordinated
live acceptance. Console stays unavailable until an actual supported background
console has a verified bind/ownership/input contract. Manual helper launch remains
acceptance scaffolding only. Linux/macOS choice and separate Attach desktop tools /
Run task in VM remain the working defaults. Acceptance and PR readiness stay false.

See [the offline build input audit and reproducible plan](OFFLINE-BUILD.md). The
retained partial source and standard caches do not contain the full exact source
and 18 locked dependency revisions, so no full build or resolver was attempted.
