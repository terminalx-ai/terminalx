#!/usr/bin/env bash
# Build terminalx-serve for Linux and run its relay e2e (serve/tests/relay_e2e.rs)
# inside a Linux container, against the terminalx-saas relay code (PRO-12):
#   TERMINALX_SAAS_DIR=~/code/ai/terminalx/terminalx-saas scripts/remote-runtime/e2e-linux.sh [test filter]
#
# The container builds for its own architecture (arm64 on Apple silicon). The
# serve binary is copied to $SERVE_OUT (default <repo>/target-linux), where
# terminalx-saas `bun run cloud:e2e:local` picks it up. Cargo
# and rustup state live in Docker volumes, so rebuilds are incremental.
#   BUILD_ONLY=1   build and copy the binary, skip the tests
#   UNIT=1         first run the library unit tests, terminalx-serve's own tests
#                  and its clippy, as the headless-serve CI job does
#   CPUS=2         CPU limit for the container
# Colima shares only $HOME by default: keep both checkouts and SERVE_OUT there.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
out="${SERVE_OUT:-$here/target-linux}"
image="terminalx-serve-linux-e2e"
if [ -z "${BUILD_ONLY:-}" ]; then
  : "${TERMINALX_SAAS_DIR:?set TERMINALX_SAAS_DIR to the terminalx-saas checkout (dependencies installed)}"
  saas="$(cd "$TERMINALX_SAAS_DIR" && pwd)"
fi
mkdir -p "$out"
docker build -q -t "$image" -f "$here/scripts/remote-runtime/linux.Dockerfile" "$here/scripts/remote-runtime" >/dev/null

mounts=(-v "$here:/src" -v "$out:/out" -v terminalx-linux-cargo:/usr/local/cargo/registry -v terminalx-linux-rustup:/usr/local/rustup -v terminalx-linux-target:/target)
[ -n "${saas:-}" ] && mounts+=(-v "$saas:/saas:ro")
# A worktree's .git names the main repository by its host path; mount it there
# so git works in /src (the GitHub helper tests run git config in the cwd).
if [ -f "$here/.git" ]; then
  common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
  mounts+=(-v "$common:$common:ro")
fi
filter="${1:-}"
docker run --rm --init --cpus="${CPUS:-2}" "${mounts[@]}" \
  -e CARGO_TARGET_DIR=/target -e BUILD_ONLY="${BUILD_ONLY:-}" -e UNIT="${UNIT:-}" -e FILTER="$filter" \
  -w /src/src-tauri/serve "$image" bash -c '
set -euo pipefail
cargo build --locked --bin terminalx-serve
install -m 0755 /target/debug/terminalx-serve /out/terminalx-serve
echo "terminalx-serve: /out/terminalx-serve ($(uname -m))"
[ -n "$BUILD_ONLY" ] && exit 0
if [ -n "$UNIT" ]; then
  (cd .. && cargo test --locked -p raccoon --no-default-features --lib)
  cargo clippy --locked --all-targets -- -D warnings
  cargo test --locked
fi
redis-server --port 56379 --save "" --appendonly no --daemonize yes >/dev/null
for _ in $(seq 1 50); do redis-cli -p 56379 ping >/dev/null 2>&1 && break; sleep 0.2; done
export RELAY_TEST_REDIS_URL=redis://127.0.0.1:56379 TERMINALX_SAAS_DIR=/saas
cargo test --locked --test relay_e2e -- --ignored --nocapture --test-threads=1 ${FILTER:+"$FILTER"}
'
