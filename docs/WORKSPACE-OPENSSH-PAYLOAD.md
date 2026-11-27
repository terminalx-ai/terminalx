# Private workspace OpenSSH payload

The installer and updater use a detached OpenSSH signature over the exact
UTF-8 JSON manifest bytes. The release principal is `release@terminalx`. The
runtime verifies it with the baked TerminalX release public key and the
`terminalx-workspace-openssh` signature namespace. This namespace is shared
by the initial installer and updater.

```json
{
  "v": 1,
  "version": "9.6p1-terminalx.1",
  "artifacts": [
    {
      "arch": "x86_64",
      "locator": "openssh-9.6p1-terminalx.1-linux-x86_64.tar.gz",
      "sha256": "<64 lowercase hex digits>"
    },
    {
      "arch": "aarch64",
      "locator": "openssh-9.6p1-terminalx.1-linux-aarch64.tar.gz",
      "sha256": "<64 lowercase hex digits>"
    }
  ]
}
```

The artifact locator is a filename relative to the TerminalX release
channel. The manifest allows at most one artifact per architecture.
Versions use portable OpenSSH syntax and can carry a positive
`-terminalx.N` build revision. The minimum version is `9.6p1`.
The installer checks the current version again while holding its lock.

The artifact is one gzip member containing a TAR archive. Use relative paths,
numeric UID and GID zero, regular files and directories. Store linker and
executable dependencies as regular files in their final private locations.
The archive must include executable `usr/sbin/sshd`. Staging verifies the
compressed SHA-256 before extraction and bounds compressed bytes, expanded
bytes, and entry count. It publishes a version directory by rename under
the install lock. Activation has its own validation and changes `current`
only after a candidate passes.

## Local release tooling

`scripts/release/workspace-openssh.py track --index portable-index.html`
reports the newest supported version from a local copy of the upstream
portable-release inventory. Review and pin the source checksum separately.
The build command takes an existing source tarball and that checksum.
It never downloads source and does not accept a moving version.

Run `build` on the matching native Linux architecture against the workspace
base ABI. It requires the compiler and OpenSSH development dependencies plus
`readelf` and `patchelf`. Pass explicit `--library-dir` directories for
non-base runtime dependencies. The command compiles portable OpenSSH with
version-specific installation paths, stages it under a temporary DESTDIR
without generating host keys, and emits its compressed payload in the
specified local output directory. Base glibc and the ELF interpreter come
from the workspace image.

Collect the per-architecture payloads in one local directory and run
`manifest --version VERSION --arch x86_64 --arch aarch64 --output DIR`.
Add `--signing-key PATH` with a locally generated throwaway key to exercise
signing. The tool has no default signing key and does not upload anything.
Review the runtime integration separately with the installed private daemon.

See the [local builder README](../scripts/release/README-workspace-openssh.md)
for the two-architecture container runner and verification status.
