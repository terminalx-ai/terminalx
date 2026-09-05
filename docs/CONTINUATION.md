# Continue in New Session

The active agent header opens a provider/context picker. “New session” here
means a new `TabEntry` in the existing `SessionEntry`: the same checkout,
branch, and uncommitted files, with a fresh provider identity. Creation uses
`addTab` and the destination provider's ordinary model, effort, and permission
preferences. It never invokes `fork_session` or `tab_handoff`.

`prepare_continuation` runs on a blocking worker. It reads the source runtime's
existing transcript tracking without instantiating a runtime; inactive tabs
fall back to the Claude transcript path or the matching Codex rollout in the
managed/user home. File readability probes and status extraction are bounded.
The original file remains the full-history reference, including early turns;
no full transcript crosses the renderer boundary. The app's persisted log can
supply a partial recent conversation capture, limited to 36,000 characters,
when native history is unavailable. Such a capture never enables full mode.
Status hints are limited to 6,000 characters each, with omissions marked.

Focused mode starts with status hints and the current files, allowing selective
history reads. Full mode asks the destination to read the entire saved file
before continuing. Both modes fence historical data, strip terminal controls
from captured hints, disregard instructions in untrusted tool output, preserve
the source session/transcript, and defer to current workspace files. A source
that is still working is explicitly identified; preparation does not interrupt
it or answer its pending permissions. Escape in the dialog cannot reach the
source chat's interrupt shortcut.

Continuation uses `send_message` with `confirmDelivery: true`. This runs the
ordinary PTY input machinery, waits for readiness, and waits up to 90 seconds
for the provider transcript to echo the submitted prompt. A created tab or a
locally rendered user message is not delivery confirmation. A readiness or
write failure is returned; an echo timeout is reported as uncertain delivery.
The dialog prevents duplicate clicks, retries launch failures in the same tab,
and leaves the prompt in the destination composer after a delivery failure.
Users can inspect the chat/terminal before retrying an uncertain delivery.

## Verification

- `pnpm check` covers selection, availability, cancellation, resetting the
  dialog, duplicate clicks, both prompt modes, and all eight provider/mode
  combinations at the launch boundary, including failures and retry defaults.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` covers bounded context
  preparation, original file preservation, missing/unreadable history, control
  sequences, and provider-echo confirmation, alongside the existing CLI launch
  and readiness tests.
- `scripts/smoke-continuation.mjs` runs inside the dev desktop webview against
  installed and signed-in providers. Its header documents how to run it in a
  disposable Git checkout. It checks fresh identities, cwd, selection, exactly
  one prompt, actual agent reads, unchanged source transcript bytes, and the
  real header/dialog. `sourceProviders` and `destinationProviders` may narrow
  the matrix when an account is unavailable. Full mode can take substantially
  longer because provider transcripts include their original instruction data.

### Live verification on 2026-09-05

Tested with Claude Code 2.1.261 and codex-cli 0.153.2, in an isolated app home
and disposable checkout. All eight combinations confirmed a provider transcript
echo, exactly one new selected tab/prompt, a fresh destination provider id,
the same cwd, and unchanged source provider id and transcript bytes.

| Source | Destination | Focused | Full transcript |
| --- | --- | --- | --- |
| Claude Code | Codex | Task completed | Task completed |
| Codex | Codex | Task completed | Task completed |
| Claude Code | Claude Code | Delivered; account limit | Delivered; account limit |
| Codex | Claude Code | Delivered; account limit | Delivered; account limit |

Codex recovered the early context markers and inspected the existing untracked
file. The Claude source itself had reached its session limit, exercising that
handoff use case. Claude destinations accepted their prompts and reported the
same account limit (reset reported as 05:30 Asia/Dubai), so execution past
prompt delivery still needs a Claude smoke run after quota is available. The
Codex-source smoke also opened and canceled the real header dialog.
