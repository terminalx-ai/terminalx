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
