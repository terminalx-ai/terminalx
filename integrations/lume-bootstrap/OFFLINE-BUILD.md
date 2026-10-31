# Exact candidate build inputs

On 2026-10-30 the full patched Lume candidate **was compiled offline** for the
first time, from the exact upstream commit and all 18 locked dependency
revisions. The executable has **not** been run, signed, installed, catalogued or
adopted. Signature/catalog review and live acceptance remain later gates.

## Result

- **Inputs.** Source only was fetched into the isolated folder
  `~/.raccoon/vm-build/lume-3350f504/`: a sparse checkout of
  `trycua/cua` at `3350f504014c85416009a90fcb339fe556ce02fc` (`libs/lume`), and
  bare mirrors of the 18 repositories in
  [Upstream.Package.resolved](Upstream.Package.resolved). Each locked revision
  is present. Each version pin's tag and each branch pin's branch contain it.
  The read-only preflight reports `offlineInputsComplete: true`. No global
  cache, SwiftPM configuration or installed Lume was used or changed.
- **A defect the stub typecheck could not see.** Inside the `lume` module,
  `Set` names Lume's own `lume set` command (`src/Commands/Set.swift`), not
  `Swift.Set`. The TerminalX bootstrap sources now say `Swift.Set`, and the
  patch is regenerated (`candidatePatchSha256` in [upstream.json](upstream.json)).
- **Executable.** Clean build in 360 s: arm64 `lume`, 22,004,056 bytes, SHA-256
  `057152a51c277f87e6db89ee4da75882aeaf6c16ca8f23f3a038aacc95a5f94e`, with only
  the linker's ad hoc signature, no team and no entitlements.
  - There are zero compiler warnings in `TerminalXBootstrap` and 36 in
    upstream files.
- **Rebuild with version-2 enrollment (2026-10-31).** After
  `TerminalXEnrollment.swift` was added (patch `f575a0c9…`), a clean offline
  rebuild produced arm64 `lume`, 22,007,592 bytes, SHA-256
  `91e404fad57bd506d2545d509295941253030e8dbf51ed84c898d3504eca042e`, again
  with only the linker's ad hoc signature and with no compiler errors or
  warnings in TerminalX sources. With the version-3 listener (patch
  `ba8d9424…`) the latest clean rebuild is 22,032,184 bytes, SHA-256
  `996cdc9381935c802efc9f86af2e8927e71c82e0be8c1e82b7d1f93fb53fbe09`; with the
  owner-mediated stop (patch `de251c45…`), 22,051,688 bytes, SHA-256
  `15b95b0ce2d45a684c113999615b0fcb47f0b6b1c663e60b4fbdd5fd6a7af59a`; with atomic
  record writes and the account-confirmation relay (patch `aa85a1d9…`), SHA-256
  `524ab87bc362862cfe1a412e092af8172e542f58f5f9dd793630b757ada1524a`; with the key
  grant (patch `88198099…`), SHA-256
  `6fe3cf29f6d5c35150cdf51b17760e0d9ec10a92d04b78f4ac61d8d1ab3ade61`; with the
  host-key observation (patch `85d79fd0…`), SHA-256
  `4023c44590199f8b404baa1f3332e1fb14ceb9868ebbf78cc7e43fe816e3b5be`; with the
  retirement acknowledgement and report (patch `257f8022…`, commit `f19d0cb5`),
  22,129,816 bytes, SHA-256
  `69933c32aec3b8e22d0e18a2e1793a3c592fb7c2262aac3cca7835918d9f009d`, with no
  compiler warnings or errors in TerminalX sources; with the read-only
  retirement record actions (patch `ef880012…`, commit `17011ad4`), 22,129,816
  bytes, SHA-256
  `3682708efb6864bd28fa2121a5724f564f64908ac1c108b7b0fe8cb07c58c6ea`, again
  with no warnings or errors in TerminalX sources.
  - As built it cannot host a VM. Upstream signs Lume with
    `com.apple.security.virtualization` (`resources/lume.entitlements` also adds
    `com.apple.vm.networking`), and only a reviewed signing step may add those
    entitlements.

## Reproducing

1. **Inputs.** Prepare the exact source and the 18 mirrors as above, then run
   the read-only preflight against them:

   ```sh
   python3 integrations/lume-bootstrap/offline_inputs.py \
     --source ~/.raccoon/vm-build/lume-3350f504/cua/libs/lume \
     --cache ~/.raccoon/vm-build/lume-3350f504
   ```

2. **Disposable tree.** Copy `libs/lume` into a fresh work directory and apply
   `bootstrap.patch` there. Point each locked URL at its local mirror with
   `swift package config set-mirror`, using the work directory's
   `--config-path`, `--security-path` and `--cache-path`.
3. **Build.** Deny network at the process boundary for the whole build. The
   command that produced the executable above was:

   ```sh
   sandbox-exec -p '(version 1)(allow default)(deny network*)' \
     swift build --package-path "$W/root/libs/lume" --scratch-path "$W/build" \
     --cache-path "$W/cache" --config-path "$W/config" --security-path "$W/security" \
     --disable-sandbox --disable-automatic-resolution --disable-prefetching \
     --disable-experimental-prebuilts --disable-netrc --disable-keychain \
     --configuration release --product lume
   ```

   - `--disable-sandbox` turns off only SwiftPM's own manifest sandbox. macOS
     refuses to nest it inside the outer sandbox (`sandbox_apply: Operation not
     permitted`), and the outer `deny network*` still covers every process.
   - `--disable-automatic-resolution` makes SwiftPM use exactly the locked
     revisions.
4. **Retain.** Keep compiler and linker output and the executable's digest and
   architecture. Do not run, sign, install or adopt the executable as part of
   this build proof.

Build logs, the fetch report and the preflight report are retained with the
PRO-114 evidence for 2026-10-30.
