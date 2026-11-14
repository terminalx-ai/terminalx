# macOS26 helper validation Run 1 run sheet

Run sheet P5 for [the helper validation plan](LOCAL-VM-HELPER-VALIDATION-PLAN.md),
phases 1.2, 1.3, 1.5 and 1.6. **It has not been executed.** No step below has
run against a VM disk image, with `sudo`, or inside a guest. Running it needs
the user's separate approval of the plan's draft Run 1 scope. Steps marked
**person** are human-only. Every `sudo` step is the person's.

The seed tool and probe were exercised only by unprivileged tests: real
disposable 64 MiB APFS images attached and mounted as a normal user, with
ownership on and off, read-only and read-write. Root ownership, `mount_apfs`
under `sudo` and a real restored macOS 26 disk were never exercised.

## Artifacts

Built by `node scripts/build-vm-bootstrap.mjs` from clean commit
`6aa26b4abe72083715fb1e0d65976b4863a5eb27` with rustc 1.97.1 and SDK 26.5
(`Cargo.lock` `993527de…b712ab`). They are retained under
`~/.raccoon/task-coordination/pro114-pro117/passes/20261030-helper-impl/artifacts/`
next to `manifest.json`.

| Artifact | Bytes | SHA-256 | Signature |
| --- | --- | --- | --- |
| `terminalx-vm-validation-probe` | 643,392 | `283ec5a8489d2a9330c13e229c38743f5bb2d1fbffb1d27feb4813df7067d1b1` | Linker ad hoc only. No team. |
| `terminalx-vm-seed` | 744,368 | `29bde7fd4b23f7226f02900cb6d16c1337e3b23980d9c9450f2472588d6577c3` | Linker ad hoc only. No team. |
| `com.terminalx.next.vm-validation-probe.plist` | 492 | `2d1e06367b671df7af1ab236ac107c3f706a6b5068e43f809440d83ec64474e9` | Not applicable |

| Input | State |
| --- | --- |
| Developer ID signature for the probe (P3) | **Absent.** Signing is held. With this ad hoc probe, Run 1 can establish G1–G4 and the disable part of G6, but not G6's attribution. A Developer ID build changes the probe digest, so this sheet must be regenerated before that run. |
| Restore image (P1) | **Absent.** No image is selected or downloaded. |
| Target `disk.img` identity | **Does not exist yet.** It is recorded in phase 1.1 (device, inode, size) and checked before every step below. |
| Approval of the Run 1 scope | **Not requested.** |

## Values the person carries between steps

These are records from earlier steps, not placeholders to invent:

- `IMG` is the absolute target `disk.img` path from phase 1.1. `ID` is its
  recorded `device inode size`.
- `SEED` and `PROBE` are the two artifacts above. `M` is
  `/private/var/tmp/tx-helpval-r1`.
- `diskN` is the whole disk that `hdiutil attach` prints for `IMG`.
- `SYS` and `DATA` are the `system.device` and `data.device` that
  `terminalx-vm-seed volumes diskN` reports.

## Before every phase (person)

```sh
shasum -a 256 "$SEED" "$PROBE"            # must equal the artifact table
stat -f '%d %i %z' "$IMG"                 # must equal ID
hdiutil info | grep -F -- "$IMG"          # must print nothing: not attached
pgrep -f com.apple.Virtualization.VirtualMachine | wc -l   # target stopped; at most 1 other guest
df -g /System/Volumes/Data                # at least 30 GiB free must remain
```

Any mismatch stops the run. Go to recovery in the plan.

## Phase 1.2: G1 offline inspection (person, read-only)

```sh
sudo mkdir -m 0700 "$M" && sudo mkdir -m 0700 "$M/system" "$M/data"
hdiutil attach -readonly -nomount -noautofsck "$IMG"         # note diskN
"$SEED" volumes diskN > g1-volumes.json                      # exit 0: one System, one Data, Data unencrypted
sudo mount_apfs -o rdonly,nobrowse "/dev/$SYS" "$M/system"
sudo "$SEED" release "$M/system" > g1-release.json           # productVersion 26.x; build must equal P1's
sudo mount_apfs -o rdonly,nobrowse,nosuid,nodev "/dev/$DATA" "$M/data"
sudo "$SEED" inspect "$M/data" > g1-inspect.json             # exit 0: pristine, ownership honored
sudo ls -leO@ "$M/data/Library" "$M/data/private/var/db" > g1-listing-before.txt
sudo umount "$M/system" && sudo umount "$M/data"
hdiutil detach diskN
```

