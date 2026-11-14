#!/usr/bin/env bash
# Install what this project needs, for whichever toolchain it uses.
# Safe to run again at any time; agents run it in every new worktree.
set -euo pipefail
cd "$(dirname "$0")/.."

did=0
have() { command -v "$1" >/dev/null 2>&1; }
step() { printf '\n==> %s\n' "$*"; did=1; }

if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ] && have pnpm; then step "pnpm install"; pnpm install
  elif [ -f yarn.lock ] && have yarn; then step "yarn install"; yarn install
  elif { [ -f bun.lock ] || [ -f bun.lockb ]; } && have bun; then step "bun install"; bun install
  elif have npm; then step "npm install"; npm install
  else echo "package.json found, but no Node.js package manager is installed." >&2; exit 1
  fi
fi

if [ -f Cargo.toml ]; then
  have cargo || { echo "Cargo.toml found, but cargo is not installed." >&2; exit 1; }
  step "cargo fetch"; cargo fetch
fi

if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  if have uv && [ -f pyproject.toml ]; then step "uv sync"; uv sync
  else
    have python3 || { echo "Python files found, but python3 is not installed." >&2; exit 1; }
    [ -d .venv ] || { step "python3 -m venv .venv"; python3 -m venv .venv; }
    if [ -f requirements.txt ]; then step "pip install -r requirements.txt"; .venv/bin/pip install -r requirements.txt
    else step "pip install -e ."; .venv/bin/pip install -e .
    fi
  fi
fi

if [ -f go.mod ]; then
  have go || { echo "go.mod found, but go is not installed." >&2; exit 1; }
  step "go mod download"; go mod download
fi

if [ "$did" -eq 0 ]; then
  echo "Nothing to set up yet: no package.json, Cargo.toml, pyproject.toml, requirements.txt or go.mod."
fi
