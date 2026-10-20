# Continue in New Session

The active agent header opens the continuation dialog. “New session” here
means a new `TabEntry` in the existing `SessionEntry`: the same checkout,
branch, and uncommitted files, with a fresh provider identity. Creation uses
`addTab` with exactly the launch settings chosen in the dialog. It never
invokes `fork_session` or `tab_handoff`.

## Launch settings

The dialog chooses agent, model, effort, and permission mode with
`SessionAgentControls` and `useSessionAgent`, the same controls New Session and
issue starts use, as a controlled form (`{ value, onChange }`). It starts from
`handoffStart`: the source tab's own settings (a pending model, effort, or mode
it was asked to switch to counts as its own), each kept only while it is valid:

- The provider must be installed; otherwise the saved provider, then the first
  installed one.
- The model must be in that provider's current list. A retired model or another
  provider's id falls back to the provider's saved model, then its default.
- The effort must be one the model takes; otherwise the saved effort, then the
  model's default.
- The mode must be one the picker offers (older spellings are mapped). A mode
  the agent reported that the picker does not offer (Claude Code's `dontAsk`,
  a Codex approval and sandbox) starts as "Ask every time", never as the saved
  mode, which could be looser than the source (Bypass).

Switching provider falls back to that provider's saved model and effort. The
mode is provider-independent and carries over. Bypass permissions goes through
`chooseMode`, so it asks once, as everywhere else. The choices are this
launch's own and are not saved as preferences, like the cloud forms' and
unlike New Session's. The controls lock once the destination exists, so a
retry never launches different settings.

## Link a chat to a project

“Link to a project” in a chat's row menu opens the same dialog with a
destination: the project and, for a Git project, a worktree or the main
checkout (switchable in the dialog). `moveChatToProject` creates a session in
the project with the chosen settings, starts it, and only then archives the
chat. If the start fails, the chat stays where it was and the error says so;
Retry Start reuses the session already created. A chat that cannot be
archived does not hold the handoff back: the context is still sent and the
dialog says the chat is still listed, with nothing left to retry. The reader
may open the new session while it is still starting; a failure after that
reaches the sidebar's error banner. The prompt tells the agent its
working directory changed, since the files the history mentions stay in the
chat's folder. The dialog is mounted by the sidebar rather than the chat's row,
because archiving removes the row.

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
  `useSessionAgent.test.ts` covers the source defaults and every fallback;
  `moveChat.test.ts` covers the move's settings, archive ordering, and retry.
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
