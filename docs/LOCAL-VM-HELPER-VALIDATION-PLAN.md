# macOS26 helper delivery validation plan

Validation plan, 2026-10-30, for [signed first-boot helper delivery](LOCAL-VM-HELPER-DELIVERY.md)
(design commit `394fe794`). On 2026-10-30 the user selected Option A, the
bundled `SMAppService` seed daemon, as the architectural target. This document
prepares the validation that target still needs.

**Nothing in this plan has been run, and it does not request or imply approval
for any live step.** No VM, restore image, disk image, privileged component,
signing identity, account or credential was created, downloaded or changed
while writing it. The only host observations were read-only (see Evidence).
Procedures below describe intended steps, not tested commands. Inputs that do
not exist yet are named as missing, never filled with stand-ins.

## Which stack this is

- The personalized macOS26 path in PRO-114 is TerminalX's own integration: the
  provisioning ledger (`macos_provision.rs`), the restricted owner patch and
  channel (`integrations/lume-bootstrap/`, `macos_owner_channel.rs`), the guest
  channel and enrollment design, and the guest helper. It runs on **Lume**, the
  open-source macOS VM manager from Cua, pinned at 0.6.1 / upstream
  `3350f504014c85416009a90fcb339fe556ce02fc`. Lume drives **Apple's
  Virtualization.framework**. The guest is restored from a genuine Apple IPSW,
  and the person creates their own account.
