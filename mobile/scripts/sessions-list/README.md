# Sessions list fixture (#986)

The production app — its root layout, native tab bar and Sessions screen — with
only `src/state/AppProvider.tsx` swapped for `fixture-app.tsx`: one connected Mac
holding nine synthetic sessions (two waiting on the person, three working, one
merged, one with failing checks, …). No pairing, account, network or private data.
`flow.yaml` drives it with Maestro and saves a screenshot per state of design 22.04.

1. Build the simulator app once (as `pnpm ios:simulator` does, without installing it):

   ```sh
   cd mobile && export APP_VARIANT=production
   pnpm exec expo prebuild --platform ios --no-clean
   xcodebuild -workspace ios/TerminalX.xcworkspace -scheme TerminalX -configuration Release \
     -destination id=$SIMULATOR_UDID -derivedDataPath dist/simulator-build \
     ARCHS=$(uname -m) ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build
   ```

2. Bundle the fixture, put it into a copy of that app under its own bundle id
   (the installed TerminalX app and its pairing are left alone), and capture:

   ```sh
   scripts/sessions-list/capture.sh <output directory>
   ```

   `capture.sh` needs Maestro (`MAESTRO=/path/to/maestro/bin/maestro`) and a Java
   runtime (`JAVA_HOME`).
