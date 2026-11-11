# {{name}}

A project set up for coding agents from its first commit.

- `AGENTS.md` tells any agent (Codex, Claude Code and others that read it) how
  to work here: how to set up, how to test, and what done means.
- `CLAUDE.md` points Claude Code at `AGENTS.md`, so both read the same rules.
- `scripts/setup.sh` installs what the project needs.
- `scripts/test.sh` runs the project's checks.

Both scripts find the toolchain from the files in the project (`package.json`,
`Cargo.toml`, `pyproject.toml`, `go.mod`, a `Makefile`), so they keep working
once the first code lands. Until then they say there is nothing to do yet.

## Getting started

```sh
scripts/setup.sh
scripts/test.sh
```

Then start a session and describe the first thing to build. Keep `AGENTS.md`
up to date as the project takes shape: it is what every new session reads first.
