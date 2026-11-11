# Releasing TerminalX

## One-time setup

- Updater signing keys live at `~/.tauri/raccoon.key` (private) and
  `~/.tauri/raccoon.key.pub`, made once with `pnpm tauri signer generate -w
  ~/.tauri/raccoon.key`. The public key is already in
  `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. Losing the
  private key means shipped builds can never verify a later update; keep a
  copy somewhere safe.
- The private key is encrypted with the password chosen when it was
  generated. That password is never written down here or anywhere else in the
  repository — it is supplied to a build through
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, out of whatever password manager or
  CI secret holds it.
- Release builds are signed with a **Developer ID Application** certificate,
  whose private key is in the login keychain. The release scripts use
  `APPLE_SIGNING_IDENTITY` when it is set, and otherwise the one Developer ID
  Application identity `security find-identity -v -p codesigning` lists; with
  none or several they stop and say so. No identity or team ID is written in
  the repository.
- Notarization uses an **App Store Connect API key** (Users and Access →
  Integrations → Team Keys, role Developer). Its `.p8` file stays where it was
  downloaded; `~/.appstoreconnect/terminalx-notary.json` (or the file named by
  `TERMINALX_NOTARY_CONFIG`) says where it is:

  ```json
  { "keyPath": "<path to AuthKey_<key ID>.p8>", "keyId": "<key ID>", "issuerId": "<issuer ID>" }
  ```

  The scripts read the key file's path, ID and issuer from there at run time.
  The key, its ID and the issuer never go in the repository, which is public.
- `scripts/release/` reads the updater key from `~/.tauri/raccoon.key` (or
  `TERMINALX_UPDATER_KEY`) and its password from
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Every step stops with a message naming
  the missing file or variable when a credential is absent.
- `plugins.updater.endpoints` in `tauri.conf.json` points at
  `https://github.com/terminalx-ai/raccoon/releases/latest/download/latest.json`
  — the `latest.json` below, attached to whichever GitHub Release is marked
  latest. Change it if the repository moves; nothing else about the feed
  depends on the host.

## Run the dev build

```sh
pnpm tauri:dev
```

That is `tauri dev --config src-tauri/tauri.dev.conf.json`. The extra config is
a merge patch over `tauri.conf.json`. Its app identity overrides include:

| Key | Dev value | What it moves |
| --- | --- | --- |
| `productName` | `TerminalX Dev` | The Dock label, the app menu, ⌘-Tab |
| `identifier` | `com.terminalx.next.dev` | macOS permission grants and per-app state |
| `bundle.icon` | `icons-dev/*` | The Dock icon: the app icon with an orange circular "D" badge |
| `plugins.deep-link.desktop.schemes` | `["terminalx-dev"]` | Launch and sign-in links belong to Dev alone |

So a dev build and an installed release can sit in the Dock together and stay
apart at a glance.

The release identity is `TerminalX` / `com.terminalx.next`, and it registers
`terminalx://`. The bundle identifier deliberately keeps its `.next` suffix
because the predecessor owns `com.terminalx`; macOS cannot install two apps
with the same identifier. The release handler continues to recognize
`terminalx-next://` URLs for old installs, but the bundle no longer registers
that scheme. Dev registers and accepts only `terminalx-dev://`. Callback URIs
are selected from the Tauri bundle identity, including when a Dev bundle is
built with Cargo's release profile.

The server must accept `terminalx-dev://auth/callback` before this app change
ships. Deploy the coordinated console/API change in `dudhatparesh/terminalx-saas`
first. Dev authorize requests include `app=dev`; `legacy=1` is reserved for
callers that need a Legacy hand-off. Both flags affect button visibility only.
No flag means only **Open TerminalX**. The main button always uses `terminalx://`.

Previously installed Dev bundles may have left a `terminalx://` registration
in macOS Launch Services. Test with updated Dev and release bundles; stale
registrations from old Dev bundles or other local copies may need clearing.

The separate identifier is what keeps the two from stepping on each other in
macOS itself. TCC keys microphone and speech-recognition consent by bundle
identifier, so `TerminalX Dev` gets its own rows under Privacy & Security:
revoking or re-prompting dev leaves the installed release alone, and vice
versa. Anything else macOS scopes per identifier (saved window state, launch
services registration) is likewise separate.

What the identifier does *not* move is TerminalX's own data. The store still
lives in `~/.raccoon` for both builds, and `TERMINALX_HOME` is still the only
thing that points it elsewhere:

