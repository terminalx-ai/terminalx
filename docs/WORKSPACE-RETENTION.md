# Workspace cleanup and conversation retention

Workspace removal defaults to **Remove workspace, keep conversations**, through
the existing settle transition. The dialog names the destination project folder
before confirmation. It stops agents, removes the checkout, and retains session
entries, TerminalX logs/attachments, provider-native resume files, and original
workspace name/path/branch. These entries remain grouped as removed workspaces;
they are not silently relabeled as conversations originally started on main.
Opening a kept tab starts/resumes it in the named project folder. Cancel cleanup
if that is not the desired destination. The original checkout and its uncommitted
files are not restored by resuming a conversation.

Claude Code resolves the conversation by identity across its project transcript
folders. Codex resumes the same identity from its managed rollout history.
Both require surviving provider-native files and an installed, authenticated CLI.
TerminalX's readable chat log is not a replacement for those files. In particular,
Codex's existing Fork action starts a fresh provider thread over the copied local
log; it does not fork the provider-native conversation. Continue in New Session
can carry context when native resume is unavailable, but cannot recover erased
history. These are provider limitations, not an accounting recovery mechanism.

**Permanently delete conversations too** is a separate choice in the workspace
dialog. Session deletion, bulk cleanup, and automatic merged-workspace cleanup
explain the same policy: TerminalX logs and attachments are removed, and owned
Claude transcripts/side data and managed Codex rollouts may be permanently removed.
Shared histories needed by another retained session (including an unmaterialized
fork's parent) and manually adopted conversations are protected. Deletion is not
sidebar hiding. Conversation deletion has no Trash, undo or automatic export;
copy what is needed before confirming. Automatic cleanup's checkout restoration
cannot restore erased conversations. Archiving a session keeps its history.

The main project checkout is protected under both retention choices. Missing
worktrees still require confirmation of the unverifiable checkout state; keeping
their conversations retains the same provenance and resume identities. Existing
checks for changed session membership and local work remain in effect.

## Cloud boundaries

The single-worktree cloud removal RPC currently supports deletion only. The UI
starts with keep selected but disables removal and explains the limitation. Its
adapter also rejects a keep request before sending any RPC, so a caller cannot
silently turn retention into permanent deletion. Use **Clean up worktrees** on a
connected runtime with cleanup support to retain conversations, or leave the
workspace intact. Existing bulk/merged cleanup uses the runtime's retention-aware
contracts. A stopped, disconnected, older or unauthorized runtime is not a reason
to fall back to deletion. Local Stats & Usage does not scan cloud transcripts.

## Accounting

The existing `stats-usage-cache.json` retains compact event accounting after
provider history removal. It stores no prompts or response bodies merely for
accounting. `stats-usage-snapshot.json` stores display aggregates; the independent
activity ledger retains recorded starts, work time and PRs. Shared/forked copies
are reconciled by event identity, including copies restored after deletion.
See [Saved Stats & Usage](STATS-USAGE.md) for migration and scope details.

Refresh before deletion to record recent surviving history. Files erased before
any successful scan cannot contribute invented historical totals. The overview
shows the latest 30 local calendar dates as of its refresh, so it can decrease as
dates leave that window. Local costs are estimates, not provider bills. Deleting
local history never refunds tokens or resets provider-side usage.

## Validation

Disposable native fixtures cover keeping both providers' histories after
removing an existing or already-missing worktree, persisted original context, the actual resume-file
resolvers, and later explicit deletion of those files. Existing session/agent-data
regressions cover ordinary removal, shared conversations, forks, adopted history,
main protection and failed/changed cleanup. Existing runtime cleanup regressions
cover retention through cloud cleanup contracts. Reconciliation tests cover both
providers, shared copies, deletion/reload/reappearance, cost retention, legacy
migration and absence of prompt contents in accounting. Dialog/adapter tests cover
the safe default, explicit destructive choice, resetting it on reopening, main
protection, second confirmations and rejection of unsupported cloud retention.

A disposable built-app WebKit harness checked both retention choices in light and
dark at 1000×860 and 1360×860: all eight dialogs fit without horizontal overflow;
screenshots were inspected. This used the existing synthetic Tauri bridge, never
the installed desktop app or a live session. It verifies layout, not native IPC.

These fixture checks do not prove a live CLI successfully resumes after cleanup.
No real sessions or historical provider files were modified. No installed app was
launched, restarted or automated for this issue. A coordinator's remaining manual
check is to use a disposable development home and synthetic Claude/Codex sessions,
refresh usage, choose keep, reopen each tab in the displayed project folder, and
verify provider continuation. Repeat explicit deletion and refresh/restart; verify
recorded usage within the same date window. Inspect the dialog in both themes and
small windows. For cloud, use a disposable connected runtime and confirm the
single-action limitation and retention through Clean up worktrees. Do not perform
these steps on reviewer sessions or other real history.

On 2026-10-24 all four CONTRIBUTING checks passed: TypeScript, 3,344 frontend
tests, Clippy with warnings denied, and 2,197 Rust unit tests plus 8 integration
tests (14 pre-existing ignored tests). Native commands used `CARGO_BUILD_JOBS=2`,
the macOS SDK from `xcrun`, and private temporary `TERMINALX_HOME` and
`CLAUDE_CONFIG_DIR` directories. The recorded-history regression and both-provider
keep/delete fixture passed within the full Rust run. The authenticated-provider
and live-cloud manual checks above remain unperformed.
