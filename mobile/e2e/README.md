# Native machine-to-sessions regression

`machine-tab-routing.yaml` drives the installed native app and asserts the actual
selected tab and visible Sessions content. It does not mock Expo Router or press
the Sessions tab as a fallback. Stable test IDs distinguish tab buttons from
header titles and machine rows from their separate options buttons.

Use a coordinator-released CUA VM only. Do not run on the host. Runtime execution,
dependency installation, and builds remain subject to the coordinator's release.
The flow requires Maestro on that VM; it adds no application dependency.

Prepare a Release simulator build from the candidate source:

```sh
pnpm --dir mobile ios:simulator --device "$SIMULATOR_UDID"
```

Use an authorized test Mac paired explicitly by QR/code, signed out of the account.
Start with Machines selected and the Mac already Connected. Prefer a fresh app
launch where Sessions has not been visited. Do not clear data or re-pair between
the first tap and repeats. Obtain `HOST_ID` from the row's `machine-row-<id>`
accessibility identifier, not from credential storage. Then, inside the VM:

```sh
maestro --device "$SIMULATOR_UDID" test -e HOST_ID="$HOST_ID" mobile/e2e/machine-tab-routing.yaml
```

The pre-fix build with the test identifiers added should fail at the first
`sessions-tab` selected assertion; the candidate must pass all three row taps.
Also repeat with an account-paired test Mac when available. Do not sign the owner
in or inspect provider/session transcripts. The flow stays on Machines/Sessions
and never opens a conversation.

For the CUA visual gate, perform the same steps through the VM's Simulator window:
capture Machines selected with the row Connected, press the machine name, and
verify Sessions selected, the same Mac's name, and Live · end-to-end encrypted.
Return to Machines and repeat using a coordinate tap on the chevron. Verify no
reconnecting flash, lost selection, or blank list; compare the visible list with
the direct Sessions-tab control without opening any session. Record source SHA,
installed bundle identity, simulator model/OS, and before/after evidence. This
native gate is required even when component tests pass.

Focused source checks (only after coordinator release):

```sh
pnpm --dir mobile exec vitest run src/device-menu.test.tsx src/state/app-provider-names.test.tsx src/state/app-provider-background.test.tsx
pnpm --dir mobile typecheck
```

The provider tests cover healthy host reselection without transport restart or
session loss. The component tests cover both account states and failed selection;
their mocked router assertions are not a substitute for the native flow.
