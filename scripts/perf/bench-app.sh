#!/bin/sh
# Launch an isolated copy of a Dev build for the terminal benchmark (issue
# #232, docs/TERMINAL-PERFORMANCE.md), without touching any other TerminalX on
# this Mac:
#   - a copy with its own bundle id and no URL scheme, so nothing that opens
#     `terminalx://` links or activates "TerminalX Dev" can reach it;
#   - its own TERMINALX_HOME (short: the socket path is limited) and its own
#     Keychain service;
#   - opened in the background, so it does not take focus;
#   - its own HOME, with a stand-in `claude` (scripts/remote-runtime/fake-claude)
#     first on its PATH: agent tabs run that, never a real agent, and neither
#     it nor the shells read or write anything under your real home.
#
#   pnpm tauri build --debug --bundles app --no-sign --config src-tauri/tauri.dev.conf.json
#   scripts/perf/bench-app.sh [home, default ~/.txperf]
# Prints the app's pid. Quit it with `kill <pid>` when done.
set -eu
HOME_DIR="${1:-$HOME/.txperf}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILT="$ROOT/src-tauri/target/debug/bundle/macos/TerminalX Dev.app"
[ -d "$BUILT" ] || { echo "bench-app: build the Dev app first: $BUILT is missing" >&2; exit 1; }
APP="$HOME_DIR/app/TerminalX Perf.app"
mkdir -p "$HOME_DIR/app"
rm -rf "$APP"
cp -R "$BUILT" "$APP"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.terminalx.next.dev.perf232" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName TerminalX Perf" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
codesign --force --deep -s - "$APP" >/dev/null 2>&1
mkdir -p "$HOME_DIR/home" "$HOME_DIR/bin"
ln -sf "$ROOT/scripts/remote-runtime/fake-claude" "$HOME_DIR/bin/claude"
open -g -n -a "$APP" \
  --env "HOME=$HOME_DIR/home" \
  --env "PATH=$HOME_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  --stdout "$HOME_DIR/app.log" --stderr "$HOME_DIR/app.log" \
  --env "TERMINALX_HOME=$HOME_DIR" \
  --env "RACCOON_DEV_KEYCHAIN_SERVICE=dev.terminalx.perf-$(date +%s)" \
  --env "TERMINALX_TERMINAL_BENCH=1"
i=0
while [ ! -S "$HOME_DIR/run/hooks.sock" ] && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
pgrep -f "$APP/Contents/MacOS/" | head -1
