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

The host installs a per-user LaunchAgent with a private, stable executable
copy. It survives window/viewer closure and app exit. It drains task queues,
collects events and owns the optional scoped `caffeinate -i` assertion. It does
not use `-d`, disable screen lock/FileVault, or change persistent power settings.
Disabling new submissions does not destroy existing task history or stop a VM.
To remove the integration, first resolve all tasks, export needed artifacts,
and explicitly delete the enrolled guest in Settings if desired. Disable Local
Cua. The host service can then be removed by stopping its exact
`~/Library/LaunchAgents/com.terminalx.local-vm.<data-directory-hash>.plist`
with `launchctl bootout gui/$(id -u) <that-plist>` and removing that same plist.
Check its ProgramArguments data directory before choosing it; leave unrelated
jobs and VMs alone. Retaining `$TERMINALX_HOME/local-vm` preserves the history.
No uninstall command automatically erases conversations or credentials.

A guest LaunchAgent runs the macOS arm64 `terminalx-serve` with
`TERMINALX_HOME=/Users/lume/.terminalx-local/runtime`. Provider processes, PTYs,
transcripts, permission waits and result collection belong to that runtime.
The existing headless runtime is reused; Linux binaries cannot substitute for
this build. The release workflow includes a macOS arm64 runtime artifact,
architecture check, self-test and checksum inventory.

Control uses the separately installed Cua CLI's authenticated guest execution
transport, forwarding bounded JSON over stdin to a guest helper. The helper
reads only its guest runtime's owner-only control socket/token. Host control
credentials are removed from child environments. No new unauthenticated LAN
control/VNC endpoint or cloud relay is introduced by this adapter.

The guest's provider MCP configuration contains the task-bound computer
proxy. It runs **inside the guest** and forwards a restricted native tool set
to its separately installed Cua Driver. It has no VM/fleet selector or host
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
Deletion requires a fresh guest-work/task/resume inspection and refuses
unfinished tasks or unresolved provisioning. It removes only the exact
enrolled VM identity and never a host checkout or unrelated VM.

## Candidate dependency profile and distribution boundary

The adapter targets separately installed Cua CLI **0.7.0**, Lume **0.6.1** and
guest Cua Driver **0.28.0**. Driver/guest interoperability still needs validation
on this exact combination. No remote installer is executed implicitly.
The candidate macOS image is pinned to:

```
ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba
```

The registry manifest inspected on 2026-10-24 declared 24,212,741,210 compressed
download bytes, 4 vCPUs, 8 GiB RAM, a 150 GiB sparse disk and 1024×768 display.
Actual allocated disk, image cache and project/toolchain growth are additional.
Cua/Lume verify OCI content digests. The selected guest runtime binary is
checked for arm64 and SHA-256 verified after transfer. The host checks Apple
Silicon/macOS, virtualization, free memory/disk, dependency versions and local
VM concurrency. These are admission checks, not performance measurements.

The source inventory at
[upstream 27d8da9](https://github.com/trycua/cua/blob/27d8da9fd94056bd73892183531579396aafb2f9/legal/LICENSING.md)
identifies SDK/CLI, Driver and Lume as MIT, and Spaces applications,
`cua-spacesd` and streaming/storage components as FSL. The pinned image includes
`cua-spacesd`; this is not an entirely MIT dependency stack. No upstream binary,
viewer implementation, image or credential is bundled by this change. That
external installation boundary alone does **not** settle distribution rights.
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
| Recovered work starts from fresh remote main | `5f2c9a38ac76daf9ed39ad50658aaae594896e96` verified. |
| Automated TypeScript/UI/invariant checks | Recorded by author in external `pro114-status.json`; rerun after final edits. |
| Real macOS guest provider worker + transcript/PTY reconnect | Pending guest restart and human provider login. |
| Native guest app + browser input/readback; untouched host sentinel | Pending product validation. |
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
