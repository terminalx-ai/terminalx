#!/usr/bin/env bash
# Run the terminalx-serve + relay integration test (PRO-13) against the
# terminalx-saas relay code, with a throwaway Redis in Docker.
#   TERMINALX_SAAS_DIR=~/code/ai/terminalx/terminalx-saas scripts/remote-runtime/e2e.sh
# The saas checkout needs its dependencies installed (bun install).
set -euo pipefail
: "${TERMINALX_SAAS_DIR:?set TERMINALX_SAAS_DIR to the terminalx-saas checkout}"
here="$(cd "$(dirname "$0")/../.." && pwd)"
port="${RELAY_TEST_REDIS_PORT:-56379}"
name="terminalx-relay-e2e-redis-$$"
docker run -d --rm --name "$name" -p "127.0.0.1:${port}:6379" redis:7-alpine >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 50); do
  docker exec "$name" redis-cli ping >/dev/null 2>&1 && break
  sleep 0.2
done
export RELAY_TEST_REDIS_URL="redis://127.0.0.1:${port}"
cd "$here/src-tauri/serve"
cargo test --test relay_e2e -- --ignored --nocapture --test-threads=1 "$@"
