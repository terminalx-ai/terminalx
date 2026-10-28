# Native machine-to-sessions regression

`machine-tab-routing.yaml` drives the installed native app and asserts the actual
selected tab and visible Sessions content. It does not mock Expo Router or press
the Sessions tab as a fallback. Stable test IDs distinguish tab buttons from
header titles and machine rows from their separate options buttons.

For a physical iPhone, use your existing Xcode project and device signing setup
to build the candidate source and update the installed app in place. Preserve
the existing bundle and Keychain identity and saved Mac pairing; do not uninstall,
clear credentials, or re-pair. Record the built source SHA and installed version/
build identity: an already-installed app is not evidence that it contains the fix.
The manual checks below do not require Maestro.

For simulator verification instead, prepare a Release build from the candidate source:

```sh
pnpm --dir mobile ios:simulator --device "$SIMULATOR_UDID"
```

Use the existing paired Mac and keep the current account state; record whether
the pairing is explicit QR/code or account-based. Start with Machines selected
and the Mac already Connected on a fresh app launch where Sessions has not been
visited. If launch restores Sessions, record that first-visit coverage remains
unverified. Do not clear data or re-pair between the first tap and repeats.

For the automated simulator flow, Maestro must already be available; it adds no
application dependency. Obtain `HOST_ID` from the row's `machine-row-<id>`
accessibility identifier, not from credential storage:

```sh
maestro --device "$SIMULATOR_UDID" test -e HOST_ID="$HOST_ID" mobile/e2e/machine-tab-routing.yaml
```

The pre-fix build with the test identifiers added should fail at the first
`sessions-tab` selected assertion; the candidate must pass all three row taps.
Keep the existing account state and do not inspect provider/session transcripts.
The flow stays on Machines/Sessions and never opens a conversation.

For manual verification on the physical iPhone or in Simulator,
capture Machines selected with the row Connected, press the machine name, and
verify Sessions selected, the same Mac's name, and Live · end-to-end encrypted.
Return to Machines and repeat by tapping the chevron. Verify no reconnecting
flash, lost selection, or blank list. Record source SHA,
installed bundle identity, device model/OS, and before/after evidence. Compare
the same populated list and live status on both row taps; use the direct Sessions
tab only afterward as a control. Native acceptance remains pending until these
observations are recorded, even when component tests pass.

Focused source checks:

```sh
pnpm --dir mobile exec vitest run src/device-menu.test.tsx src/state/app-provider-names.test.tsx src/state/app-provider-background.test.tsx
pnpm --dir mobile typecheck
```

The provider tests cover healthy host reselection without transport restart or
session loss. The component tests cover both account states and failed selection;
their mocked router assertions are not a substitute for the native flow.
