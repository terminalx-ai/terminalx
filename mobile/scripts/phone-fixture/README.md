# Phone fixture (22.01–22.07)

The production app (its root layout, native tab bar and every screen) with
only `src/state/AppProvider.tsx` swapped for `fixture-app.tsx` and
`src/cloud/CloudProvider.tsx` for `fixture-cloud.tsx`. The real `HostApi` runs
over a fake connection that answers the Mac's requests with placeholder data:

- five machines: two paired Macs online, two offline, and one on the account only;
- nine sessions: two waiting on the person, three working, one merged, one with failing checks, and so on;
- a conversation with earlier turns, a reply, and two commands.

The Cloud tab runs the real `CloudCatalog` and `CloudApi`; only `fetch` is
answered in memory. It has two organizations with workspaces (one working, two
stopped, one waiting on an answer) and five without any. One stopped workspace
has a saved conversation: its checkpoint is sealed with the app's own crypto
and opened on the phone by the real reader, with a placeholder key.

There is no pairing, account, network or private data. Each `flow-22.0N.yaml`
drives the app with Maestro and saves a screenshot for each state that design
22.0N draws. `flow-22.00-setup.yaml` picks the Ember theme the boards use.

The scenario is passed as a launch argument (`arguments: { fixtureScenario: … }`
in a flow), and it reaches the app through `Settings.get("fixtureScenario")`.

| Scenario | What the phone sees |
| --- | --- |
| `connected` (default) | Connected to Studio MacBook |
| `connecting` | Still connecting, before the wait counts as long |
| `waiting` | Connecting for longer than `WAITING_AFTER_MS`: "Waiting for Mac…" |
| `updating` | Connected, and the conversation's first sync never ends |
| `offline` | No internet |
| `held` | The Mac holds the phone off ("Disconnected on your Mac") |
| `slow-refresh` | Connected, and a pull to refresh takes 6 s |

`fixtureCloud: loading` holds the first read of the cloud list, so the Cloud
tab shows its placeholder rows. `openRoute: /cloud` with `openWorkspace: <id>`
opens a workspace at launch, as a tap on its row does.

## Cloud setup (25.01, 25.02)

The setup screens ask the service for an organization's providers and agent
logins, and create organizations. `setup/organization.ts` answers those
requests in memory, before the fixture's own answers; `fixtureSetup: <state>`
picks the account a board draws (the states are listed in that file), and
`fixtureCreate: slow` or `fail` what becomes of a creation. Without
`fixtureSetup` nothing changes and the 22.06 list is shown. An area of the
setup (`setup/<area>.ts`) is a `SetupHandler`: it returns an answer, or
nothing to leave the request to the next.

`flow-25.01.yaml` and `flow-25.02.yaml` choose the organization as a person
does, through the app. The boards are drawn in Ember when dark and in Den when
light: for the light run set the simulator's appearance to light and
`MAESTRO_THEME=Den`.

## Beta access code (25.08)

`fixtureAccessCode: <answer>` starts the phone signed out with no machines.
Sign in shows "Signing in…" for a few seconds and is then held at the private
beta, so the access code screen comes up through the app's own layout. Each
code goes through the app's real `redeemAccessCode` to a redeem route in
memory, which answers after three seconds as the argument says, in the words
of the server's contract (PRO-550): `accepted`, `invalid`, `expired`,
`exhausted`, `rate-limited`, `ended` (the ticket is gone) or `error`.
`fixtureAccessEmail` is the address the sign-in is for (the long-address
frame), and `fixtureScenario: offline` is the offline frame. With
`fixtureSetup: first-run`, an accepted code lands on 25.01's first run.
`flow-25.08.yaml` shoots every state.

## A running workspace (25.10)

"Search filters" in Acme runs: the app's real catalog, link, session and
outbox connect to a workspace runtime that answers in `live-workspace.ts`,
over the real encrypted handshake and frames of `src/cloud/fake-runtime.ts`.
`fixtureStart: <state>` picks what that runtime says (the states are listed in
that file: a manager, `tab`, `other`, `old`, `unread`, `no-answer`, `refused`,
`prompt-failed`, `gone`). `fixtureResume: hold` keeps a start of a stopped
workspace under way, and `fixtureResume: fail` has the provider not answering.
`flow-25.10.yaml` shoots each state; it takes about two minutes longer than the
others, because no answer is only said once the client stops waiting (30 s).

`fixtureTabs: states` gives "Review and merge" four tabs, one for each state on
the session screen (working, a question, a table, done).

Notifications (22.07) run the app's own path: the fixture saves 22.07's choices
through the notification store and its machines into the hosts list, and the
Mac answers `notifications.missedSince`. `fixtureLockScreen: everything` (or
`sessionName`, `nothing`) turns that lock-screen level on and has the Mac send
three notifications from while the phone was away; the app filters, words and
schedules them, and `flow-22.07.yaml` shoots the lock screen. iOS asks before
anything reaches the phone, so the flow asks it from the page's switch.
`flow-22.07-off.yaml` turns notifications off in iOS Settings (Maestro's launch
`permissions` cannot deny them on a simulator) and back on afterwards. The
notifications are headed "Phone fixture", the copy's own app name.

1. Build the simulator app once, as `pnpm ios:simulator` does, but without installing it:

   ```sh
   cd mobile && export APP_VARIANT=production
   pnpm exec expo prebuild --platform ios --no-clean
   xcodebuild -workspace ios/TerminalX.xcworkspace -scheme TerminalX -configuration Release \
     -destination id=$SIMULATOR_UDID -derivedDataPath dist/simulator-build \
     ARCHS=$(uname -m) ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build
   ```

2. Bundle the fixture and put it into a copy of that app under its own bundle
   id, so an installed TerminalX app and its pairing are left alone. Then capture:

   ```sh
   scripts/phone-fixture/capture.sh <output directory> [flow …]
   ```

   With no flows it runs every `flow-*.yaml`. `SKIP_BUNDLE=1` reuses the last
   bundle when only a flow changed.

   `capture.sh` needs:
   - Maestro (`MAESTRO=/path/to/maestro/bin/maestro`);
   - a Java runtime (`JAVA_HOME`);
   - the simulator to use (`SIMULATOR_UDID`, which defaults to the booted one).

   Each screenshot is saved under `<output directory>/<run>/<flow name>/takeScreenshot/`.
   For the boards' look, set the simulator to dark appearance and the status bar to 10:25:
   `xcrun simctl status_bar $SIMULATOR_UDID override --time 10:25`.

## A first task at launch (25.09)

`fixtureLaunch: <outcome>` (`setup/launch.ts`) gives Northwind a connected Boat
and two agent logins and answers the launch form, its price and the launch.
The launch then moves through its six phases by the clock and ends as the
outcome says: `running`, `sign-in`, `unsure`, `not-picked-up`, or `hold`
(10 s a phase, so each can be shown). `flow-25.09.yaml` draws the form, its
sheets, the review and the phases; `flow-25.09-ends.yaml` the outcomes,
a cancel and Launch again. They open the form with
`openRoute: /cloud/new?orgId=org-northwind`.

Maestro's view of the screen trails the app by a few seconds, and its waits
end after about one phase whatever their timeout, so the flows wait on what a
phase shows rather than on time. Its tap on an alert's button can land on a
page button of the same name under the alert; the cancel is tapped by place.
