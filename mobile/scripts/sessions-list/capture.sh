#!/bin/zsh
# Bundle the Sessions list fixture into a copy of the simulator build and capture each state (see README.md).
set -euo pipefail
out=${1:?usage: capture.sh <output directory>}
mkdir -p "$out" && out=${out:A}
mobile=${0:A:h:h:h}
built="$mobile/dist/simulator-build/Build/Products/Release-iphonesimulator/TerminalX.app"
work="$mobile/dist/sessions-list-fixture"
app="$work/TerminalX.app"
[[ -d $built ]] || { print -u2 "Build the simulator app first (README.md, step 1)."; exit 1; }
rm -rf "$work" && mkdir -p "$work/assets" && cp -R "$built" "$app"
cd "$mobile"
APP_VARIANT=production EXPO_OVERRIDE_METRO_CONFIG="$mobile/scripts/sessions-list/metro.config.cjs" \
  pnpm exec expo export:embed --platform ios --dev false --reset-cache --entry-file node_modules/expo-router/entry.js \
  --bundle-output "$work/main.js" --assets-dest "$app"
grep -q "Mobile question card" "$work/main.js" || { print -u2 "The fixture state is not in the bundle."; exit 1; }
# As the Release build does: Hermes bytecode in place of the app's own bundle.
hermesc=$(node -p 'const path = require("path"); const rn = path.dirname(require.resolve("react-native/package.json")); path.join(path.dirname(require.resolve("hermes-compiler/package.json", { paths: [rn] })), "hermesc/osx-bin/hermesc")')
"$hermesc" -emit-binary -O -out "$app/main.jsbundle" "$work/main.js"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.terminalx.sessions.fixture" -c "Set :CFBundleDisplayName Sessions fixture" "$app/Info.plist"
codesign --force --sign - --timestamp=none "$app"
xcrun simctl install booted "$app"
"${MAESTRO:-maestro}" test --test-output-dir "$out" "$mobile/scripts/sessions-list/flow.yaml"
print "Screenshots in $out"