```sh
TERMINALX_HOME=~/.raccoon-dev pnpm tauri:dev
```

Two notes on the mechanics:

- The Dock icon comes from the config alone, no Rust involved. In a dev build
  Tauri embeds the `.icns` named in `bundle.icon` and hands it to
  `setApplicationIconImage` once the app is ready, which is why `tauri dev`
  shows a real icon even though it runs a bare binary with no `.app` around it.
- Cargo re-runs the Tauri build script when `TAURI_CONFIG` changes, and the
  `--config` flag sets it. Alternating `pnpm tauri:dev` and `pnpm tauri build`
  in the same target directory therefore rebuilds the crate each time; give
  the release build its own `CARGO_TARGET_DIR` (below) to avoid that.

`pnpm tauri build` reads only `tauri.conf.json`, so the shipped bundle keeps
the unbadged Legacy icon, the `TerminalX` name, and the `com.terminalx.next`
identifier.

### Regenerating the app icons

The source artwork and all generated assets are committed. A fresh clone needs
neither an installed predecessor nor Xcode to regenerate desktop/Tauri assets.
On macOS, with `iconutil`, Pillow (`python3 -m pip install Pillow==11.1.0`), and
repo dependencies (`pnpm install`), run:

```sh
python3 scripts/badge-dev-icon.py
APP_VARIANT=production pnpm --dir mobile exec expo prebuild --platform ios --no-install --no-clean
python3 scripts/test_icons.py
```

`resources/icon-source/legacy.icns` is the unmodified compiled Legacy icon;
its provenance and update procedure are in `resources/icon-source/README.md`.
Release copies it byte-for-byte, preserving the trimmed 16/32/64px Finder
slots and the safe-area inset in larger macOS slots. Dev badges each native
slot with Legacy's orange disc and white "D", then trims the small slots.
The script also saves the inset `app-icon.png` / `app-icon-dev.png` masters.
Windows ICOs and Linux/Store PNGs are generated from trimmed desktop artwork.
Do not run `tauri icon` directly into the committed directories: that would
replace the macOS slot treatment and generate mobile icons from desktop art.

`mobile/assets/icon.png` and `adaptive-icon.png` are the original Legacy
mobile sources. The script makes their dev variants and regenerates **both**
Tauri mobile sets from these mobile assets. iOS uses an opaque, full-bleed
background; Android uses the transparent foreground with `#111111` behind it.
The mobile badge stays inside the system mask's safe area.

