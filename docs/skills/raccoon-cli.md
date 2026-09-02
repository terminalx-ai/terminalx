---
name: raccoon-cli
description: Inspect Raccoon sessions and transcripts through the version-matched local binary.
---

# Raccoon CLI

Use the `raccoon` binary that belongs to the running build. This guide is embedded in that
binary, so it is the authority for the commands the installed version understands.

## Discover the current guide

```sh
raccoon skills get raccoon-cli
```

Run this before using another command. If it is unavailable, the binary predates this skill;
do not infer a newer command surface from the discovery stub.

## Read-only commands

List the sessions this Raccoon home knows about:

```sh
raccoon sessions list
```

The result is JSON containing the stored session and tab identifiers, checkout paths, agent,
status, and timestamps. `RACCOON_HOME` selects the same alternate home as the app.

Read the tail of one tab's normalized event transcript:

```sh
raccoon transcript tail <session-id> <tab-id>
raccoon transcript tail <session-id> <tab-id> --limit 40
```

The default is 80 events and the maximum is 500. This reads Raccoon's normalized event log,
not an agent provider's private transcript format.

## Boundaries

This version exposes read-only inspection only. Opening sessions, creating worktrees, sending
prompts, and running automations are not CLI operations. Do not guess subcommands or modify
Raccoon's store to imitate them; use the visible app for those actions.
