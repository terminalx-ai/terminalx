# Exact candidate build inputs

The full Lume candidate has **not** been compiled. The existing Swift 6.3.3
arm64 macOS26 toolchain can parse/typecheck the focused adapter and compile the
native protocol fixture. That is not a full upstream executable build.

The read-only preflight is reproducible:

```sh
python3 integrations/lume-bootstrap/offline_inputs.py --source /tmp/pro114-lume-owner-base
```

This run found only the previously retained partial upstream source, without the
complete `libs/lume` resources, CZlib system-library target, tests or upstream
lockfile in that source directory. No complete exact checkout was available in
the inspected retained source. The standard SwiftPM caches contained manifest
cache data, but no repositories with any of the **18 required pinned revisions**.
The report lists every missing identity, repository and exact revision.

[Upstream.Package.resolved](Upstream.Package.resolved) is an unchanged copy of the
[lockfile at the exact upstream commit](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/Package.resolved).
Its SHA256 is `b954aab87b35bfa16422dad4563abfd4d4d61df0d45e62d084923fa22246465b`.
It is source evidence only: no dependency or installed profile was resolved or
modified. In particular, the manifest's branch/range declarations do not permit
substituting current branch tips for these locked revisions.

After those missing inputs are separately supplied, the reproducible build plan
is:

1. Prepare a disposable, clean checkout of Cua commit
   `3350f504014c85416009a90fcb339fe556ce02fc`, including the complete `libs/lume`
   tree. Verify its lockfile bytes against the retained hash. Prepare a separate
   offline SwiftPM workspace/cache containing all 18 exact locked repositories
   and their checked-out source, preserving verified revision identities. Do not
   use the installed Lume profile or alter shared caches.
2. Run the read-only preflight against those explicit source/cache paths. Retain
   source/tree/lock/dependency hashes and toolchain/SDK versions. Apply
   `bootstrap.patch` only to that disposable exact checkout; retain its digest.
3. Deny network access at the process boundary for the entire build. On a host
   with Apple's existing `sandbox-exec`, the intended command form is below.
   Confirm tool availability and isolate all writable paths before executing it.
   `--skip-update` and `--disable-automatic-resolution` alone are **not** an
   offline guarantee: SwiftPM could otherwise fetch missing locked sources.

```sh
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  swift build --package-path /private/tmp/reviewed-cua/libs/lume \
  --scratch-path /private/tmp/reviewed-lume-build \
  --cache-path /private/tmp/reviewed-lume-cache \
  --disable-automatic-resolution --skip-update --disable-prefetching \
  --disable-experimental-prebuilts --disable-netrc --disable-keychain \
  --configuration release --product lume
```

4. Retain compiler/linker output and the unsigned executable's digest and
   architecture. A complete successful build must include the real Run,
   LumeController, VM, virtualization implementation and dependency graph, with
   no interface stubs or fixture flag. Do not run, sign, install or adopt the
   executable as part of this build proof. Signature/catalog review and live
   acceptance remain later gates.

No full build was attempted with missing inputs. No resolver, dependency fetch,
package installation, CI, container, signing or live operation was invoked.
