# Releasing Raccoon

## One-time setup

- Updater signing keys live at `~/.tauri/raccoon.key` (private) and
  `~/.tauri/raccoon.key.pub`. The public key is already in
  `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. Losing the
  private key means shipped builds can never verify a later update; keep a
  copy somewhere safe.
- `plugins.updater.endpoints` in `tauri.conf.json` is a placeholder. Point it
  at wherever `latest.json` (below) will be hosted. For GitHub Releases:
  `https://github.com/<owner>/raccoon/releases/latest/download/latest.json`.

## Build

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/raccoon.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build
```

`pnpm tauri build` runs `tsc && vite build`, compiles the Rust side in
release mode, and writes to `src-tauri/target/release/bundle/`:

| Path | What |
| --- | --- |
| `macos/Raccoon.app` | The app, ad-hoc signed (`signingIdentity: "-"`) |
| `dmg/Raccoon_<version>_aarch64.dmg` | Disk image for distribution |
| `macos/Raccoon.app.tar.gz` | Updater artifact |
| `macos/Raccoon.app.tar.gz.sig` | Its signature, made with the private key |

Building into a separate target directory keeps a running `pnpm tauri dev`
undisturbed: prefix the command with
`CARGO_TARGET_DIR=$PWD/src-tauri/target/release-build`.

## Cut a version

1. Bump `version` in `package.json` and `src-tauri/tauri.conf.json` (keep them equal).
2. Add a section to `CHANGELOG.md`; the About tab renders it in the app.
3. Commit, tag `v<version>`, build as above.

## Publish the update feed

The updater fetches one JSON document and compares `version` with the
running app. Publish it next to the artifacts:

```json
{
  "version": "0.2.0",
  "notes": "One line the update dialog can show.",
  "pub_date": "2026-09-02T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of Raccoon.app.tar.gz.sig>",
      "url": "https://<host>/Raccoon.app.tar.gz"
    }
  }
}
```

The app sends `X-Raccoon-Channel: stable|beta` with the request, so a feed
can serve a different document per channel if it wants to.

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

- Ad-hoc signing means Gatekeeper will ask the first time the app opens on
  another Mac. A Developer ID identity and notarization replace `"-"` in
  `bundle.macOS.signingIdentity` when that matters.
- The `demo.html` page is dev-only; the production build ships `index.html`.
