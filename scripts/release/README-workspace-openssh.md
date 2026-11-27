# Build the private OpenSSH payloads locally

The ARM64 build of OpenSSH 9.6p1 completed on Ubuntu 24.04. The packaged
daemon passed `sshd -V` and `sshd -t` in a separate ARM64 container. The
Workspace OpenSSH payload PR workflow runs the corresponding AMD64 build
and checks on Ubuntu 24.04. It publishes no artifacts. The local unit tests
exercise release inventory, packaging and signature handling with fixtures.

Run the two builds from a clean local output directory:

```sh
scripts/release/build-workspace-openssh-local.sh \
  9.6p1-terminalx.1 /local/openssh-9.6p1.tar.gz SOURCE_SHA256 /local/empty-output \
  LOCAL_AMD64_BUILDER LOCAL_ARM64_BUILDER
```

Preload each Linux builder image for the stated architecture. Use the
workspace's base ABI and include Python 3, a C compiler, make, the OpenSSL
and zlib development libraries, binutils, and patchelf. Docker must already
be able to run both architectures, either natively or via local emulation.
The script uses `--pull never` and disables container networking. It streams
the pinned source and release tool into each isolated builder. It builds
sequentially and leaves two payloads and an unsigned manifest on disk.

The workspace runtime reads the signed manifest and assets from the
`workspace-openssh` release tag. Building them locally or checking a pull
request does not upload or replace any release assets.
