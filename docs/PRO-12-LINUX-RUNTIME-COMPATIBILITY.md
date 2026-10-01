# PRO-12 Linux runtime compatibility review

**Superseded.** This page used to close PRO-12 on analysis alone: it reviewed the Tauri
desktop's Linux build, not the runtime a cloud workspace runs. That runtime is now the
headless `terminalx-serve` (PRO-42), and PRO-12's validation ran against it on Linux:

- what was verified, and how to run it: [HEADLESS-SERVE.md](HEADLESS-SERVE.md), "Testing on
  Linux" (`scripts/remote-runtime/e2e-linux.sh`);
- parity with the legacy AppImage runtime and what is still open: terminalx-saas
  `apps/api/docs/cloud-workspace-serve-parity.md`.