- The broader Cua SDK, Spaces and their guest daemon were researched
  ([execution research](LOCAL-VM-EXECUTION-RESEARCH.md#cua-the-closest-backend-reference))
  and not adopted. The bundled seed daemon is a TerminalX host component. Its
  selection implies no migration to them.
- The earlier pilot work on this branch is closer to Cua and is unchanged by
  this plan. Both retained VMs were cloned from one Cua prebuilt image
  (manifest `sha256:7cb23670…`) that ships a fixed `lume` account. The
  attached-desktop path pins Cua's `cua-driver` 0.28.0. That pilot path is not
  the onboarding path validated here.

## Three groups of checks

**Guest facts G1–G6** are properties of macOS 26 and Virtualization. They do not
depend on how the host obtains root. So a person-run `sudo` seed stands in for
the daemon's write. That `sudo` step is validation scaffolding: it is never
shipped, never an onboarding step, and not the person-launched helper.

| Fact | Statement (from the design) | Established in |
| --- | --- | --- |
| G1 | A restored macOS26 Data volume can be attached and mounted on the host before first boot, unencrypted | Run 1, phase 1.2 |
| G2 | A root-owned `0644` LaunchDaemon seeded offline is loaded on first boot before Setup Assistant completes, under Background Task Management defaults | Run 1, phase 1.5 |
| G3 | A pre-login root daemon can connect `AF_VSOCK` to `VMADDR_CID_HOST` | Run 2. Run 1 records only the socket-level result. |
| G4 | First boot and Setup Assistant leave the seeded items intact | Run 1, phase 1.5 |
| G5 | The restricted owner's real `VZVirtioSocketListener` accepts the connection | Run 2 |
| G6 | Disabling the item in Login Items prevents the launch, and the person sees it attributed to its signing team | Run 1, phase 1.6 |

The installed SDK's `SMAppService.h` gives the expected outcome for G2: "Legacy
LaunchDaemons installed in /Library/LaunchDaemons will continue to be
bootstrapped without explicit approval in System Settings since writing to
/Library is protected with filesystem permissions." That sentence describes a
running system. Whether it also holds for a plist written offline, before the
first boot and ahead of Setup Assistant, is exactly what G2 tests.

**Host acceptance H1–H6** covers the bundled daemon itself: packaging, signing,
notarization, approval, caller restriction, disable/revoke and update. It needs
the daemon to exist (design source slice 5) and its own approval. It is defined
[below](#host-acceptance-of-the-bundled-seed-daemon-h1h6) so that guest results
are never read as host acceptance. No H procedure runs before G1–G6 pass.

**Fresh-Mac packaging acceptance F0–F7** covers the finished end-user flow on
a Mac with no developer tooling. It comes last, after G and H, and is defined
[below](#fresh-mac-packaging-acceptance-f0f7).

## Why two runs, one target at a time

- A VM boots for the first time only once, and G2 needs that first boot.
- The pinned Lume 0.6.1 configures no socket device
  ([guest channel contract](LOCAL-VM-GUEST-CHANNEL.md#verified-transport-contract)),
  so a run on it cannot establish G3 or G5.
- The restricted owner only launches a VM created by TerminalX's own
  provisioning record.
  - When this plan was first written, its executable was not built, because
    the full build lacked 18 locked dependency revisions.
  - Since then it has been built offline (P6,
    [offline build](../integrations/lume-bootstrap/OFFLINE-BUILD.md)). It
    carries only the linker's ad hoc signature and no virtualization
    entitlement, so it cannot host a VM.
  - Release builds refuse it: `Artifact::production()`
    (`src-tauri/src/local_vm/macos_owner_launch.rs:52`).
- **Run 1** therefore uses the installed pinned Lume to learn G1, G2, G4 and G6
  early. Those are the facts most likely to break the design, and they need no
  restricted build. **Run 2** uses the restricted owner for G3 and G5 and
  re-observes G1, G2 and G4 on its own instance.
- At most one target instance exists at any time. Run 1's target is deleted
  before Run 2's is created. Neither is reused.

## The disposable target

| Property | Run 1 | Run 2 |
| --- | --- | --- |
| VM name | `terminalx-helpval-r1` | `terminalx-<key>`, assigned by TerminalX's create |
| Storage | `~/.raccoon/vm-validation/r1/storage/` (absent on 2026-10-30) | `<TERMINALX_HOME>/local-vm/macos-vms/<key>/`, with a dedicated `TERMINALX_HOME=~/.raccoon/vm-validation/r2/home` (`store/mod.rs:41` reads that variable) |
| Created by | Installed pinned Lume 0.6.1 CLI, with the same arguments as TerminalX's create | The TerminalX validation build's existing create path |
| Restore image | The one pinned IPSW (P1) | The same image, as a reviewed catalog entry |
| Hardware | 4 vCPU, 8 GB memory, 160 GB logical sparse disk, 1024x768, NAT. Identical to `macos_provision.rs:135` and `:164`–`:185` | Same |
| Shares | None | The restricted profile's read-only input and read-write output |
| Console | One foreground Lume window for the person (needs an explicit exception, see approval scope) | None. Setup Assistant is never advanced and no account is created. |
| Evidence | `~/.raccoon/task-coordination/pro114-pro117/acceptance/helper-validation/r1/` | `…/helper-validation/r2/` |

Bounds, all rechecked at every phase boundary:

- **Disk.** On 2026-10-30 the host Data volume had 128.9 GiB free (93% used).
  Preflight requires free space of at least the IPSW byte count + 60 GiB + a
  30 GiB floor. The run stops and tears down if free space falls below 30 GiB
  or the target's `disk.img` allocated blocks exceed 60 GiB.
- **VM slots.** Apple's macOS licence (section 2B(iii)) allows "up to two (2)
  additional copies or instances" in virtual environments per Mac, and
  Virtualization reports `VZErrorVirtualMachineLimitExceeded`. The target starts
  only if at most one `com.apple.Virtualization.VirtualMachine` process is
  running. A running retained VM is never stopped to make room: the run waits
  or ends. The snapshot showed zero such processes, with the host up 1 h 23 min.
- **Network and credentials.** NAT only: no port forwards, no SSH, no Remote
  Login unless the person turns it on. No host key, TerminalX token, provider
  login or Apple Account credential enters the target. The validation key is
  random, nothing uses it, and it is destroyed with the target.
- **Time.** Each probe launch stops after a 15-minute window. Run 1 has at most
  three boots.

Out of scope, never written, started, stopped, attached or deleted:

- The retained pilot `~/.lume/terminalx-ui-pilot` and the retained comparison
  VM `~/.lume/terminalx-fresh-comparison`. Also `~/.lume/zeron-terminalx-comparison`,
  `~/.lume/cua-base-57b1d14676cd`, `~/.lume/cache`, `~/.config/lume/config.yaml`
  (its only VM location is `~/.lume`) and the running `lume serve --port 7777`.
- The six histories, the recovered checkpoint, prepared artifacts, `STOP`, the
  retired heartbeat, the 30-minute watcher trigger and the production app.

Guards that keep it that way:

1. Every Lume command names `--storage` with the target's absolute storage
   path. No Lume command runs against the default location. No Lume
   configuration or VM location is changed.
2. Right after create, the target's `disk.img` device and inode are recorded.
   Every later disk operation names that absolute path and rechecks the
   recorded identity first. A path under `~/.lume`, or any mismatch, stops the
   run.
3. Before any attach, `hdiutil info` must show the image unattached, and no
   Virtualization process may have it open. The target must be stopped.
4. Teardown deletes only the inode-verified storage directory. It never deletes
   by a recomputed name.

## Prerequisites: what exists and what is missing

| # | Input | Needed by | State on 2026-10-30 (P6 and P7 updated through 2026-10-31) | Before a runnable experiment exists |
| --- | --- | --- | --- | --- |
| P1 | One Apple macOS 26 IPSW: URL on `updates.cdn-apple.com` or `appldnld.apple.com`, build, SHA-256, bytes | Runs 1, 2 | **Absent.** The catalog compiled into source is `{"version":1,"images":[]}`. Image download is held. | The person approves selecting and downloading one image. Its URL, build, SHA-256, size and selection source are recorded. For Run 2 the same record becomes a reviewed catalog entry, which is a separate source change. |
| P2 | Pinned Lume 0.6.1 | Run 1 | **Present.** `~/.local/share/lume/lume.app` executable SHA-256 `a369d637…fc904` matches `bootstrap.rs:63`; signed `com.trycua.lume`, team `YCK386LBJ7` | Re-verify the digest at preflight. No reinstall or update. |
| P3 | Validation probe `terminalx-vm-validation-probe` ([spec](#validation-probe-and-seed-items)) | Runs 1, 2 | **Built, not Developer ID signed.** Source is `native/vm-bootstrap` (commit `6aa26b4a`). The arm64 probe `283ec5a8…` has only the linker's ad hoc signature and no team ([run sheet](LOCAL-VM-HELPER-RUN-SHEET.md)). | Sign with TerminalX's Developer ID Application identity and hardened runtime. Record digest, cdhash, team ID and signing time, then regenerate the run sheet. Signing is held. The repo pins no TerminalX team: build scripts read `APPLE_SIGNING_IDENTITY`, and the only pinned team (`YCK386LBJ7`) is Cua's. An ad hoc signature still exercises G1–G4, but cannot establish G6's attribution. |
| P4 | Validation LaunchDaemon plist | Runs 1, 2 | **Present.** `native/vm-bootstrap/com.terminalx.next.vm-validation-probe.plist` (`2d1e0636…`). A test checks it with `plutil` against the probe's label and program path. | Review. |
| P5 | Seed and readback run sheet | Runs 1, 2 | **Written, not executed.** The [Run 1 run sheet](LOCAL-VM-HELPER-RUN-SHEET.md) uses the real artifact digests and marks the Developer ID and restore-image fields absent. | Review it before any approval. Regenerate it after signing and once P1 exists. |
| P6 | Restricted owner executable | Run 2 | **Built offline, not signed or adopted.** On 2026-10-30, all 18 locked revisions and the exact source were fetched into an isolated folder. The network-denied build produced arm64 `lume`, most recently `3682708e…` (2026-10-31, with the account-confirmation relay, key grant, host-key observation, retirement acknowledgement and its read-only record actions), with only the linker's ad hoc signature and no entitlements ([offline build](../integrations/lume-bootstrap/OFFLINE-BUILD.md)). `Artifact::production()` still refuses. | Review, sign with the virtualization entitlement, and decide catalog adoption for a validation profile. All of this is held. |
| P7 | TerminalX validation build | Run 2 | **Partly built.** The owner-mediated stop exists for version-3 owners: a MAC'd `stop` request is journaled once, answered, then the VM is asked to stop, and exit evidence is only the host's child-wait record (native tests with the compiled owner). The seeded version-3 launch and enrollment receipt exist too. The cargo feature `vm-validation` (never in a release) reads the P6 pin and the P1 entry only from owner-only files under a dedicated, non-default `TERMINALX_HOME`; see Run 2 below. Release builds still refuse both. | A reviewed source slice that acquires only the P6 artifact, under a validation profile and the dedicated `TERMINALX_HOME`; creates through the existing path using the P1 entry; and supports an owner-mediated stop. Without that stop, Run 2 is not runnable. |
| P8 | Probe vsock client mode | Run 2 | **Implemented** in `wire.rs`. Fixture-tested over socketpairs against the owner's exact framing; never run against the real listener. | Run 2 itself. |
| P9 | Person and console | Run 1 | Not arranged | The person is available for the `sudo` steps, Setup Assistant and Login Items. The console exception is approved. |
| P10 | Capacity | Runs 1, 2 | 128.9 GiB free; 0 VM processes | Re-checked at preflight against the bounds above. |

## Validation probe and seed items

The seed writes three items that mirror the design's three, under validation
names, so a leftover can never be mistaken for the production helper.

| Path on the guest Data volume | Owner / mode | Content |
| --- | --- | --- |
| `/Library/LaunchDaemons/com.terminalx.next.vm-validation-probe.plist` | `root:wheel 0644` | `Label` `com.terminalx.next.vm-validation-probe`, absolute `Program`, `RunAtLoad` true, `KeepAlive {SuccessfulExit: false}`. The same key set as the design's plist; no arguments, environment or `UserName`. |
| `/Library/Application Support/TerminalX/VMValidation/terminalx-vm-validation-probe` (parents `root:wheel 0755`) | `root:wheel 0755` | P3. No quarantine attribute; only `com.apple.provenance` is accepted (see below). |
| `/private/var/db/com.terminalx.next.vm-validation/enrollment.json` (directory `root:wheel 0700`) | `root:wheel 0600` | `{version: 1, purpose: "validation", seedId, key}`, with 32 random bytes. Nothing reads it. |

**Finding (2026-10-30, disposable fixture).** Files created by a
provenance-tracked process carry `com.apple.provenance`, and that process
cannot remove it: `xattr -d` reports success but the attribute remains. A
seeder run from Terminal under `sudo` is therefore expected to leave it on all
three items. The seeder records attribute names and refuses any other name,
quarantine in particular. Readback requires the recorded set. Whether launchd
loads a daemon whose plist and executable carry this attribute is observed
under G2.

Each time it is launched, the probe:

- Appends one JSON line to `/private/var/db/com.terminalx.next.vm-validation/launches.jsonl`,
  creating it `root 0600` with `O_APPEND|O_NOFOLLOW`. The line records:
  - `kern.bootsessionuuid`, `kern.boottime` and the current time;
  - its uid, euid, gid and parent PID;
  - whether `/private/var/db/.AppleSetupDone` exists, and the owner UID of
    `/dev/console`;
  - owner, mode and size of the three seeded items (never their contents);
  - its own team ID and cdhash, from `SecCodeCopySelf` and
    `SecCodeCopySigningInformation`.
- Every 10 seconds within its 15-minute window, opens an `AF_VSOCK` stream and
  makes a nonblocking connect to `VMADDR_CID_HOST` port 49871, recording the
  `errno` of each attempt. In Run 2, after a successful connect, it sends
  `{"version":1,"clientNonce":…}`, reads one offer frame of at most 256 KiB
  (the owner's TXWire bound), and records:
  - the frame's size and SHA-256;
  - the decoded challenge's SHA-256, `version` and `ownerEpoch`;
  - whether the challenge echoes this hello's client nonce.

  It then closes.
  It sends no share echo, claims or account data.
- Exits 0 when the window ends, so `KeepAlive` does not restart it. It writes
  nowhere else, opens no other socket and never reads the key.

## Run 1: guest facts on the pinned Lume

Each phase lists its actor and stops on the first failed check. "Human-only"
means the person performs the step; automation never does.

### 1.0 Preflight (automation, read-only)

- Checks:
  - P1–P5 and P9 exist, with recorded digests.
  - An approval record matching the draft scope below is present.
  - The capacity bounds hold.
  - The P2 digest matches.
  - `~/.raccoon/vm-validation/r1` does not exist.
  - The `~/.lume` config digests equal the snapshot.
- Evidence: `preflight.json`.
- Stop: any failed check. Nothing has been created.

### 1.1 Restore (automation in the background, under approval)

- Procedure:
  - Create the storage directory with mode `0700` and re-verify the IPSW
    SHA-256.
  - Run the pinned Lume `create terminalx-helpval-r1` once, with the TerminalX
    profile arguments (`--os macOS --cpu 4 --memory 8GB --disk-size 160GB
    --display 1024x768 --network nat --no-display --ipsw <P1> --storage
    <storage>`). The bound is 1800 s, the same as provisioning.
- Evidence:
  - exit status and output;
  - `config.json` digest;
  - `disk.img` device, inode, logical size and allocated blocks;
  - whether `nvram.bin` exists.
- Pass: exit 0 and the VM is stopped. The installed OS has never booted.
- Stop: non-zero exit or timeout means the outcome is unknown. There is no
  retry. Confirm no Virtualization process uses the storage, then go to
  teardown.

### 1.2 G1: offline inspection (human-only, `sudo`, read-only)

- Procedure:
  - Attach the recorded image `-readonly -nomount -noautofsck`.
  - From `diskutil apfs list -plist`, require exactly one volume with the
    `System` role and one with the `Data` role, and record their encryption
    and FileVault state.
  - Mount `System` read-only and read `SystemVersion.plist`.
  - Mount `Data` read-only with ownership enabled and `nobrowse`.
  - Record:
    - whether `.AppleSetupDone` exists;
    - any local user record with `UniqueID` ≥ 501;
    - any validation or production TerminalX path;
    - the existence, owner and mode of `/Library`, `/Library/LaunchDaemons`,
      `/Library/Application Support` and `/private/var/db`.
  - Unmount and detach.
- Evidence: `g1-inspection.json` and the command transcript.
- Pass:
  - the roles are as required;
  - ProductVersion is major 26 and the build equals P1's;
  - `Data` is not encrypted and mounts with ownership enabled;
  - the volume is pristine.
- Fail: G1 fails if `Data` is encrypted or locked, a role is missing or
  duplicated, the build differs, or the volume is not pristine. The offline
  seed is then invalid as designed. Stop, tear down and report.

### 1.3 Seed (human-only, `sudo`)

- Procedure (from the P5 run sheet):
  - Attach read-write with `-nomount -noautofsck`.
  - Mount `Data` with ownership enabled and `nobrowse,nosuid,nodev` at a fresh
    root-owned `0700` mount point, then recheck that it is pristine.
  - Before each write, `stat` every path component. Refuse a symlink or a
    different `st_dev`.
  - Create any missing parent directories as `root:wheel 0755`, recording
    which ones were created.
  - Write the three items with their owner and mode, then flush.
  - Unmount, remount read-only with ownership enabled, and read back each
    item's owner, mode, size, SHA-256, extended attributes and file flags.
  - List the touched directories before and after, then detach.
- Evidence: `seed-receipt.json`, the before/after listings and the
  transcript.
- Pass: the readback is exact, and the listing diff contains only the three
  items and the recorded new parent directories.
- Stop: any mismatch. Do not boot; go to teardown.
- A hand-run sequence relies on the fact that no guest code has ever run on
  this volume, so it holds no guest-authored links. The production seeder must
  not rely on that. It writes relative to descriptors, as the seeder contract
  in the design requires.

### 1.4 First boot and Setup Assistant (human-only, console exception)

- Procedure:
  - Recheck slots and disk.
  - The person starts the target with the pinned Lume `run`, using
    `--storage <storage>` and the Lume display window, with no VNC and no
    shared directories.
  - The person completes Setup Assistant with their own choices. The plan
    prescribes no account name, Apple Account, analytics or FileVault choice.
  - Once logged in, for evidence only and never as an onboarding step, the
    person records:
    - the `sudo sfltool dumpbtm` entry for the probe label;
    - a screenshot of System Settings > General > Login Items & Extensions
      showing the item and its attribution;
    - the text of any background-item notification.
  - The person then shuts down from the Apple menu.
- Offline readback needs `Data` to stay unencrypted. If the person turns on
  FileVault, G2 and G4 rely on the person's in-guest observations, and the
  offline readback is marked "not observed" rather than failed.

### 1.5 G2 and G4 readback (human-only, `sudo`, read-only)

- Procedure:
  - Attach and mount `Data` read-only with ownership enabled.
  - Copy `launches.jsonl` and restat the three items.
  - Detach.
- Pass G2: the first line has:
  - euid 0 and parent PID 1;
  - `.AppleSetupDone` absent and `/dev/console` owned by root, so no user
    session existed.

  That line is the first boot's, because the file did not exist at seed
  readback.
- Pass G4: owner, mode, size and SHA-256 of all three items equal the seed
  receipt. Any change, including new extended attributes, is recorded and
  fails G4.
- G3 in Run 1: record each `errno`. Without a socket device, a failed connect
  is expected and is not a G3 failure; G3 stays open. A pre-login `socket()`
  failure with `EAFNOSUPPORT` is recorded as a risk for Run 2.
- Fail G2: no line, or the first line shows a finished Setup Assistant or a
  console user. Then the daemon does not run before Setup Assistant, and design
  stage 5 must move after login, which reorders account confirmation. Report
  it and continue to G6 unless a stop condition applies.

### 1.6 G6: Login Items (human-only)

- Procedure:
  - Boot 2: the person logs in and records `sysctl -n kern.bootsessionuuid`.
    They turn the probe off in Login Items, take a screenshot and shut down.
  - Boot 3: the person logs in, records the boot session UUID and shuts down.
  - Offline readback, as in 1.5.
- Pass G6:
  - `launches.jsonl` has a line for boot 2 and none for boot 3;
  - the Login Items entry and the BTM record name TerminalX's developer or
    team, which requires P3's Developer ID signature.
- Fail: the probe launched in boot 3, or a Developer ID signed probe appears
  unattributed. If P3 was ad hoc signed, attribution is "not established"
  rather than failed.

### 1.7 Teardown (automation under approval; human recovery)

- Procedure:
  - Confirm no Virtualization process has `disk.img` open and `hdiutil info`
    shows no attachment.
  - Delete the inode-verified storage directory.
  - Keep the evidence directory. Never keep `disk.img` or `nvram.bin`, because
    they hold the person's account.
  - Keep the IPSW only if the approval says Run 2 follows; otherwise delete it.
- Pass:
  - the storage is gone;
  - free space is back to within 1 GiB of preflight, apart from a retained
    IPSW;
  - the `~/.lume` config digests and the VM process count equal preflight.

Recovery, for any phase:

- **Guest hangs.** Stop only this target, using the Lume window or `stop` with
  its `--storage`.
- **Attach left behind.** Detach only the device whose image is the recorded
  `disk.img`.
- **Create or seed outcome unknown.** No retry. A readback decides; if it is
  inconclusive, tear down.
- **Free space below the floor.** Stop the target and tear down.

## Run 2: host listener facts on the restricted owner

Run 2 is runnable only after Run 1 passes G1, G2 and G4 and P6–P8 exist. It is
specified as far as the missing inputs allow. Its run sheet is written once
they exist.

1. **Create.** The validation build, with the dedicated `TERMINALX_HOME`,
   creates the target through the existing provisioning create. The record
   reaches `created`.

   A person prepares the dedicated home before this step. Each file is
   owner-only, and the profile refuses `~/.raccoon` and `/`:

   - `<TERMINALX_HOME>/local-vm/validation/restricted-lume.json` holds the P6
     pin: profile, source commit, patch digest, executable digest and node.
   - `<TERMINALX_HOME>/local-vm/bootstrap-artifacts/<sha>/lume` is the signed
     P6 executable.
   - `<TERMINALX_HOME>/local-vm/validation/restore-catalog.json` holds the P1
     entry, with an Apple CDN URL, macOS 26, SHA-256 and byte count.
   - `<TERMINALX_HOME>/local-vm/restore-images/<sha>.ipsw` is the P1 image.

   The build is `cargo build --features vm-validation`.
2. **Seed.** Phases 1.2 and 1.3 run again on this instance, with the probe in
   vsock client mode.
3. **Launch.** The validation build runs the restricted bootstrap launch:
   shares, `--terminalx-bootstrap-fd`, `--display none`, `--vnc disabled`
   (`macos_owner_launch.rs:258`–`:285`). There is no viewer, Setup Assistant is
   never advanced and no account is created.
4. **Observe and stop.** The probe connects within its window, the owner
   journals the attempt and sends its offer, and the probe records it. Then an
   owner-mediated stop, followed by the offline readback from 1.5.
5. **Retain the journals, then tear down.** Before anything is deleted, copy
   the dedicated `TERMINALX_HOME`'s non-secret records into the Run 2 evidence
   directory, with a SHA-256 for each file. These include the provisioning
   record, owner intent, host plan, prepared record, attempt journal and
   receipts, plus the probe's `launches.jsonl`. Never copy secret material:
   `control.capability`, any private key or `macos_keys.rs` key reference,
   or the validation key. Verify the copies against their digests. Only then
   delete the VM storage, as in Run 1, and the dedicated `TERMINALX_HOME`.

- Pass G3: a probe line with `.AppleSetupDone` absent and `/dev/console` owned
  by root records a successful connect to CID 2 port 49871.
- Pass G5: the owner's private attempt journal shows one accepted connection on
  the configured device and listener at port 49871. The SHA-256 of the challenge the
  owner journaled (`guest-observation-intent.json`) equals the probe's recorded
  `challengeSha256`.
- Fail: the connect fails while the listener is present (G3), or the
  connection never reaches the delegate or is refused (G5). Stop and report the
  `errno` values and the owner journal.
- The hello uses up this target's single version-1 claim. That is acceptable
  only because the target is discarded.

## Host acceptance of the bundled seed daemon (H1–H6)

None of these steps can run yet, because the daemon does not exist. Each
installs a root component on a Mac host and needs its own approval. None
involves either retained VM.

| # | Acceptance | Evidence | Pass |
| --- | --- | --- | --- |
| H1 | Packaging | Plist and bundle listing digests | The daemon plist is in `TerminalX.app/Contents/Library/LaunchDaemons/`, using `BundleProgram` ("an app bundle relative path for the executable") and `AssociatedBundleIdentifiers` `com.terminalx.next`. It has one Mach service and no other capability. |
| H2 | Signing and notarization | `codesign --verify --strict`, `spctl --assess` and `stapler validate` output | The SDK says "Apps that contain LaunchDaemons must be notarized." The app and daemon carry TerminalX's Developer ID with hardened runtime, and are notarized and stapled. |
| H3 | Registration and approval | Logged status transitions and System Settings screenshots | `register()` from the signed app yields `RequiresApproval`. Only the person's approval in System Settings yields `Enabled`. TerminalX may call `openSystemSettingsLoginItems` but never approves on their behalf. |
| H4 | Caller restriction and contract | Fixture tests on disposable APFS images, plus one live root check | The daemon's Mach-service `NSXPCListener` sets `setConnectionCodeSigningRequirement` to the TerminalX app's requirement, so non-matching peers are "automatically rejected before consulting the delegate." It accepts one request type. It enforces the seeder contract's refusals: a path under `~/.lume`, a record not in `created`, a booted or non-pristine volume, a symlink, a foreign device, or an image that is attached elsewhere. |
| H5 | Disable and revoke | Status log and wait-state UI | Turning it off in Login Items yields `RequiresApproval` ("returned if the user revokes consent"). TerminalX shows a wait state and never re-enables it. A seed request while disabled fails with no write. `unregister` leaves no daemon. |
| H6 | Update | Status log across an app update | The SDK says the service "must be re-registered or it may not launch" after a plist or executable change. The update path unregisters, re-registers and re-checks status, and a stale daemon refuses requests. |

## Fresh-Mac packaging acceptance (F0–F7)

**Plain answer.** In the intended finished flow, the person installs TerminalX
the normal way and installs nothing else by hand. There is no Homebrew, Xcode
or Command Line Tools, Lume, Cua, Spaces, separate helper or `PATH` change.
TerminalX downloads and verifies everything else itself after showing sizes,
and macOS asks for the helper approval in its own Settings UI. **That flow is
not implemented or validated yet.** Today fresh macOS guest creation is refused
before anything is downloaded
([Local Cua tasks](LOCAL-CUA-TASKS.md#execution-and-retained-identity)). None
of the distribution artifacts listed below exists in its finished form. Some
exist only as source or local ad hoc builds, as the table records.

### Build machine versus end user

| Needed by | What | Notes |
| --- | --- | --- |
| TerminalX's build and release machine only | Xcode and the Swift toolchain, Rust, Node/pnpm, the 18 locked Swift dependency sources, a Developer ID identity and notarization credentials | These produce the signed artifacts. They are never a fresh-Mac prerequisite. |
| End user | A supported Apple silicon Mac on macOS 26, network access, free memory and disk, and a person who can approve the helper in System Settings and complete the guest's Setup Assistant | TerminalX checks the host at admission: Apple silicon and macOS version, virtualization, free memory and disk, dependency versions and local VM concurrency ([dependency profile](LOCAL-CUA-TASKS.md#candidate-dependency-profile-and-distribution-boundary)). |

### Finished target versus today

| Artifact | Finished target | Today |
| --- | --- | --- |
| Pinned Lume 0.6.1 for restore | App-managed download into the private `tools/<sha>` cache. The archive (6,112,964 bytes), the executable SHA-256 and the publisher's Developer ID team are checked before use (`bootstrap.rs:54`–`:66`, `:177`). | **Exists** for the current profile |
| Restricted Lume owner | Built by TerminalX from upstream `3350f504` plus `bootstrap.patch`, signed, delivered by TerminalX and pinned in its catalog | **Local offline build only.** Built from that source, most recently `3682708e…` (P6). It carries only the linker's ad hoc signature and no entitlements, so it cannot host a VM. Not signed, catalog-pinned, delivered or run. `Artifact::production()` refuses. |
| Bundled seed daemon | Inside `TerminalX.app`, notarized and registered through `SMAppService` (H1–H3) | **Absent.** Not implemented. Its packaging (design slice 5) is held for its own review. |
| Guest helper `terminalx-vm-bootstrap` | Signed, catalog-pinned and seeded offline | **Source, fixture tests and a local ad hoc candidate build only.** Enrollment, the account child, key install and the host-key report are implemented and fixture-tested in `native/vm-bootstrap` (`08d126b3` through `8ef96140`). The executable and its run loop were added in `c0b01b92`, and retirement after the owner's acknowledgement in `f19d0cb5` ([helper retirement](LOCAL-VM-HELPER-DELIVERY.md#helper-retirement)). Its latest local build is `4ed24487…`, thin arm64, ad hoc signed with no team ([guest helper executable](LOCAL-VM-HELPER-DELIVERY.md#guest-helper-executable)). The run sheet's reviewed artifacts remain the probe `283ec5a8…` and seed tool `29bde7fd…` (P3, [run sheet](LOCAL-VM-HELPER-RUN-SHEET.md)). Nothing is signed, catalog-pinned or seeded, and nothing has run or been removed in a guest. |
| macOS 26 restore image | Downloaded by the app from Apple's CDN and checked against a catalog SHA-256 | **Absent.** The catalog is empty |
| TerminalX release | One normal signed, notarized installer containing or fetching all of the above | **Absent.** No release includes them |
| Distribution review | Complete | **Open.** It is a release gate. Lume is MIT-licensed, and this path uses no Cua image and no `cua-spacesd`. |

The personalized path does not download the 24.2 GB Cua prebuilt image that
the earlier pilot profile used.

### Phases

The fresh Mac must be a separate physical Mac that is newly set up or erased.
It cannot be this development Mac, which has Xcode, a user-installed Lume on
`~/.local/bin` and the retained VMs. It also cannot be a macOS VM: the
installed SDK declares nested virtualization only in
`VZGenericPlatformConfiguration.h`, not for Mac guests.

The evaluator's audit commands are evidence, not steps in the flow. They use
base-system tools only, such as `sw_vers`, `ls`, `stat`, `shasum`, `codesign`
and `spctl`. They never run developer-tool stubs such as `git`, `clang` or
`python3`, because on a Mac without the Command Line Tools those prompt to
install them.

| # | Phase | Actor | Evidence | Pass |
| --- | --- | --- | --- | --- |
| F0 | Host eligibility | Evaluator, read-only | `sw_vers`, `hw.model`, a listing showing absence and a digest of `/etc/paths` | The Mac is Apple silicon on macOS 26. None of these exist: `/opt/homebrew`, `/usr/local/bin/brew`, Xcode, the Command Line Tools, `lume`, `cua`, `~/.lume`, `~/.cua`, `~/.local/bin`, a TerminalX LaunchDaemon, or shell-profile `PATH` additions. |
| F1 | Install | Person | Installer digest and the `spctl --assess` result | TerminalX installs through its normal signed, notarized installer. Gatekeeper accepts it without any override. |
| F2 | Disclosure and downloads | Person confirms; the app downloads | Screenshots, and the owner journal showing intent before each effect | Before anything is downloaded, the app shows the restore image, runtime and helper byte counts, the VM resources (4 vCPU, 8 GB, 160 GB sparse), the expected disk use and the retained storage. The shown sizes equal the catalog pins. Each artifact passes its SHA-256 and signature checks before use. An agent holding the runtime token can also send today's Create consent (`environment.create`). Whether it must carry a verified person approval is an open user decision ([person approval](LOCAL-VM-HELPER-DELIVERY.md#decision-required)). |
| F3 | Download failure and interruption | Evaluator injects the faults; the person recovers | Journal entries, the UI state and the partial-file state | The faults are: network loss mid-download, quitting the app mid-download, too little disk at admission, and a corrupted file. In each case a partial or mismatched file is never used, and the error is shown in TerminalX. Recovery is an explicit action in TerminalX. Create is never replayed, and nothing silently retries an uncertain effect. |
| F4 | Native helper consent | Person | `SMAppService` status log and System Settings screenshots | Approval happens only in macOS's own UI (H3). Declining leaves a TerminalX wait state, with no fallback to Terminal, `sudo` or an admin script. |
| F5 | Guest Setup Assistant and guest permissions | Person, in the guest | Screenshots and owner journal receipts | The person completes Setup Assistant and grants any guest permission in the guest's own System Settings. No SIP, TCC or profile change is made, and there is no fixed account or autologin. |
| F6 | Completion | Person confirms the account; automation does the rest | Account confirmation, enrollment and retirement receipts, plus a verified one-time person approval for each of the account confirmation, the key install and the host-key pin | The flow reaches the design's retirement receipt (stage 9) through TerminalX alone. A checkbox, the parent IDs or the shared runtime token are not evidence of the person's confirmation. Not runnable in the current build, which refuses those three steps before any effect until a verified approval mechanism exists ([person approval](LOCAL-VM-HELPER-DELIVERY.md#person-approval-for-person-only-actions)). |
| F7 | Post-run audit | Evaluator, read-only | A diff of the F0 probes | Only `TerminalX.app`, its private data root and the approved seed daemon were added. There is still no Homebrew, Xcode or Command Line Tools, Lume or Cua on `PATH`, Spaces, or shell-profile change. |

**Fail, explicitly:** the phase fails if any step requires the person to do
any of the following:

- open Terminal or run a shell command;
- install Homebrew, Xcode, the Command Line Tools, Lume, Cua, Spaces or a
  helper by hand;
- edit `PATH`;
- disable SIP or Gatekeeper;
- approve an unsigned or unnotarized item.

A Command Line Tools install prompt appearing at any point also fails it.

All of these are future work: G1–G6, H1–H6, every artifact above that is not
yet in its finished form, a signed and notarized release, the distribution
review, a separate fresh Mac and its own future approval.

## Draft approval scope for a future coordinated run

This is draft text for the user to approve or change later. **No approval is
requested or inferred by this document.** Values in brackets come from P1, P3
and P5 once they exist.

Run 1 approval would cover exactly:

1. Downloading one Apple macOS 26 IPSW [URL, build, SHA-256, bytes] to
   `~/.raccoon/vm-validation/restore/`.
2. Creating one VM, `terminalx-helpval-r1`, only under
   `~/.raccoon/vm-validation/r1/storage`, with the installed Lume 0.6.1
   (SHA-256 `a369d637…fc904`): 4 vCPU, 8 GB, a 160 GB sparse disk, NAT and no
   shares.
3. The person running `sudo` only for the steps in the reviewed run sheet [P5
   digest], and only against that VM's `disk.img`. Nothing is installed on the
   host.
4. Seeding exactly the three validation items, with the probe [digest] signed
   by [identity].
5. One foreground Lume window for that VM only, as a stated exception to the
   background-only instruction, for Setup Assistant and Login Items.
6. The person completing Setup Assistant with their own choices, and running
   the named evidence commands in the guest.
7. At most three boots, then stopping and deleting that VM. The evidence is
   kept, and the IPSW is [kept for Run 2 | deleted].

Run 1 approval would not cover:

- any other VM, including both retained VMs and the comparison VM;
- `~/.lume`, the Lume configuration or `lume serve`;
- the production app;
- installing or registering any privileged component;
- signing anything other than [P3];
- SSH or Remote Login;
- account automation;
- catalog or production promotion;
- PR or merge;
- any old-owner stop or stale-PID action.

Run 2 and H1–H6 each need a separate approval of the same shape, naming the
validation build, the restricted artifact digest and the dedicated
`TERMINALX_HOME`. F0–F7 need their own approval, on a separate fresh Mac.

## Outcomes

- **G1–G6 all pass.** Design source slices 1–4 continue against the observed
  facts, then slice 5 (the daemon) with H1–H6. Slices 1, 2 and 4 and the
  account child exist only as source, fixtures and local ad hoc builds
  ([source slices](LOCAL-VM-HELPER-DELIVERY.md#source-slices-after-the-decision)).
- **G1 fails.** Offline seeding is impossible as designed. Option A returns to
  a decision, with the evidence.
- **G2 fails.** Enrollment cannot precede Setup Assistant. The chain moves
  enrollment after login and is re-reviewed.
- **G3 or G5 fails.** The transport premise fails, and this listener offers no
  seamless path.
- **G4 fails.** The seed conflicts with "never reseed", and the design is
  re-reviewed.
- **G6 attribution fails.** The person-facing control story is incomplete and
  must be resolved before H3.
- **Any F step needs a manual install or a shell command.** Packaging fails,
  and the finished-flow answer above does not hold until that is fixed.

In every outcome, `acceptanceReady` and `readyForPr` stay false. Passing the
guest facts is evidence for a design, not product readiness.

## Evidence

Retained under `~/.raccoon/task-coordination/pro114-pro117/passes/20261030-helper-validation-plan/`:

- `preflight-snapshot.txt`
  `43455e3d306d939883fc019e8bd2450c9067a467f5ab4f7a870ea3a31cabc2d6`. A
  read-only capture at 2026-10-30T18:21:51Z containing:
  - host macOS 26.3.1 on a Mac15,9 (16 CPUs, 128 GiB), 128.9 GiB free;
  - zero Virtualization VM processes;
  - the installed Lume digest and signature;
  - `~/.lume` config and manifest digests;
  - the empty restore catalog;
  - SDK 26.5 digests and the quoted lines of `SMAppService.h`
    (`859ec2a7…f8ff`), `NSXPCConnection.h` (`d34e7696…fd1b`) and
    `VZError.h` (`6cda7bb0…49c5`);
  - macOS licence section 2B(iii) (`968f9721…dcb`).
- `status-before.json`
  `f556ca5cf5d65be3491e6ecdaa4e54d763c3ea3f18a1a583ea0acaf346e3f6f3`.
- `fresh-mac-addendum.txt`
  `7b430f817421847080f5e696fbf804e598985cbfb075a2fa682950c00d082052`. It shows
  that `VZGenericPlatformConfiguration.h` (`275c188f…d5`) is the only
  Virtualization header that declares nested virtualization, and records the
  Lume archive pin.

No VM was listed, started, stopped or attached through Lume. No disk image,
privileged tool, signing identity, download or account was used.
