# Issue #166: delivered icon investigation

## Verified on 2026-09-16

| Surface/artifact | Evidence | Conclusion |
| --- | --- | --- |
| Installed macOS TerminalX | Version/build 0.2.4, `com.terminalx.next`, selects `icon.icns` | Selected ICNS matches the vendored Legacy source and installed Legacy 1.4.191 byte for byte |
| Persistent Dock target | TerminalX entry selects the installed Applications bundle with `com.terminalx.next` | This persistent entry does not point at an alternate checkout; transient running entries remain unverified |
| Local device Release `.app` in the release worktree's `mobile/dist/device-release/Build/Products/Release-iphoneos` | Version 0.1.0, build 1, `com.terminalx.next.mobile`; decoded `AppIcon60x60@2x.png` (120×120) and `AppIcon76x76@2x~ipad.png` (152×152) have R/G/B/A extrema `(255,255)` | **The packaged launcher PNGs really are entirely white** |
| Current release source/native catalog | Nonwhite opaque artwork; existing source checks pass | Correct source files do not repair an already-built `.app` |

Shared desktop ICNS SHA-256:

```text
31593193caf2549d02cd68b5f6a2463e2db215ee370a8bcff9fa2f72f6e8e8c4
```

Native `NSWorkspace.icon(forFile:)` renders of the two installed apps are
pixel-identical at 16, 32, 64, 256 and 512px. At 128px their alpha bounds both
equal `(6, 8, 122, 124)`; the maximum channel difference is 4/255 and the largest
mean channel difference is 0.00214/255. This probe shows no extra inset/border,
but it does not substitute for observing the affected Dock/Finder surface.

Old device artifact fingerprints (SHA-256):

```text
Info.plist: 2639b052aaea2b169ab5c01014e54f15924eb6e4d9366fedaaec21bb78a46531
AppIcon60x60@2x.png: cc407af7fd4d1b16e162e653275b36708156dfa2d55542126e12494ee02aa16f
AppIcon76x76@2x~ipad.png: 39ebdc292aef3caa299f2d77e140ae64049a37e6f72665c95dcf17ad755b21f5
Assets.car: f4631995cf75589253b89089c844596bd3ce159d42db66a83aa52db16f1ebd57
```

Reproduction with the old device artifact:

```sh
python3 scripts/verify_packaged_icons.py ios /path/to/device-release/TerminalX.app
# exit 1: Icon verification failed: AppIcon60x60@2x.png: solid-color placeholder
```

The packaged PNG timestamps are September 14, before icon fix commit `e0484d8`
(September 14 at 21:39 +04:00). This supports an artifact built before the fix,
but is not build provenance. Its exact source commit, build profile, and whether
this artifact was installed on the affected phone are **not established**.
The defect is present in this artifact without any phone cache being involved.

Desktop caching is **not confirmed**. No cache reset, reinstall, or resource
replacement was performed. A Finder view of a mounted installer showed dark
artwork with an inset, but it was not a same-size Legacy comparison. The
desktop control connection then became unavailable, preventing paired GUI
verification. The macOS inset in the identical Legacy resource is intentional;
an extra border on a specific surface still needs reproduction.

## Validation added

- `scripts/verify_packaged_icons.py`: read-only inspection of selected resources
  in built/extracted/installed `.app` bundles, with identity, version/build,
  resource hashes and iOS pixel checks. Device CgBI PNGs are decoded in temporary
  files so signed artifacts remain unchanged.
- `scripts/test_packaged_icons.py`: wrong selected catalog, white placeholder,
  wrong variant/bundle, missing compiled catalog, iPad primary icon, and desktop
  selected-resource regression checks.
- `scripts/test_compiled_icons.py`: isolated Expo variant switching and actual
  Apple asset compilation; CI also runs the existing source checks.
- The standalone simulator installer pins the production variant and checks
  packaged icons before any installation.

Source and packaged regression tests pass locally. Fresh full-app compilation
and the compiled-catalog integration test were attempted but are blocked by
the local Xcode 26.6 SDK/runtime mismatch:

```text
No simulator runtime version from ["22D8075", "23F73"] available
to use with iphonesimulator SDK version 23F81a
```

`xcodebuild` also rejects the generic simulator destination. The integration
check deliberately fails on this condition; no source-only fallback counts as
packaged validation. Fresh installation, upgrade, and D-badged home-screen
rendering remain pending on a compatible build host/device. Android packaged
launcher resources also remain unverified; the new artifact CLI covers Apple
bundles, while the existing source suite checks Android assets/configuration.

## Recovery, preserving data

### Mobile

1. Record platform, version/build, variant, bundle identifier, and installation
   method. Locate the exact installed artifact and build-time source commit.
   A development and release app currently share `com.terminalx.next.mobile`;
   badge appearance alone does not establish identity or build provenance.
2. Run the artifact verifier. If it fails, rebuild from the fixed revision,
   explicitly selecting `APP_VARIANT=production` or `development` for both
   prebuild and build. Regenerate the native project before building, even when
   it already exists. [Expo documents when native generation runs](https://docs.expo.dev/more/expo-cli/).
   Inspect the resolved config and generated catalog, then verify the exported
   artifact again. Increase the build number for the installation channel.
3. Install the verified build **over** the existing app using the same bundle
   identifier and signing/keychain identity. Preserve its container and paired
   credentials; do not uninstall, erase the device/simulator, or change bundle
   identifiers to force an icon refresh. Confirm existing pairings still work.
4. Inspect the home-screen icon after installation. If verified bytes are
   correct but the icon is still stale, first confirm the installed build, then
   try a normal device restart and repeat the observation. Record a cache cause
   only if the display changes while the artifact/resource is unchanged.

### Desktop

1. Record version, bundle ID, selected `CFBundleIconFile`, actual launched path,
   shortcut/Dock target, macOS version, view, and icon size. Compare TerminalX
   and Legacy side by side in the same Finder view and Dock size. Account for
   selection highlighting and the larger ICNS slots' intended transparent inset.
2. Verify the actual selected app with the artifact CLI. Compare Legacy using
   `--bundle-id com.terminalx`. Exact ICNS equality includes all native size slots.
3. If the target or bytes differ, replace/update the intended application
   bundle and correct the shortcut target. Preserve app data and settings.
4. Only when identity and resource checks pass, capture a before observation,
   quit/reopen the affected Finder window, and check again. For a stale Dock
   entry, remove only that shortcut and re-add the verified bundle. If still
   needed, `killall Dock` restarts the current user's Dock; record before/after
   and rerun the byte check. Schedule app relaunches around active sessions.
   Do not delete global cache directories or application data.
5. If an unchanged resource displays correctly after this controlled refresh,
   record the specific refresh as cache evidence. Otherwise continue with the
   bundle/rendering investigation; do not label it caching.

## Required release matrix (not yet completed)

For every row record artifact SHA-256, source commit, version/build, variant,
bundle ID, OS, installation route, visual result, and retained-pairing result.
Keep private paths, device IDs, and account information out of shared evidence.

| Platform/variant | Fresh installation on a disposable target | Upgrade over an earlier build |
| --- | --- | --- |
| iOS production | Intended full-bleed artwork | Intended artwork; existing pairings retained |
| iOS development | Intended D badge | D badge; existing pairings retained |
| Android production/development | Check packaged launcher/adaptive resources and both appearances | Both appearances and retained pairings |
| macOS release | Same-size Finder/Dock comparison with Legacy | Same comparison; record whether targeted refresh was needed |

Use a separate disposable simulator/device for fresh-install tests. Do not
turn the user's existing installation into a fresh-install test by deleting it.
