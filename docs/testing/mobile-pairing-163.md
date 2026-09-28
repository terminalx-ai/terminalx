# Mobile pairing investigation (#163)

## Status

The user reported **successful pairing on the physical iPhone** after an earlier
manual-code failure and an observed expired-offer rejection. On build 163, the
phone log confirms `Pairing completed` / `Host saved`, storage contains one host,
and subsequent connection entries report the **direct** path. The user confirmed
using pasted code on the same Wi-Fi with TerminalX Relay selected, and separately
confirmed that relay pairing worked on a different network. Cross-network
manual pairing is user-confirmed; the captured log independently confirms the
earlier direct connections but does not contain a relay-path entry.
The original QR looked sharp but produced **no response**. After testing the
larger rendering, the user reported **“bigger QR worked”** and explicitly
confirmed **“It completed the pairing.”** The larger QR therefore decoded and
completed pairing on the physical phone. This result is user-confirmed; the
phone was disconnected when the follow-up log read was attempted. Dedicated autofocus/reopen checks, cold
restart persistence, and session access remain unverified.

The successful QR test used a local preview with the same rendering settings as
the desktop source change. A local desktop app was subsequently built and
verified on 2026-09-28 (see below). The installed desktop app has not been
replaced; its installed build/commit was not captured.

Confirmed device: **iPhone 17 Pro Max, iOS 26.6.2 (23G90)**, connected by cable,
paired with this Mac, Developer Mode enabled. Baseline installed app:
`com.terminalx.next.mobile`, **0.1.0 build 1**. A separate legacy app is also
installed; the current app was explicitly launched for the baseline test.
The phone was subsequently updated to **0.1.0 build 164**, verified by CoreDevice.

The copied version-2 offer had a relay invite and was unexpired when inspected.
The current source parser accepted it under both Node's URL implementation and
Expo's `whatwg-url-minimum`. No host or pairing journal was saved by the
installed phone build. This narrows the reported error to parsing/expiry, but
does not yet distinguish an older installed parser, a device clock discrepancy,
or another native-runtime difference. No offer material was added to this record.

## Confirmed regressions and changes

`pnpm --dir mobile exec vitest run src/pairing-sheet.test.tsx` initially failed:

- Two native scan callbacks delivered before React rendered submitted two
  pairing operations. A synchronous ref guard now admits only one operation.
- A failed scan stayed disabled after closing and reopening. Closing now clears
  the scanner state, and the hidden sheet does not mount a camera.
- Failed scans pause until Retry, Scan again, or a mode change. Scan again
  remounts the camera. This permits recovery without automatically redeeming the
  same one-time offer repeatedly. Close/mode changes are disabled during a submit.

The shared pairing path also discarded a relay refusal when an unreachable LAN
candidate failed later. A regression reproduced that diagnostic loss; failure
selection now prefers the furthest completed stage, then relay for equal stages.
This changes error reporting, not whether the relay accepts the invite.

Pairing errors now expose only fixed guidance and bounded stage/category/path
values. Parsing distinguishes expired from invalid offers. Transport, encrypted
host verification, credential installation and persistence are categorized.
The explicit QR/manual flow records start, completion and safe failure details
in the existing connection log. Raw schema, native-storage and server error text
is not forwarded by this flow. Timestamps can correlate a device attempt with
separately redacted desktop/relay logs; no cross-system traces were captured here.

## Device-build preparation

A standalone Release build from this worktree was built, signature-verified,
installed, and launched on the connected phone as **0.1.0, build 163**.
CoreDevice confirmed the installed bundle version is `163`. The first signing attempt used a different configured team and
failed because that account's saved Xcode login was rejected. A valid cached
Xcode-managed development profile for the exact app and connected phone was
found with a matching local signing identity. The generated, ignored Xcode
project now uses that profile's team with automatic signing; no account login
or profile registration was needed. The generated Info.plist was also made to use `CURRENT_PROJECT_VERSION` so the
installed build is distinguishable from baseline build 1. These native project
settings are ignored build artifacts; the tracked app icon was restored after
prebuild. A subsequent physical-device attempt completed pairing as recorded
below. Physical autofocus is still pending.

## Build 163 device result so far

The first observed retry on build 163 failed with the safe diagnostic
`parsing/expired-offer`. The paired host count remained zero and no recovery
journal was created. The phone timestamp was about five seconds before the log
was observed by a five-second poller, consistent with the Mac clock. This
attempt therefore establishes expiration of the submitted offer, not a clock
skew or transport failure.

The user subsequently reported “finally it worked.” A read of the phone's
stored log confirmed a later `Pairing completed` / `Host saved` event, followed
by two `Connected` events on the **direct** path. There is one saved host and no
pending recovery journal. This verifies pairing completion, saving the host,
and a subsequent direct connection on build 163. The user's follow-up, “but the
QR code still didnt work,” followed by confirmation of pasted code on the same
Wi-Fi with TerminalX Relay selected, establishes manual-code success. That
desktop option also includes direct candidates. The user additionally reported
“Relay pairing worked”; a subsequent log read still showed only direct
connections and no further pairing attempt. Record relay success as
user-reported. The user then confirmed testing a different network as well, so
cross-network manual pairing is physically verified by user report; no matching
relay-path log entry was captured. Session access and persistence across an app restart also remain
unverified. No new code change was needed between the expired-offer
rejection and this success.