Expo reads these paths through `mobile/app.json`. `mobile/app.config.js` selects
the D-badged assets when `APP_VARIANT=development`, as set by the EAS development
profile and `pnpm --dir mobile ios`. Preview/default builds remain unbadged.
This follows [Expo's app variant configuration](https://docs.expo.dev/build-reference/variants/).
Refresh an existing native project with prebuild whenever changing variants;
JavaScript reloads cannot update an installed home-screen icon.

The release Xcode `AppIcon.appiconset` is committed; the rest of `mobile/ios`
remains generated and ignored. After checking a dev prebuild, run the production
prebuild command above to restore the release catalog before committing.
Commit the sources, desktop sets, mobile assets, and release catalog together.
The same source, macOS fonts, Pillow, and pinned Tauri CLI yield the same pixels.

### Validate the delivered icons

Install Pillow (`python3 -m pip install Pillow==11.1.0`). CI runs the source
checks, packaged-metadata regression tests, and an isolated Expo prebuild →
Apple `actool` check. The latter switches production → development → production
to catch native catalog reuse; it requires Xcode with a compatible simulator
runtime. Its compiled catalogs are test fixtures, not installable app builds.

Before publishing, verify the **final extracted artifact**, not only the source
tree or a neighboring build directory:

```sh
# macOS: extract the updater archive, or select the .app on the mounted DMG.
python3 scripts/verify_packaged_icons.py macos /path/to/extracted/TerminalX.app

# iOS: extract the IPA with Archive Utility/ditto and select Payload/TerminalX.app.
python3 scripts/verify_packaged_icons.py ios /path/to/Payload/TerminalX.app
# For a development artifact:
python3 scripts/verify_packaged_icons.py ios /path/to/TerminalX.app --variant development
```

The verifier follows `Info.plist`'s selected icon filenames and checks bundle
identity. iOS checks reject blank, transparent, padded, wrong-artwork, and
wrong-badge PNGs, including Apple-optimized device PNGs. macOS requires the
selected ICNS to match Legacy exactly (or the dev ICNS for development).
An unsupported catalog-only layout fails instead of reporting success without
checking pixels. `Assets.car` is required and hashed; its internal renditions
and system rendering still need the visual check below.

Save the JSON result with the artifact's SHA-256, source commit, dirty-tree
status, resolved Expo config, variant, build command/profile, and installation
method. Record the source commit **at build time**; the current checkout and
file timestamps cannot establish an older artifact's source commit. Keep
signing credentials and device/account identifiers out of shared reports.

Complete the [fresh-install and upgrade matrix](testing/issue-166-icons.md)
before claiming the installed icon is fixed. A passing asset check cannot
prove which artifact is installed on a phone or what Dock/Finder currently
displays. `pnpm --dir mobile ios:simulator` now fixes `APP_VARIANT=production`
through prebuild/build and verifies packaged icons before installing; install
Pillow before using it. The development `ios` command still uses its D badge.

## Build

A release is built, notarized and published by the release pipeline below.
A plain local build, signed ad hoc and not notarized, is:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/raccoon.key)"
read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD  # the password set at key generation
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
pnpm tauri build
```

`pnpm tauri build` first builds and signs the computer-use helper
(`pnpm build:computer-macos`, see [COMPUTER-USE.md](COMPUTER-USE.md)), then
runs `tsc && vite build`, compiles the Rust side in release mode, and writes
to `src-tauri/target/release/bundle/`:

| Path | What |
| --- | --- |
| `macos/TerminalX.app` | The app, signed ad hoc (`signingIdentity: "-"`); a release build signs it with the Developer ID and notarizes it |
| `macos/TerminalX.app/Contents/MacOS/terminalx` | A tiny launcher for the app's built-in CLI command family |
| `macos/TerminalX.app/Contents/Resources/TerminalX Computer Use Helper.app` | The signed computer-use helper that owns the Accessibility and Screen Recording grants |
| `dmg/TerminalX_<version>_aarch64.dmg` | Disk image for distribution |
| `macos/TerminalX.app.tar.gz` | Updater artifact |
| `macos/TerminalX.app.tar.gz.sig` | Its signature, made with the private key |

Tauri derives the `.app`, `.dmg`, updater archive, and signature names from
`productName`. The matching signature source and artifact URL inside
`latest.json` must use these exact TerminalX filenames too.

Building into a separate target directory keeps a running `pnpm tauri:dev`
undisturbed: prefix the command with
`CARGO_TARGET_DIR=$PWD/src-tauri/target/release-build`.

## Cut a version

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (keep all three equal), then refresh the lock entry
   with `cargo update -p raccoon` in `src-tauri`. The About tab reads
   `tauri.conf.json`; `terminalx --version`, the pairing handshake and the
   agent client hellos read `CARGO_PKG_VERSION` from `Cargo.toml`.
2. Add a section to `CHANGELOG.md`; the About tab renders it in the app.
3. Commit on `main` and run the release pipeline (next section). It tags
   `v<version>` itself, after every check has passed.

## The release pipeline

`scripts/release/release.py` builds, notarizes, verifies, scans and publishes
a release. Run it from the repository root on `main`, on the version and
changelog commit. Its working directory is the git-ignored
`.raccoon/release-<version>/`, and the Cargo target directory is
`~/Library/Caches/terminalx-release-<version>` (`TERMINALX_RELEASE_TARGET_DIR`
moves it):

```sh
python3 -I scripts/release/release.py prepare
$EDITOR .raccoon/release-<version>/notes.md      # the GitHub release notes
python3 -I scripts/release/release.py publish --dry-run   # after the steps below
python3 -I scripts/release/release.py all        # check through verify-live
```

`all` runs the steps in this order and stops at the first failure. Each step
can also be run by name. Each one writes a record, and a later step refuses to
run on a record that is missing, failed, or for another commit:

| Step | What it does | Record |
| --- | --- | --- |
| `prepare` | Requires a clean `main` that contains `origin/main`, equal versions in the three files and a `## <version>` changelog section; pins the source commit | `release-context.json` |
| `check` | The project's checks on that commit: TypeScript, frontend and mobile tests, these scripts' tests, icons, the frontend build, WebKit layout, Swift, Clippy, desktop Rust tests and the runtime (serve) tests | `release-checks.json`, `<check>.log` |
| `build` | `pnpm tauri build --bundles app,dmg` with the Developer ID identity, the updater key and the App Store Connect key. Tauri notarizes and staples the app before it packages the DMG and the updater archive. A rejected notarization fails the build | `build-metadata.json`, `build.log` |
| `notarize` | Requires the app to be stapled and rated `Notarized Developer ID`, submits the DMG with `notarytool --wait`, staples it and checks it with `stapler validate` and `spctl`; records the stapled DMG's SHA-256 | `notarization.json`, `notarization-dmg-log.json` |
| `verify` | Extracts the updater archive and mounts the DMG: Developer ID signatures on the app, helper, runtime, launcher and DMG; stapled tickets on the DMG, on the app inside it and on the app inside the updater archive; version, bundle ID, icons, entitlements, runtime self-test, updater signature; and the same files in the DMG as in the archive | `artifact-verification.json` |
| `assemble` | Collects the six assets (below) and checks them | `assets/` |
| `scan` | The secret scan (below) | `secret-scan.json` |
| `publish` | Checks every record again, then tags, pushes `main` and the tag atomically, uploads a draft release, downloads it back and compares it byte for byte, and only then marks it Latest | `upload-verification.json`, `release-result.json` |
| `verify-live` | Downloads what users and installed apps now get: the update feed, its archive and signature, and the stable DMG link. Each must match the published file, and the downloaded DMG must still be stapled and rated `Notarized Developer ID` | `live-verification.json` |

