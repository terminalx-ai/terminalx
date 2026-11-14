# {{name}}

Instructions for coding agents working in this repository. Read this file
before making changes, and keep it current when the project changes.

## About this project

Describe what the project is, who it is for and what matters most about it.
Until this is filled in, ask before making large structural choices.

## Setup

```sh
scripts/setup.sh
```

Installs dependencies for whichever toolchain the project uses. Run it after
cloning, after switching to a new worktree and after changing dependencies.

## Checks

```sh
scripts/test.sh
```

Runs the tests, linters and type checks the project has. Run it before every
commit and fix what fails. When you add a new kind of check, add it to
`scripts/test.sh` so every agent and every person runs the same thing.

## Working agreements

- Keep changes small and focused on the task you were given.
- Write or update tests with every behaviour change.
- Do not commit secrets. Keep them in `.env`, which git ignores.
- Do not add a dependency without saying why in the commit message.
- Write commit messages that say what changed and why.
- When something here is wrong or missing, fix this file in the same change.

## Done means

- `scripts/test.sh` passes.
- The change is committed with a clear message.
- Anything the next person needs to know is written down here or in the README.