G1 fails if `volumes`, `release` or `inspect` refuses, or if the build differs
from P1. A System volume that will not mount read-only is recorded with its
error, and G1's build check stays "not observed".

## Phase 1.3: seed (person, `sudo`)

```sh
hdiutil attach -readwrite -nomount -noautofsck "$IMG"        # note diskN
"$SEED" volumes diskN > seed-volumes.json                    # same SYS/DATA names as phase 1.2
sudo mount_apfs -o nobrowse,nosuid,nodev "/dev/$DATA" "$M/data"
sudo "$SEED" seed "$M/data" "$PROBE" > seed-receipt.json     # re-checks pristine, then writes three items
sudo umount "$M/data"
sudo mount_apfs -o rdonly,nobrowse "/dev/$DATA" "$M/data"
sudo "$SEED" readback "$M/data" seed-receipt.json > seed-readback.json
sudo ls -leO@R "$M/data/Library/LaunchDaemons" "$M/data/Library/Application Support/TerminalX" \
  "$M/data/private/var/db/com.terminalx.next.vm-validation" > seed-listing-after.txt
sudo umount "$M/data"
hdiutil detach diskN
```

Pass:

- `seed` and `readback` both exit 0;
- the receipt lists the three items as `root:wheel` with modes `0644`, `0755`
  and `0600`, and the probe and plist digests equal the artifact table;
- the after listing adds only the three items and the receipt's
  `createdDirectories`.

`seed` refuses without writing if:

- it is not running as root;
- the mount ignores ownership, is read-only, or lacks `nosuid` or `nodev`;
- the volume is not pristine;
- any path component is a link or on another device.

A refusal after a partial write is left in place for teardown. Never re-seed.

Record any extended attribute names in the receipt. Only
`com.apple.provenance` is accepted. Whether launchd starts a daemon whose files
carry it is part of G2.

## Phase 1.5: G2 and G4 readback after first boot (person, read-only)

After the person has completed Setup Assistant and shut the guest down:

```sh
hdiutil attach -readonly -nomount -noautofsck "$IMG"
"$SEED" volumes diskN > g4-volumes.json      # refuses if the person turned on FileVault
sudo mount_apfs -o rdonly,nobrowse "/dev/$DATA" "$M/data"
sudo "$SEED" readback "$M/data" seed-receipt.json > g4-readback.json
sudo cat "$M/data/private/var/db/com.terminalx.next.vm-validation/launches.jsonl" > launches-boot1.jsonl
sudo umount "$M/data" && hdiutil detach diskN
```

- **G4** passes when `readback` exits 0.
- **G2** passes when the first `launch` line has `euid` 0, `ppid` 1,
  `setupDone` false and `consoleUid` 0.
- In Run 1, the `vsock` line's errno counts are recorded only. Without a
  socket device they are not a G3 result.
- If `volumes` refuses because the Data volume is encrypted, these offline
  checks are "not observed". The person's in-guest observations replace them,
  as the plan describes.

A missing log could mean either that launchd never started the probe, or that
the probe refused and exited 0. In the guest, the person's
`sudo launchctl print system/com.terminalx.next.vm-validation-probe` output
(last exit status) tells the two apart.

## Phase 1.6: G6 evidence (person)

- **In the guest, evidence only:**
  - `sudo sfltool dumpbtm` (the probe's entry);
  - `sysctl -n kern.bootsessionuuid` for boots 2 and 3;
  - screenshots of System Settings > General > Login Items & Extensions,
    before and after turning the probe off.
- **Offline readback:** after boot 3, repeat phase 1.5's readback into
  `launches-boot3.jsonl`.
- **G6 disable** passes when there is a `launch` line for boot 2's UUID and
  none for boot 3's.
- **G6 attribution** is "not established" with this ad hoc probe.

Teardown, recovery and retention follow the plan. `$M` is removed only after
both mounts are gone.