## Camera finding

The lockfile installs **expo-camera 57.0.4** (mobile package version **0.1.0**;
this is not an installed physical-device build identification).

In that package:

- `src/utils/props.ts` defaults `autofocus` to `off`.
- `ios/Current/CameraEnums.swift`, `FocusMode.toAVCaptureFocusMode()`, maps
  `off` to `continuousAutoFocus` and `on` to single-shot `autoFocus`.
- The scanner now explicitly selects the back camera and `autofocus="off"`,
  and starts a new camera session on rescan/reopen.

The missing prop did **not** disable continuous iOS autofocus. Physical focus
performance, camera/lens selection and QR decoding still require phone testing.
See the [Expo Camera reference](https://docs.expo.dev/versions/latest/sdk/camera/)
for the public focus API; the installed native source establishes the mapping
above. Android ignores this iOS-only prop.

After manual pairing succeeded, the user reported that QR still did not work,
then clarified that the QR looks sharp but produces no response. This separates
failed detection from the earlier manual-code expiry error and from focus /
visual guidance.
The original desktop rendered a 220-pixel PNG in a 132-CSS-pixel square with a
two-module margin. A synthetic three-endpoint offer produced a 109-module QR,
about 1.17 CSS pixels per module. The QR specification recommends a
[four-module quiet zone](https://www.qrcode.com/en/howto/code.html).
This is a rendering concern, not an established cause of this phone failure:
Apple Vision decoded synthetic fixtures at both the current and larger sizes
in ideal raster tests. This does not reproduce the physical camera failure, and
no desktop QR sizing change was made based on it.

### Guided scanner follow-up (build 164)

The scanner provider framework is present, linked by the installed app, and
exports its Objective-C provider class. A missing provider library is therefore
not established as the cause. The embedded scanner's native detection failure
has not been isolated to a specific camera-library defect.

There is a confirmed UI integration error: the aiming rectangle was a child of
`CameraView`, which the installed Expo implementation explicitly does not
support. Regression coverage failed on that arrangement before the fix.

`PairingScanner` now uses Apple's native guided scanner on supported iPhones
through Expo's `launchScanner`, with QR-only recognition, detected-code
highlighting, guidance, and pinch-to-zoom enabled. It dismisses the scanner before
submitting a decoded offer to the shared pairing flow. Repeated native events
are gated synchronously; listeners are removed and the scanner dismissed on
close or mode changes. A cancelled scan can be reopened, and Scan again starts
a new attempt after pairing failure. If the native scanner cannot launch, the
embedded camera remains available with continuous autofocus and an aiming
rectangle rendered as a sibling overlay, plus explicit starting / looking /
paused / camera-error feedback. The overlay is guidance, not a claim of focus
lock or QR detection.

Four new tests first failed, then passed: supported iOS uses the guided scanner
and deduplicates results; launch failure falls back; close/retry clears native
listeners; the embedded aiming guide is outside `CameraView`. These establish
integration behavior, not physical detection or autofocus. The subsequent
physical QR result is recorded below. See the
[Expo scanner API](https://docs.expo.dev/versions/latest/sdk/camera/) for the
native guidance and highlighting options.

Build **0.1.0 (164)** compiled as a standalone Release, passed signature
verification, and was installed on the same physical phone. CoreDevice verified
the installed build number. Automatic launch failed because the phone was
locked; the user has been asked to unlock it, open TerminalX, and test
**Scan → Open QR scanner** with a fresh offer. Subsequent user testing established
that the larger QR rendering works, as recorded below.

### Desktop QR rendering follow-up

The user subsequently reported QR still failing and supplied an image of the
desktop offer. The image and its decoded contents are not included in this
record. Apple Vision decoded both the full screenshot and the QR region in
memory: QR version 24, **113 modules**, **869 payload characters**, displayed in
a 264-pixel region of the screenshot (the desktop's 132-CSS-pixel square at 2×).
This establishes that the raster contains readable QR data; it does not prove
physical camera detection at normal distances.

The old fixed 220-pixel bitmap allotted fewer than two source pixels per QR
module for this offer, then displayed it at about 1.13 CSS pixels per module.
Its two-module white border was below the four-module quiet-zone requirement.
The desktop renderer now uses a full four-module margin, eight source pixels
per module, and a **320-CSS-pixel** display. The card wraps controls below the
QR when needed. The regression assertion failed with the old two-module margin
and passes after the change. The DevicesTab test and desktop TypeScript check
both pass.

A temporary loopback-only preview rendered a fresh copied offer using these same
rendering settings for physical comparison without restarting the running
desktop. It generates the image in memory, sends no offer to an external
service, disables caching, and logs no offer contents. The user confirmed
**“bigger QR worked”** after testing the larger preview. Improving the rendering
therefore resolved detection in this physical comparison. Size, resolution and
margin changed together, so their individual contributions were not isolated.
The user then explicitly confirmed that the scan completed pairing. No matching
completion log was captured because the phone was disconnected during the
follow-up read. The temporary preview was stopped and its diagnostic fixtures
removed after the successful test.

## Automated coverage

### Desktop bundle verification — 2026-09-28

Resumed work after checking that no prior build or QR-preview process was
running. The completed phone tests and mobile builds were not repeated.

Built a local macOS Release app with the existing lockfile and updater artifacts
disabled:

```sh
pnpm tauri build --bundles app --no-sign --ci --config '{"bundle":{"createUpdaterArtifacts":false}}' -- --locked
```

The build succeeded, including the frontend and macOS computer-use helper.
The compiled frontend contains the 320-pixel display, four-module margin,
eight-pixel module scale, and positioning guidance. The app bundle includes
the main executable, CLI, browser sidecar, and computer-use helper. A local
ad-hoc signature was applied; `codesign --verify --deep --strict` passed.

Artifact: `src-tauri/target/release/bundle/macos/TerminalX.app` (**0.2.2**).
This is a local test build, not a published or notarized release. It was not
launched or installed over the running desktop app. The remaining physical
scanner-reopen/focus and session-access checks below are still unconfirmed.

### Regression checks

Run:

```sh
pnpm --dir mobile test
pnpm --dir mobile typecheck
pnpm --dir mobile lint
```

- `pairing-sheet.test.tsx`: actual Machines screen with mocked native views;
  duplicate native callbacks, hidden camera, reopen, explicit rescan, busy
  controls, and manual-code retry.
- `pairing/pair.test.ts`: actual parser, pairing orchestration, recovery journal
  and host/credential storage with mocked native storage and transport replies;
  QR links and bare codes, relay fallback with unavailable LAN, direct pairing
  with/without relay, stage failures, relay refusal diagnostic preservation,
  and recovery of a committed install after persistence fails.
- `pairing/parse.test.ts`: valid/invalid/expired payloads and safe error output.
- `transport/relay-client.test.ts`: actual transport with a fake socket;
  direct handshake and rejection of an invalid encrypted host response.

Validation result: **71 tests passed across 14 files**; mobile type checking
passed. Lint passed with one pre-existing `import/first` warning in
`mobile/src/transport/connection.test.ts`.

These tests do not contact the production relay or prove cross-network pairing,
physical QR decoding, autofocus, native Keychain behavior, or opening real sessions.

## Device connection follow-up

The earlier connection blocker below is **resolved**: the iPhone 17 Pro Max is
now connected by cable, app launch and app-storage access both succeed. No
Trust reset was required.


After the user reported connecting a phone, CoreDevice still listed the iPhone
17 Pro Max as disconnected over the local network and the iPhone 12 Pro Max as
unavailable. A device-details lookup returned cached information; querying
installed apps did not establish a live connection. USB discovery found no
iPhone, and ADB listed no Android device. At that earlier point no app had been installed or changed on a phone, and no
physical autofocus or pairing result was claimed.

## Physical verification record

Record the desktop commit/build, mobile app version **and build number**, Expo
Camera version, phone model (no device name/identifier), OS version, date/time,
and network scenario. Never capture QR images, full codes/links, tokens, keys,
personal names, device/account identifiers or private addresses.

Use a **fresh, unused offer for each independent test**:

| Test | Record | Result |
| --- | --- | --- |
| QR detection and pairing | Focus; decode; pairing; host visible | Original small QR: sharp but no response. Larger rendering: user confirms detection and completed pairing; this QR test's network was not separately recorded. |
| Manual code, same network | Fresh pasted code; pairing; host visible | Confirmed: pasted code, same Wi-Fi, saved host and direct connection |
| QR and manual, different network | Relay connected on desktop; each offer independently pairs | Manual relay pairing on a different network confirmed by user; QR not separately tested across networks |
| Nearby LAN/direct where supported | Fresh offer; direct connection; sessions accessible | Direct connection confirmed; session access pending |
| Scanner reopened | Close/reopen; near/far focus; decode a fresh offer | Pending |
| Failed scan recovery | Error category; Retry; Scan again with fresh offer; one submit | Pending |
| Invalid/expired/used offers | Actionable error; fresh-offer recovery | Expired error and later successful fresh manual attempt observed; invalid/used physical cases pending |
| Persistence/session access | Restart mobile; host retained; open a session | Host saved, retained after mobile build replacement, and direct connection confirmed; cold restart/session access pending |

For each attempt, note whether QR decoding happened, the fixed failure
`stage/category/path` (if any), and its timestamp. Read the corresponding safe
entry in Settings → Connection log. Separate pre-decode camera failures from
post-decode pairing failures. A relay refusal does not by itself distinguish
expiration from an already-used invite; preserve that uncertainty unless the
redacted server trace establishes the cause.
