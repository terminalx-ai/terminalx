#!/usr/bin/env bash
# Run every check this project has. Exits non-zero when any of them fails.
# Add new checks here so people and agents all run the same thing.
set -euo pipefail
cd "$(dirname "$0")/.."

did=0
have() { command -v "$1" >/dev/null 2>&1; }
step() { printf '\n==> %s\n' "$*"; did=1; "$@"; }
has_script() { have node && node -e 'process.exit(require("./package.json").scripts?.[process.argv[1]] ? 0 : 1)' "$1"; }

if [ -f package.json ]; then
  runner=npm
  if [ -f pnpm-lock.yaml ] && have pnpm; then runner=pnpm
  elif [ -f yarn.lock ] && have yarn; then runner=yarn
  elif { [ -f bun.lock ] || [ -f bun.lockb ]; } && have bun; then runner=bun
  fi
  for script in typecheck lint test; do
    if has_script "$script"; then step "$runner" run "$script"; fi
  done
fi

if [ -f Cargo.toml ]; then
  step cargo test
fi

if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  if have uv && [ -f pyproject.toml ]; then step uv run pytest
  elif [ -x .venv/bin/pytest ]; then step .venv/bin/pytest
  else step python3 -m pytest
  fi
fi

if [ -f go.mod ]; then
  step go test ./...
fi

if [ -f Makefile ] && make -n test >/dev/null 2>&1; then
  step make test
fi

if [ "$did" -eq 0 ]; then
  echo "No checks to run yet. When the first code lands, its tests run from here."
fi
