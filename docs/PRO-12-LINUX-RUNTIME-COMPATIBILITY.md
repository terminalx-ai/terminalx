# PRO-12 Linux runtime compatibility review

**Superseded.** This page used to close PRO-12 on analysis alone: it reviewed the Tauri
desktop's Linux build, not the runtime a cloud workspace runs. That runtime is now the
headless `terminalx-serve` (PRO-42), and PRO-12's validation ran against it on Linux:

- what was verified, and how to run it: [HEADLESS-SERVE.md](HEADLESS-SERVE.md), "Testing on
  Linux" (`scripts/remote-runtime/e2e-linux.sh`);
- parity with the legacy AppImage runtime and what is still open: terminalx-saas
  `apps/api/docs/cloud-workspace-serve-parity.md`.

## Legacy AppImage diagnostic

The September 21 audit predates the headless runtime delivered in
[PR #198](https://github.com/terminalx-ai/terminalx/pull/198). Its recommendation
to retain Electron and its missing-client findings are historical, not the
current implementation status. The selected runtime and Linux validation remain
those linked above.

For hosts still running the older Electron AppImage, the read-only
[linux-runtime-probe.py](../scripts/linux-runtime-probe.py) verifies the archive
against an approved build digest and requests `status.get` over the installed
runtime's authenticated Unix socket. It reports the app version, protocol,
advertised capabilities and a hash of the runtime ID without dumping metadata
or credentials. It does not support `terminalx-serve`'s protocol.

Run it on that Linux host as the runtime owner:

```sh
python3 scripts/linux-runtime-probe.py --sha256 "$APPROVED_RUNTIME_SHA256" \
  --metadata "$RUNTIME_METADATA_PATH" > runtime-preflight.json
```

The default archive is `/opt/terminalx/TerminalX.AppImage`; metadata is the
installed `terminalx-runtime.json`. Obtain the expected digest from the approved
build, not the host's saved SHA marker. Exit 0 means archive verification and
local status RPC succeeded. It does not establish extracted-tree integrity,
which binary the service is running, persistent host-key continuity, remote
client compatibility or working agent PTYs, hooks, transcripts and file/Git RPC.
Those require the runtime-specific integration tests above. A non-Linux host,
wrong digest, invalid metadata or failed RPC returns a nonzero exit status.

The historical audit found marker-only verification on fast resume, a lost
redeem-response recovery gap, and token deletion before redemption in the
lightweight relay entrypoint. Those observations applied to SaaS revision
`82144ba1a0986c887bd2dfc073a371da03dbfd7b` and Electron revision
`b9ce884b7cd00a8369acaac5f99746f8a6f86c6a`; they are not assertions about current
deployments or the replacement runtime. The original audit did not run live
Linux qualification.

Run `python3 scripts/linux-runtime-probe.test.py` for the diagnostic's bounded
Unix-socket fixtures, identity checks, corrupt metadata and artifact tampering
coverage. CI runs these on Linux and macOS; fixtures do not count as live
installed-runtime validation.