Nothing is pushed or uploaded unless the checks, the build, notarization and
stapling of the app and the DMG, artifact verification and the secret scan
have all passed on the pinned commit. The published DMG must also be the one
whose SHA-256 the notarize step recorded. `publish --dry-run` runs all of
those gates and prints the tag, push and `gh release` commands without running
them; `--dry-run` applies to no other step, since building and notarizing
submit to Apple.

`python3 -I scripts/release/release.py check-dmg <path>` is read-only. It
validates the stapled tickets on any DMG and on the app inside it, and runs
Gatekeeper's assessment of both. Run it on a downloaded release to confirm
what a new Mac will see.

The scripts' tests use a fake command runner, so they run anywhere, macOS or
not. The `check` step runs them before every release; run them after changing
`scripts/release/`:

```sh
python3 -m unittest discover -s scripts/release -p 'test_*.py'
```

### Release assets and the stable download link

Every release uploads six files:

| Asset | What |
| --- | --- |
| `TerminalX_<version>_aarch64.dmg` | The notarized, stapled disk image |
| `TerminalX-latest-aarch64.dmg` | The same DMG, byte for byte, under a name that never changes |
| `TerminalX.app.tar.gz` | The updater archive (the same notarized, stapled app) |
| `TerminalX.app.tar.gz.sig` | Its updater signature |
| `latest.json` | The update feed document (next section) |
| `SHA256SUMS` | SHA-256 of the other five |

Because the fixed-name copy is attached to every release, this link always
downloads the newest notarized build. The website and the README link to it:

<https://github.com/terminalx-ai/terminalx/releases/latest/download/TerminalX-latest-aarch64.dmg>

`assemble`, `publish` and `verify-live` each require the two DMGs to be
identical and listed in `SHA256SUMS`. The in-app updater installs the app
from `TerminalX.app.tar.gz`. `verify` checks that this is the same stapled app
the DMG holds, so the download link and the updater ship the same notarized
build.

### The secret scan

The repository and its releases are public. `scan` looks through everything a
release publishes: the diffs and messages of the commits on top of the
`origin/main` that `prepare` recorded, the release notes, every asset, every
file inside the extracted updater archive, and every file in the mounted DMG.
It searches for:

- this machine's own secrets, read at run time and never printed: the App
  Store Connect key body, key ID and issuer ID, the updater signing key and
  its password, the `gh` token, and the Linear API key in
  `~/.raccoon/settings.json`;
- the current user's home directory path, in commits and notes only (built
  binaries legitimately embed build paths);
- private key blocks and GitHub, Linear, Anthropic/OpenAI, AWS and Slack
  token patterns.

It records only where a match is and which kind it is, never the value.
`publish` refuses a scan that found anything, that did not include the assets,
that ran on another commit, or that is older than any asset or the notes. To
check a branch before a release, scan only its commits:

