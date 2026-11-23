#!/bin/zsh
# Bundle the phone fixture into a copy of the simulator build and capture each board's states (see README.md).
# usage: capture.sh <output directory> [flow ...]   (flows default to every flow-*.yaml here)
set -euo pipefail
out=${1:?usage: capture.sh <output directory> [flow ...]}
shift
mkdir -p "$out" && out=${out:A}
here=${0:A:h}
mobile=${here:h:h}
built="$mobile/dist/simulator-build/Build/Products/Release-iphonesimulator/TerminalX.app"
work="$mobile/dist/phone-fixture"
app="$work/TerminalX.app"
device=${SIMULATOR_UDID:-booted}
[[ -d $built ]] || { print -u2 "Build the simulator app first (README.md, step 1)."; exit 1; }
if [[ -z ${SKIP_BUNDLE:-} ]]; then
  rm -rf "$work" && mkdir -p "$work" && cp -R "$built" "$app"
  cd "$mobile"
  APP_VARIANT=production EXPO_OVERRIDE_METRO_CONFIG="$here/metro.config.cjs" \
    pnpm exec expo export:embed --platform ios --dev false --reset-cache --entry-file node_modules/expo-router/entry.js \
    --bundle-output "$work/main.js" --assets-dest "$app"
  grep -q "fixtureScenario" "$work/main.js" || { print -u2 "The fixture is not in the bundle."; exit 1; }
  # As the Release build does: Hermes bytecode in place of the app's own bundle.
  hermesc=$(node -p 'const path = require("path"); const rn = path.dirname(require.resolve("react-native/package.json")); path.join(path.dirname(require.resolve("hermes-compiler/package.json", { paths: [rn] })), "hermesc/osx-bin/hermesc")')
  "$hermesc" -emit-binary -O -out "$app/main.jsbundle" "$work/main.js"
  # Its own bundle id: an installed TerminalX app and its pairing are left alone.
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.terminalx.phone.fixture" -c "Set :CFBundleDisplayName Phone fixture" "$app/Info.plist"
  codesign --force --sign - --timestamp=none "$app"
  xcrun simctl install "$device" "$app"
fi
flows=("$@")
(( ${#flows} )) || flows=("$here"/flow-*.yaml)
for flow in $flows; do
  "${MAESTRO:-maestro}" ${SIMULATOR_UDID:+--device} ${SIMULATOR_UDID:-} test --test-output-dir "$out" "${flow:A}"
done
print "Screenshots in $out"
