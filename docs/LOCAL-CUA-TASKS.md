# Selected tasks in local macOS Cua guests (PRO-114)

This implementation is opt-in and is **not release validated**. A running
VM, passing unit tests, or the earlier unlocked UI pilot does not establish
the locked-host guarantee. Do not enable release claims or mark PRO-114 done
until the evidence matrix below is completed with real product sessions.

## Execution and retained identity

Settings → Environments enables Local Cua. Creating a guest is an explicit
operation after the allocation, download and storage disclosure. Enrollment
accepts only an existing `local:<name>` Lume macOS VM; it does not enroll the
host desktop or require a cloud organization/account.

The normal Create flow queues guided setup with one confirmed disclosure of
image/tool downloads, VM resources, retained storage and provider costs. The
persistent owner prepares pinned Cua/Lume tools in its private cache, verifies
archive/executable hashes and Developer ID signatures, and installs its matching
arm64 guest runtime automatically. There is no binary picker or guest shell
procedure. Existing compatible signed Driver and Codex installations are
retained, with their daemon, permissions, account configuration and credentials.
Automatic provider tool preparation currently supports Codex 0.156.1; other
retained harnesses remain subject to their reported compatibility limits.

Full environment/generation/provider binding, setup intent and keyed action
receipts live in the owner journal. Reopening Settings observes that history
without replaying creation, installers, sign-in or permissions. Interrupted
setup offers explicit review of the existing VM and retains prior uncertainty.
Saved UI requests reconcile against their exact keyed operation or retained
setup queue history even when a newer request is current. Environment,
generation, provider, action and request-key checks still apply. A canonical
unknown action cannot be cleared by an older success snapshot.
A missing response or dead helper never proves guest work stopped; unresolved
setup keeps idle auto-exit and deletion blocked. Explicit host shutdown can
leave an unready VM running only after fresh, bound guest inspection proves
task/history agreement and exit of every retained setup helper. Unknown action
receipts remain unknown, and shutdown does not mark setup Ready.

The runtime step checks the serving guest executable against the host owner,
not just whether it answers. A mismatch offers **Review guest update…** when
the same bound guest is idle. Confirmation queues the existing durable setup
path with the retained provider and all prior receipts. The installer checks
fresh guest quiescence before reloading the guest TerminalX service. It does
not restart the VM, Driver, sign-in or permissions. Reopening the UI observes
the saved request; an interrupted installer remains unknown until explicitly
reviewed, with no automatic retry.

Passive readiness uses version/status, attributed permission status, safe local
file-store authentication evidence, and console/display metadata. It never
launches Driver, captures pixels, refreshes credentials, discovers models or
sends a provider turn. Missing/stopped/version-mismatched Driver, unknown
permission attribution, unknown sign-in and unverified capture are distinct.
Existing keyring/automatic credential selection is preserved and stays unknown
when inspecting it might raise UI.