```sh
python3 -I scripts/release/release.py scan --commits-only --base origin/main
```

## Publish the update feed

The updater fetches one JSON document and compares `version` with the
running app. The `assemble` step writes it as `latest.json`, and `publish`
attaches it to the GitHub Release alongside the other assets and marks that
release latest. The endpoint's `/releases/latest/download/` resolves to
whichever release that is:

```json
{
  "version": "0.2.0",
  "notes": "One line the update dialog can show.",
  "pub_date": "2026-09-02T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of TerminalX.app.tar.gz.sig>",
      "url": "https://github.com/terminalx-ai/raccoon/releases/download/v0.2.0/TerminalX.app.tar.gz"
    }
  }
}
```

The artifact URL names its own tag rather than `latest`, so an installer
already downloading keeps working after the next release moves the pointer.

The app sends `X-Raccoon-Channel: stable|beta` with the request. GitHub
Releases serves one document to everyone and ignores the header; a feed
hosted somewhere that reads headers could serve a different document per
channel.

Release builds check shortly after launch and every four hours. Readers can
also check manually in Settings → About. An available update appears in the
sidebar and a dismissible notice; installation requires Update and relaunch.
Development builds skip the background checks.

## The cloud runtime (`terminalx-serve`)

Cloud workspaces run the headless `terminalx-serve` binary, not the desktop
app. The TerminalX cloud server downloads it from this repository's
**runtime-only prereleases**, which `.github/workflows/release-serve.yml`
publishes from `main`. They need no updater signing key, and desktop releases
do not carry the runtime at all.

### Runtime prereleases

After the CI workflow succeeds on a push to `main` (or when the workflow is
run by hand from `main`), the `plan` job publishes only if **all** of these
hold, and otherwise skips:

- the commit is on `main`: the current tip or an ancestor of it;
- it is a **strict descendant** of the newest runtime prerelease's commit (or
  there is none yet), so re-running an old CI or release run, or a CI run
  that finishes out of order, can never publish older code.

There is no path filter: the serve build also compiles files outside
`src-tauri/` (`src/lib/mediaTypes.json`, `src/lib/repo.ts`), and the
descendant rule already prevents duplicate publishes, so every newer `main`
commit that passes CI gets a runtime prerelease.

It then:

1. builds `src-tauri/serve` in release mode on Ubuntu 22.04 for x86-64 and
   arm64 (glibc floor 2.35 or lower: Ubuntu 22.04 and 24.04, Debian 12; the
   job log prints the highest `GLIBC_` symbol the binary needs);
2. runs each binary's `--self-test` (start, shell PTY, clean exit);
3. checks again, now serialized with every other publish, that the commit is
   `ahead` of the newest runtime prerelease (GitHub compare API), and creates
   a **prerelease** tagged
   `runtime-v<serve crate version>-<commit's UTC committer time yyyymmddHHMMSS>-<7-char commit>`,
   e.g. `runtime-v0.2.2-20260929121810-3001736`, with
   `terminalx-serve-linux-x64`, `terminalx-serve-linux-arm64`,
   `terminalx-serve.json` and `SHA256SUMS`;
4. deletes runtime prereleases (and their tags) beyond the newest 10.

The timestamp is the commit's, not the run's, so a tag says when its code was
committed. Runtime prereleases are created with `--prerelease
--latest=false`, so they are never the release that
`/releases/latest/download/latest.json` resolves to and cannot affect the
desktop auto-updater. Pruning only ever touches prereleases whose tag matches
`^runtime-v[0-9]+\.[0-9]+\.[0-9]+-[0-9]{14}-[0-9a-f]{7}$`.

The build job runs every dependency's build script and the built binary, so
it gets a read-only token and no `GH_TOKEN`; only the publish job can write,
checkouts never persist credentials, and actions are pinned by commit SHA.

To publish by hand (for example when CI on `main` is red for an unrelated
reason), run the workflow from `main`; it applies the same rules:

```sh
gh workflow run release-serve.yml --ref main
```

### `terminalx-serve.json` and the runtime protocol

```json
{ "version": "0.2.2", "protocol": 1, "commit": "<40-char sha>", "builtAt": "2026-09-29T12:18:10Z" }
```

