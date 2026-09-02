# Releasing TerminalX Next

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
a merge patch over `tauri.conf.json` — it changes three things and nothing else:

| Key | Dev value | What it moves |
| --- | --- | --- |
| `productName` | `TerminalX Next Dev` | The Dock label, the app menu, ⌘-Tab |
| `identifier` | `com.terminalx.next.dev` | macOS permission grants and per-app state |
| `bundle.icon` | `icons-dev/*` | The Dock icon: the app icon with an amber "D" badge |

So a dev build and an installed release can sit in the Dock together and stay
apart at a glance.

The release identity is deliberately `TerminalX Next` / `com.terminalx.next`,
and it registers only `terminalx-next://`. Keep it separate from TerminalX's
name, identifier, and URL scheme until the explicit parity cutover.

The separate identifier is what keeps the two from stepping on each other in
macOS itself. TCC keys microphone and speech-recognition consent by bundle
identifier, so `TerminalX Next Dev` gets its own rows under Privacy & Security:
revoking or re-prompting dev leaves the installed release alone, and vice
versa. Anything else macOS scopes per identifier (saved window state, launch
services registration) is likewise separate.

What the identifier does *not* move is TerminalX Next's own data. The store still
lives in `~/.raccoon` for both builds, and `RACCOON_HOME` is still the only
thing that points it elsewhere:

```sh
RACCOON_HOME=~/.raccoon-dev pnpm tauri:dev
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
the amber "N" badge, the `TerminalX Next` name, and the `com.terminalx.next`
identifier.

### Regenerating the badged icons

`src-tauri/icons/` and `src-tauri/icons-dev/` are generated and committed, so
a fresh clone can build without the predecessor installed. To regenerate both
sets from the installed TerminalX icon:

```sh
python3 scripts/badge-dev-icon.py
pnpm tauri icon src-tauri/icons/app-icon-next.png --output src-tauri/icons
pnpm tauri icon src-tauri/icons-dev/app-icon-next-dev.png --output src-tauri/icons-dev
rm -rf src-tauri/icons-dev/android src-tauri/icons-dev/ios \
       src-tauri/icons-dev/Square*Logo.png src-tauri/icons-dev/StoreLogo.png
```

The script needs Pillow (`pip install pillow`). It extracts the largest
PNG-encoded entry from
`/Applications/TerminalX.app/Contents/Resources/icon.icns`, composites "N" and
"D" badges in the app's own amber accent, and writes the two 1024px masters;
the same source, fonts, and Pillow version produce the same bytes. The final
command drops mobile and Windows Store output from the dev set, which a macOS
dev build never loads.

## Build

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/raccoon.key)"
read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD  # the password set at key generation
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
pnpm tauri build
```

`pnpm tauri build` runs `tsc && vite build`, compiles the Rust side in
release mode, and writes to `src-tauri/target/release/bundle/`:

| Path | What |
| --- | --- |
| `macos/TerminalX Next.app` | The app, ad-hoc signed (`signingIdentity: "-"`) |
| `dmg/TerminalX Next_<version>_aarch64.dmg` | Disk image for distribution |
| `macos/TerminalX Next.app.tar.gz` | Updater artifact |
| `macos/TerminalX Next.app.tar.gz.sig` | Its signature, made with the private key |

Building into a separate target directory keeps a running `pnpm tauri:dev`
undisturbed: prefix the command with
`CARGO_TARGET_DIR=$PWD/src-tauri/target/release-build`.

## Cut a version

1. Bump `version` in `package.json` and `src-tauri/tauri.conf.json` (keep them equal).
2. Add a section to `CHANGELOG.md`; the About tab renders it in the app.
3. Commit, tag `v<version>`, build as above.

## Publish the update feed

The updater fetches one JSON document and compares `version` with the
running app. Attach it to the GitHub Release as `latest.json`, alongside
`TerminalX Next.app.tar.gz` and the `.dmg`, and mark that release latest — the
endpoint's `/releases/latest/download/` resolves to whichever release that
is:

```json
{
  "version": "0.2.0",
  "notes": "One line the update dialog can show.",
  "pub_date": "2026-09-02T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of TerminalX Next.app.tar.gz.sig>",
      "url": "https://github.com/terminalx-ai/raccoon/releases/download/v0.2.0/TerminalX%20Next.app.tar.gz"
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

The check only ever happens when the reader presses "Check for updates" in
Settings → About. Nothing runs on launch or on a timer.

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

- Ad-hoc signing means Gatekeeper will ask the first time the app opens on
  another Mac. A Developer ID identity and notarization replace `"-"` in
  `bundle.macOS.signingIdentity` when that matters.
- The `demo.html` page is dev-only; the production build ships `index.html`.