**Check existing Codex sign-in** explicitly asks the guest's owned app-server
for `account/read` with `refreshToken:false`, following the
[official account API](https://learn.chatgpt.com/docs/app-server#1-check-auth-state).
It never sends `account/login/start` or a provider turn. Credential-store consent
remains the person's. Only the local authenticated/missing result is retained;
account names, tokens and raw provider output are excluded. This evidence lasts
at most ten minutes and binds the environment/generation, kernel boot, selected
Codex executable, account configuration and credential-file metadata. Passive
refresh never reads the keychain. A newer failed/unknown check supersedes older
success; configuration changes, expiry or a changed boot require a new explicit
check. This local receipt does not prove network access or provider entitlement.
Configuration is parsed as a TOML document, including its tables; parsing a
single TOML value incorrectly rejects an otherwise valid retained account.
Owned setup helpers clear the inherited environment and search only the guest's
local tool directories and standard system/Homebrew paths. This lets retained
`env node` provider launchers find their guest interpreter without inheriting
host credentials or the host owner's search path.

Explicit actions own bounded guest children and checkpoint intent before
effects. Start computer control uses the public no-permissions-gate launch mode;
this suppresses setup prompts, not TCC. Review guest permissions uses the public
app-owned grant flow, including its disclosed direct-capture check. Only the
person answers macOS approvals or the guest-account password dialog. Codex
device authorization stays in one owned app-server process; its challenge lives
only in memory, never in journals/diagnostics. Cancellation binds that exact
live actor and a new key. Process loss never starts another sign-in.

Capture proof binds the current kernel boot and Driver executable. Capture alone
does not prove an unlocked usable app desktop. The explicit desktop check opens
a new private `.txt` document in guest TextEdit in the foreground, selects its unique exact window
and native editor, and types a nonce through Driver. It requires fresh native
readback, identical bytes saved by the application, and confirmation that the
same document closed before removing the file. Native Save/Close menu actions
use Driver's exact-window foreground verification inside the pinned English
guest profile; the existing file exposes File → Save, without an ellipsis.
All checks use the guest transport and its own desktop; they do not open or
focus the host viewer. Other windows and host
applications are never selected. A refusal, ambiguous target or missing readback
pauses setup without repeating input; an uncertain check document stays under
`~/.terminalx-local/setup-checks` for inspection. A running VM, generic reply or
PNG cannot make setup Ready. On 2026-10-27, pilot guest `128f5efc` completed
this native input/readback/save/close check through the background guest
transport, with no host viewer interaction. The existing guest account check
also passed without starting sign-in. The viewer was open; viewer-closed,
locked-host and fresh-onboarding acceptance remain open.

The conversation footer lets the user select a task prompt and specific
project-relative context files. It inherits the parent's provider harness,
model, effort and permission mode, and checks those against the guest's own
discovery. Regular, GitHub and Linear parent sessions retain their existing
execution target. Other composer submissions use their existing path.

Only the selected prompt and approved file bytes are transferred. The file
manifest contains relative paths, byte counts and SHA-256 hashes. The backend
rechecks canonical containment and content immediately before export. Inputs
are limited to 64 files / 10 MiB. No parent transcript, provider login,
keychain, SSH directory or browser profile is copied. The guest needs its own
provider and repository login; selected source files can themselves contain
private information and the user must review the selection.

A task target contains environment, generation, workspace and task UUIDs.
Guest paths use a qualified `local-cua:` representation in the UI; they are
rejected by host path guards. Every guest request validates its installed
identity and generation. A failed guest operation has no host fallback.

The host journal is in `$TERMINALX_HOME/local-vm`, separate from guest data.
It preserves parent session/tab/message links, approved input, provider choices,
worker/resume identities, contiguous events, results and artifact manifests.
Artifacts are integrity checked and copied into the host journal's artifact
store before completion releases the host's workflow lease. Guest deletion
keeps these records and historical usage events. Artifacts currently have no
automatic expiration (`expiresAt: null`); their retained copies remain until
the user explicitly removes that local history. Export them using the task
card before removing any history directory.

Returned patches require explicit selection of a host repository root.
`git apply --check --index` must pass before application; dirty or divergent
host files are preserved when the check fails. Successful import updates both
the worktree and index. There is no silent overwrite or automatic merge.

## Lifetime, transport and computer control

The host VM controller runs inside the persistent local `terminalx-serve`
owner described in [LOCAL-RUNTIME.md](LOCAL-RUNTIME.md). The desktop uses the
same pinned authenticated client; a disconnected or older owner cannot fall
back to a second manager or replay a pending mutation. The owner advertises a
separate Local VM protocol capability. An older running owner is left running
and reports this feature unavailable until the user deliberately updates and
reconnects after resolving its work.

Only VM-specific work remains in the task supervisor: durable provisioning,
queue dispatch, guest polling, artifact retention and an optional scoped
`caffeinate -i` assertion. There is no second host LaunchAgent or private copy
of the desktop executable. Unfinished tasks, permission waits, unknown outcomes,
manual holds and unresolved provisioning keep the host owner busy after window
closure. Missing/corrupt initialized history and unrecognized provisioning
states fail closed. Idle system sleep is prevented only for work whose
environment explicitly opted in; display sleep and locking remain available.

Normal quit detaches the desktop. Both owner socket and unattached tray stop
use the same admission fence. Stop all and quit refuses while VM effects are
in flight or unresolved guest work/manual control/provisioning remains, before
revoking attachments or claiming any worker stopped. An idle setup that needs
attention (for example, an expired account check or different runtime version)
does not permanently prevent an explicit owner update. Shutdown checks fresh
guest task histories, all retained setup operation identities, helper exit
evidence, and an unchanged host journal under exclusive VM admission. An
unreachable guest, missing receipt or unproven helper exit still refuses it.
Resolve unfinished tasks and return manual control first; Stop VM remains a separate explicit environment
action. Stopping a host Cua client proves no guest cancellation. Provisioning
cancellation before dispatch or after an uncertain restart can still require
explicit inspection/reconciliation; a cancellation request is not a completed
cleanup guarantee.

A supervisor from a pre-cutover development build may still hold
`$TERMINALX_HOME/local-vm/supervisor.lock`. The new owner refuses duplicate
polling and does not unload the old job or reset its journal. Deliberate migration
must stop that exact old `com.terminalx.local-vm.<data-directory-hash>` LaunchAgent
after inspecting its data directory and work. No migration is performed by this
change. Disabling Local Cua leaves history intact and does not stop a VM.

A guest LaunchAgent runs the macOS arm64 `terminalx-serve` with
`TERMINALX_HOME=/Users/lume/.terminalx-local/runtime`. Provider processes, PTYs,
transcripts, permission waits and result collection belong to that runtime.
The existing headless runtime is reused; Linux binaries cannot substitute for
this build. The release workflow includes a macOS arm64 runtime artifact,
architecture check, self-test and checksum inventory.
Replacing an already quiescent guest runtime waits up to ten seconds for its
old LaunchAgent to disappear after `bootout`, then submits `bootstrap` once.
Acknowledgement of `bootout` alone does not prove service removal. A timeout
retains an unknown setup result without force-killing or replaying activation.

Control uses the pinned Cua CLI's authenticated guest execution
transport, forwarding bounded JSON over stdin to a guest helper. The helper
reads only its guest runtime's owner-only control socket/token. Host control
credentials are removed from child environments. No new unauthenticated LAN
control/VNC endpoint or cloud relay is introduced by this adapter.

The guest's provider MCP configuration contains the task-bound computer
proxy. It runs **inside the guest** and forwards a restricted native tool set
to its signed guest Cua Driver. It has no VM/fleet selector or host
desktop endpoint. Every call checks the full-workflow desktop lease. The lease
is held through human waits, cancellation and unknown outcomes; a timeout does
not let another task steal it. Multiple tasks queue in one guest. Separate VMs
provide actual account/files/desktop isolation.

Open desktop uses the separately installed Lume native viewer with VNC fallback,
not Cua's HTML5 codec path. This is not the shared embedded Desktop planned for
PRO-117. The viewer is interactive: choose Take over desktop to stop the task
and confirm its terminal status and durable manual desktop hold before manual
interaction. That hold pauses queued workflows across viewer closure and
runtime restart. Return control to queued tasks explicitly releases it; this
does not resume the canceled task. Closing the viewer does not stop a worker
or release manual control. Stop task targets one worker; Stop VM affects all
of that environment's tasks.

## Delivery and failure semantics

The host persists an idempotency key and approved input before dispatch and a
dispatch marker before the first guest start request. Once dispatched, it only
polls/discovers the existing task; a lost acknowledgement or missing record
never causes an automatic prompt replay. The guest persists start and mutation
markers before effects. Ambiguous delivery is `outcomeUnknown`, not success.
An absent-task cancellation creates a durable guest tombstone that rejects a
late start request.

Guest events have contiguous task sequences independent of provider source
sequences. Polls resume after the retained cursor. Gaps, divergent duplicates,
a cursor ahead of the guest, changed identities and transcript rollback fail
closed. Interrupted tasks can be explicitly recovered with a new human
instruction only after a changed guest OS boot identity proves that the prior
worker cannot still be alive, and a retained provider resume identity is
available. The retained workspace, provider conversation and inherited model,
effort and permission settings must still match. A same-boot unknown outcome
fails closed until the guest is safely restarted. Recovery never resends the
original prompt or erases uncertainty about earlier external effects.

Recovery stores the exact new human instructions, full target and idempotency
key before sending. The UI also retains its retry request across reloads.
Neither an RPC response nor a running status acknowledges delivery. Only a
later same-target canonical event with payload
`{"type":"taskRecovered","idempotencyKey":"<recovery key>"}` clears the saved
UI request. The guest writes that event and the completed operation marker
atomically after the provider confirms input delivery. A failed checkpoint,
ambiguous receipt or runtime interruption emits no success event, and retrying
the same key never sends the text again.

Paged responses withhold terminal status/results until catchup is complete.
Snapshot rollback cannot safely be treated as a fresh execution; inspect and
reconcile it explicitly.

Provisioning is persisted before starting Cua. A supervisor interruption or
uncertain cancellation retains `outcomeUnknown` and does not recreate the VM.
Partial VM/image storage is retained for inspection and deliberate cleanup.
Settings → Environments → **Resolve interrupted provisioning** offers one
disposition: explicitly adopt the existing ready VM. Read-only preview and
confirmation independently probe the exact pinned local VM and installed guest
environment/generation, without provider, model or Driver readiness probes.
Confirmation compares a versioned canonical evidence digest under exclusive
owner admission, then atomically records `adopted` with the full original unknown
record and reviewed evidence. A lost reply returns that exact durable receipt.
Adoption establishes a current resource disposition; it does not claim that the
interrupted operation succeeded or verify provider/GUI readiness.
The pinned client requires the owner's separate reconciliation capability for
recovery preview/confirmation and deletion. An older owner keeps running and the
feature remains unavailable; the client never probes through its older generic
inspection path, restarts it, falls back, or retries a mutation.

This first flow requires **no retained host task history in any generation** and
no guest task/canceled-target history or manual hold. A new unused installation
checkpoints its no-execution timeline before task admission. Legacy history
cannot acquire that proof retrospectively: its initialization boot is retained
and a later different kernel boot is required to prove earlier orphan exit.
Missing initialized guest state fails closed. No action in this flow reboots,
starts, stops, recreates or deletes a VM. Missing, stopped, unbound or inadequately
proved guests remain unknown and keep deletion/owner-stop blocked; absent-VM and
task-bearing provisioning reconciliation require separate supported procedures.

Deletion requires a fresh guest-work/task/resume inspection and refuses
unfinished tasks or unresolved provisioning. It removes only the exact
enrolled VM identity and never a host checkout or unrelated VM.
An adoption receipt never authorizes deletion. Deletion independently checks
the generation, complete guest task/canceled-target manifest, manual hold,
owned groups, retained event digests and workspace inspection errors.
Fresh workspace/artifact/session-root and session-index inventories also refuse
unaccounted data; empty task records never imply those roots are empty. Deletion
inspection uses its read-only purpose without driver/model/provider probes.
An absent-record cancellation tombstone cannot replace dispatched task history;
that cancellation retains an unknown outcome and its workflow hold.
Terminal status alone is insufficient worker-exit proof: this flow accepts a durable
canceled-before-start marker or a different kernel boot for a recorded worker;
same-boot completed workers without an attempt-bound exit receipt remain blocked.

## Fresh account and template constraints

Pinned Lume 0.6.1 offline setup hardcodes the image's initial account and does
not expose a supported initial personalized password in its unattended config;
its health-check password is not an account-creation setting. The published
initial account is not a production credential. This implementation neither
persists it nor guesses, enters, resets or copies passwords. A supported secure
account-personalization path and fresh guided setup remain release gates.

Apple's supported
[guest provisioning API](https://developer.apple.com/documentation/virtualization/vzmacguestprovisioningoptions)
can configure the initial account on first boot after restore, but requires
macOS 27 on both host and guest. The acceptance host is macOS 26.3.1 with SDK
26.5, and pinned Lume does not expose this API. It cannot establish acceptance
on this host or personalize the retained pilot; no OS upgrade or account
change is part of the current validation.

Upstream golden-image testing includes SIP-disabled/TCC-seeded variants. Those
are not a supported product shortcut. No permission inheritance is claimed for
clones; a credential-free, SIP-enabled template needs fresh-clone identity,
permission and usable-desktop evidence before reuse. The current pilot's own
Codex authentication, Accessibility, Screen Recording and explicit Driver
capture were verified on 2026-10-25 and must not be requested again.

## Candidate dependency profile and distribution boundary

The adapter targets Cua CLI **0.7.0**, Lume **0.6.1**, guest Cua Driver
**0.28.0** and Codex **0.156.1**. Guided setup downloads pinned release archives
only after disclosure/confirmation. It does not run upstream shell installers,
modify TCC/SIP, copy host credentials or enroll the host. Fresh-profile
interoperability still needs validation on this exact combination.
The candidate macOS image is pinned to:

```
ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba
```

The registry manifest inspected on 2026-10-24 declared 24,212,741,210 compressed
download bytes, 4 vCPUs, 8 GiB RAM, a 150 GiB sparse disk and 1024×768 display.
Actual allocated disk, image cache and project/toolchain growth are additional.
Cua/Lume verify OCI content digests. The automatically selected guest runtime is
checked for arm64 and SHA-256 verified after transfer. The host checks Apple
Silicon/macOS, virtualization, free memory/disk, dependency versions and local
VM concurrency. These are admission checks, not performance measurements.

The source inventory at
[upstream 27d8da9](https://github.com/trycua/cua/blob/27d8da9fd94056bd73892183531579396aafb2f9/legal/LICENSING.md)
identifies SDK/CLI, Driver and Lume as MIT, and Spaces applications,
`cua-spacesd` and streaming/storage components as FSL. The pinned image includes
`cua-spacesd`; this is not an entirely MIT dependency stack. No upstream binary,
viewer implementation, image or credential is checked into this change. Guided
download/preparation does **not** settle distribution rights.
The [exact FSL terms](https://github.com/trycua/cua/blob/27d8da9fd94056bd73892183531579396aafb2f9/libs/cua-spacesd/LICENSE)
allow internal use but restrict competing commercial availability. Commercial
integration/distribution review is still a release gate. A Lume + permitted
Driver + SSH transport without Spaces/image dependencies is an alternative,
not an implemented or validated claim here.

## Host and guest state contract

| Condition | Behavior / evidence required |
| --- | --- |
| Awake host locked | Independent guest worker and GUI should continue; real 15-minute product gate pending. No host capture/unlock. |
| Host display off, system awake | Separate real validation pending; `caffeinate -i` allows display sleep. |
| Viewer/window closed or app quit | Supervisor/guest own execution; same-worker reconnect must be demonstrated. |
| Host sleep, power off, reboot or lid-related sleep | Local execution may stop; retained state must show interruption/uncertainty. No continued-execution promise. |
| Guest locked / GUI unavailable | Guest desktop tools report unavailable; shell may remain available. User recovers guest. |
| Provider login, permission or limit | Wait for the correct task's human decision; never self-approve. |

Local compute still uses the selected provider's network inference; screenshots,
selected source and task data may be sent to that provider. This is not a
local-only inference/privacy claim.

## Required release evidence

The earlier pilot under `~/.cua/pilots/terminalx-ui-pilot` observed 28 successful
unlocked guest UI cycles over 15 minutes and a separate noVNC trusted click.
It did not observe host lock and had no authenticated real provider session.
It is evidence about that pilot, not acceptance of this product integration.
The existing pilot remains preserved and may be restarted only at the user's
explicit direction.

| Gate | Current evidence |
| --- | --- |
| Recovered work starts from fresh remote main | Exact checkpoint `fa0f4fa8` integrated with remote main `76a7d7b2` on 2026-10-26. |
| Automated TypeScript/UI/invariant checks | Recorded by author in external `pro114-status.json`; rerun after final edits. |
| Real macOS guest provider worker + transcript/PTY reconnect | Historical scoped guest tasks and fresh RPC-client reconnect passed; desktop reopen and interrupted-provider resume remain pending. |
| Native guest app + browser input/readback; untouched host sentinel | Historical Calculator and trusted Safari input/readback passed at checkpoint `fa0f4fa8`. Guest `128f5efc` passed the new native setup document input/readback/save/close check through background transport on 2026-10-27. Complete host-isolation acceptance remains pending. |
| Host locked ≥15 minutes + terminal work + GUI action | Pending human participation; never inferred from unlocked pilot. |
| Display off + viewer closed | Pending separately. |
| Guest lock + supported recovery | Pending. |
| Viewer/window/app quit and reconnect, same execution | Pending. |
| Host sleep/wake + disposable guest restart, no replay | Pending. |
| Regular/GitHub/Linear parent routing + concurrent parent work | Pending product demonstration. |
| Conflict-aware patch round trip | Real Git integration tests plus real guest round trip still required. |
| Permissions/auth/limits/version/network/disk/download faults | Automated boundaries only; real fault matrix pending. |
| Two identities, desktop queue, provisioning cancel, stop/delete/history | Automated invariants only; real VM cleanup tests pending. |
| Provisioning, screenshot/input/terminal latency, RAM/CPU/disk growth | Pending measurements; no release threshold promised. |

The replacement author session keeps milestone and blocker evidence at
`/Users/developer/.raccoon/task-coordination/pro114-pro117/pro114-status.json`.
The issue pipeline must not advance to completion/merge while these acceptance
gates remain unverified.