`protocol` comes from `[package.metadata.terminalx] runtime-protocol` in
`src-tauri/serve/Cargo.toml`. A cloud server installs only runtimes whose
protocol lies between its `MIN_RUNTIME_PROTOCOL` and `MAX_RUNTIME_PROTOCOL`
(the protocol it implements). **Bump it whenever a runtime change needs a
matching server** (bootstrap, launch intents, the runtime API). Servers that
do not implement the new protocol yet keep their last compatible runtime until
they are upgraded to one whose `MAX_RUNTIME_PROTOCOL` includes it. Protocol 1 is the
first runtime with launch intents and the serve bootstrap.
Protocol 2 adds scheduled runs (PRO-37): the server's
`CLOUD_SCHEDULED_RUNS_MIN_RUNTIME_PROTOCOL` names it, and a server must accept
protocol 2 before a runtime built with it is released.

The server only considers runtime prereleases. It picks the newest (by tag
timestamp) whose protocol is within the range it implements, and never
replaces its active runtime with a commit that is not a descendant of the
active one, unless an operator pins that exact release.

### Building it locally

To build it for x86-64 from an Apple Silicon Mac, cross-compile in Docker
rather than emulating amd64 (the linker segfaults under QEMU):

```sh
docker run --rm -v "$PWD":/src -w /src/src-tauri/serve rust:1-bookworm bash -c '
  dpkg --add-architecture amd64 && apt-get update &&
  apt-get install -y gcc-x86-64-linux-gnu libssl-dev:amd64 &&
  rustup target add x86_64-unknown-linux-gnu &&
  PKG_CONFIG_ALLOW_CROSS=1 CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    cargo build --locked --release --bin terminalx-serve --target x86_64-unknown-linux-gnu'
```

Check its glibc floor before running it on an older host
(`x86_64-linux-gnu-objdump -T … | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1`;
2.34 as of 0.2.2). The release workflow's build is the one to ship.

## Notes

- The build script links clang's builtins archive (`libclang_rt.osx.a` from
  the active Xcode toolchain) because the local transcription engine's Metal
  code uses `@available` checks; without it a release link fails on
  `___isPlatformVersionAtLeast`. Command line tools alone may lack the
  archive; a full Xcode install has it.
- Microphone and speech usage strings live in `src-tauri/Info.plist`. Cargo
  only re-runs the Tauri build script when a declared input changes, so after
  editing that file force a rebuild (`touch src-tauri/tauri.conf.json`) or the
  dev binary keeps the old plist and macOS will kill the process on the first
  microphone or speech request.

- The bundle is signed with the hardened runtime, so microphone access needs
  the `com.apple.security.device.audio-input` entitlement from
  `src-tauri/Entitlements.plist` (wired in through
  `bundle.macOS.entitlements`). Without it macOS neither prompts nor records:
  no permission dialog appears, no Microphone row shows up under Privacy &
  Security, and CoreAudio hands the app an endless stream of zeroes, so every
  dictation comes back empty. The usage strings above are necessary but not
  sufficient once the runtime is hardened.

- `bundle.macOS.signingIdentity` stays `"-"` (ad hoc) in `tauri.conf.json`, so
  local builds need no certificate. Gatekeeper asks before opening such a build
  on another Mac. The `build` step overrides the identity with the Developer
  ID, and release builds are notarized and stapled, so they open without a
  warning. Releases have been notarized since 0.2.27; 0.2.25 and earlier were
  only signed.
- The `demo.html` page is dev-only; the production build ships `index.html`.

### Native CLI launcher

The macOS `Contents/MacOS/terminalx` sidecar is generated from
`native/terminalx-launcher/main.rs` by `pnpm build:terminalx-launcher`. Tauri's
build/dev hooks select its full target and profile; universal builds combine
both architecture slices. Direct desktop Cargo checks build the same real
launcher with Cargo's target. Generated executables are ignored, never committed.

The launcher executes its sibling `raccoon terminalx` without a forwarding
process. Its Mach-O signature is embedded in executable bytes, unlike the old
shell launcher's extended-attribute signature, which the updater's tar route
did not retain. Tauri signs the sidecar with the rest of the bundle. Verify the
**extracted updater payload**, not only the app before archiving, with
`codesign --verify --deep --strict`. Linux and Windows retain their existing
platform-specific CLI installation paths.

Run `pnpm test:terminalx-launcher` for forwarding, failure, signal and build-plan
coverage. `native/terminalx-launcher/test-archive.py` accepts an existing signed
bundle, generated launcher and the attested normal-Tauri archive replay probe;
it signs only a fresh disposable copy and verifies the extracted result.
