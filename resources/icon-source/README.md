# TerminalX Legacy icon sources

Vendored from `dudhatparesh/terminalx-app-v3` at commit
`6e07f4ba0ab39dd61ae7cfc69cb53380ad38a47a` (MIT; see `LICENSE`):

| Upstream path | Local source |
| --- | --- |
| `resources/build/icon.icns` | `resources/icon-source/legacy.icns` |
| `mobile/assets/icon.png` | `mobile/assets/icon.png` |
| `mobile/assets/adaptive-icon.png` | `mobile/assets/adaptive-icon.png` |
| `resources/icon-source/icon.icon/Assets/logo.svg` | `resources/icon-source/logo.svg` |

The ICNS was built by Legacy's `resources/icon-source/generate.sh` from its
Icon Composer project. Its 16/32/64px slots are already trimmed; larger slots
retain the macOS inset. Keeping that compiled source avoids requiring Xcode
or regenerating the artwork differently on each machine.

The development badge geometry and colour follow Legacy's
`resources/icon-dev.png`: a 58px disc, 9px from the bottom/right of a 256px
canvas, filled `#ff6b2b`, with a white D and no outline.

`logo.svg` is the mark itself, the one layer of that Icon Composer project.
The phone app draws it from the same paths (`mobile/src/ui/TerminalXMark.tsx`,
held to this file by its test).

To update, copy those four files from the same Legacy revision, record its
commit here and in `THIRD-PARTY-NOTICES.md`, then follow the regeneration
commands in `docs/RELEASING.md`. Do not extract icons from `/Applications`.
