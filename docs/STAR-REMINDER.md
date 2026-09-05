# GitHub star reminder

`src-tauri/src/star_nag.rs` owns eligibility, actions and the atomic local
`$RACCOON_HOME/star-reminder.json` file. Its durable fields are the launch count,
baseline, next threshold, cooldown deadline, app version, permanent completion
flag and version that consumed the successful-work trigger. No telemetry is added.

SessionManager records the first successful agent process spawn for each tab
created during this app run. The owner seeds its seen set from the saved index
at startup: restoring sessions, restarting their processes and switching tabs
cannot inflate usage. Deleting tabs never reduces the durable count. Failed
spawns do not count. No transcript scan or stats snapshot drives eligibility.

Live nonempty user prompts followed by successful turn completion qualify for
the separate once-per-version trigger. Queued prompts, subagent events, errors,
interruptions and idle/resume boundaries do not qualify. Working and waiting
agents block it. A one-shot debounce waits 1.2 seconds after completion/input;
activity and typing are checked again after GitHub returns. A prepared result
waits locally when activity resumes, without repeating the lookup.

The initial threshold is 35. Later, close, Escape and a successful browser handoff
set a three-day cooldown, double the threshold and reset the baseline. Both the
cooldown and additional usage are required. An app update resets the baseline
and initial threshold but preserves cooldown, completion and consumed-version
state. A completion during cooldown consumes that version's completion opportunity,
as in Legacy. GitHub-confirmed stars and successful direct actions suppress the
reminder permanently.

The repository homepage comes from `src/lib/repo.ts`; the Rust build embeds that
same constant. The existing `gh` launcher checks GitHub's `viewerHasStarred` field
on github.com. Only an explicit boolean false enables direct starring. Missing
CLI/auth, errors and unknown responses offer the system-browser fallback. Requests
time out after 15 seconds. Starring is a PUT only after a click; a failed PUT
never opens a browser automatically. Opening the browser defers and never marks
completion. The existing Tauri opener performs the browser handoff.

One owner serializes eligibility and actions. Generation guards discard stale
results after dismissal; revisioned snapshots keep frontend responses ordered.
Reminder preference writes are atomic. Unreadable saved state disables reminders
for that run without overwriting the file or blocking app startup.

## Development preview

Run `pnpm dev` and open
`http://localhost:1420/?preview=star-reminder`. Add `&starMode=direct` to inspect
the direct-star label. This development-only mode uses the real card in the
AppShell notice stack. Its buttons hide the preview locally: they make no reminder
commands, GitHub requests, browser navigation or preference writes. Reload to
show it again. It is disabled in production builds.

Inspect both theme modes, narrow windows, keyboard focus, notice stacking and
Escape. Dialogs hide the reminder while preserving agent notices. The reminder
has no auto-dismiss timer and does not focus itself.

## Automated checks

- `pnpm vitest run src/components/ui/StarReminder.test.tsx`
- `cd src-tauri && cargo test --lib star_`

Backend tests use explicit clock values and temporary persisted files. CLI boundary
tests launch local test subprocesses and verify the exact host, repository and
method, without using a real GitHub account. Component tests mock Tauri events and
commands and cover actions, busy state, fallback, stale replies, focus and Escape.
