# Raccoon CLI

This file is a discovery stub, not the usage guide. The full, version-matched Raccoon CLI
reference is served by the `raccoon` binary itself — kept out of this file on purpose so it
can never drift from the binary that will actually run your commands.

Read the current guide before acting:

```text
raccoon skills get raccoon-cli
```

Use that output as the authority. Do not guess subcommands.

If an older binary explicitly reports that `skills get` is unknown, the only bounded fallback
is to inspect `$RACCOON_HOME/sessions/index.json` and the named tab's JSONL log read-only. Do
not edit the store, start a second app process, or infer write commands from this stub.
