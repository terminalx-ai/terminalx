#!/usr/bin/env bash
# Build raccoon's tests once, so the next cargo command compiles nothing (#1543).
#
#   ../infra/ci-runners/cargo-build-once.sh --lib                macos-native
#   ../infra/ci-runners/cargo-build-once.sh --bins --test '*'    linux-rust-tests (binaries)
#
# Run from src-tauri. The arguments are cargo test's target arguments.
#
# `tauri::generate_context!` (tauri-codegen 2.6.3) writes the app's compressed
# assets into the crate's OUT_DIR while the crate compiles, and the crate embeds
# them, so to cargo they are inputs newer than the build and the next cargo
# command compiles the crate again. The files are named by a checksum of their
# content, so an old date says nothing false; tauri-codegen 2.7 dates them back
# itself. OUT_DIR is the folder cargo names for the crate's build script, not a
# path searched for: cargo 1.100 keeps every unit's output, the test binary among
# them, under build/raccoon/<hash>/out, and dating those back makes them stale.
# The second `--no-run` must find every unit fresh, or this fails with cargo's
# reason.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: cargo-build-once.sh <cargo test target arguments>, for example --lib" >&2
  exit 2
fi
dir="${RUNNER_TEMP:-$(mktemp -d)}"

cargo test --locked "$@" --no-run --message-format=json-render-diagnostics > "$dir/build.jsonl"
out_dir=$(jq -r 'select(.reason == "build-script-executed" and (.package_id | test("[#/]raccoon@"))) | .out_dir' "$dir/build.jsonl")
test -d "$out_dir"
find "$out_dir" -type f -exec touch -t 200001010000 {} +
cargo test --locked "$@" --no-run -v --message-format=json 2> "$dir/fresh.log" | jq -s -e '[.[] | select(.reason == "compiler-artifact")] | (length > 0) and all(.fresh)' || { sed -E 's/\x1b\[[0-9;]*m//g' "$dir/fresh.log" | grep -E '^ *Dirty' | cut -c1-600; exit 1; }
