# GitHub star reminder

`src-tauri/src/star_nag.rs` owns eligibility, actions and the atomic local
`$TERMINALX_HOME/star-reminder.json` file. Its durable fields are the launch count,
baseline, next threshold, cooldown deadline, app version, permanent completion
flag and version that consumed the successful-work trigger. No telemetry is added.

Both triggers require at least three full days since the reminder first observed
the install and successful work in three distinct sessions. The first-observed
timestamp and up to three session IDs are saved across restarts and updates.
Existing installs without these fields start the same grace period; historical
work-start totals cannot bypass it or stand in for successful sessions. Multiple
turns or tabs in one session count only once. Queued prompts, subagent events,
errors and interruptions do not add a finished session.

SessionManager supplies the activity ledger's committed lifetime work-start
count. A live transition into working counts, including another turn or resuming
after waiting in the same tab. Blank tabs, optimistic submissions, same-state
updates, provider identity refreshes, replay and reconnect do not create starts.
The reminder uses that total rather than incrementing a second counter. It loads
the total at startup without triggering eligibility; only a newer live count
does that. Duplicate or out-of-order notifications are ignored.

The `usageSchema` migration rebases existing reminder usage once onto the current
ledger count, since old process-launch counts cannot be equated with work starts.
It preserves cooldown, threshold backoff, supporter completion and the consumed
completion version. Later restarts preserve the migrated baseline. The activity
ledger performs historical recovery; reminder eligibility never scans transcripts.

Live nonempty user prompts followed by successful turn completion qualify for
the separate once-per-version trigger. Queued prompts, subagent events, errors,
interruptions and idle/resume boundaries do not qualify. Working and waiting
agents block both triggers. A one-shot debounce waits 1.2 seconds after completion/input;
activity and typing are checked again after GitHub returns. A prepared result
waits locally when activity resumes, without repeating the lookup.

The initial threshold is 35 work starts. Later, close, Escape and a successful browser handoff
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
sidebar footer. The reminder reserves space within the sidebar, so it never
covers or reduces the height available for the composer or inline approval cards,
including when the window is resized or zoomed. It stays out of the way when the
sidebar is hidden. Its buttons hide the preview locally: they make no reminder
commands, GitHub requests, browser navigation or preference writes. Reload to
show it again. It is disabled in production builds.

Inspect both theme modes, narrow windows, keyboard focus, composer clearance and
Escape. Dialogs hide the reminder while preserving agent notices. The reminder
has no auto-dismiss timer and does not focus itself.

## Automated checks

- `pnpm vitest run src/components/ui/StarReminder.test.tsx`
- `cd src-tauri && cargo test --lib star_`
- `pnpm build && node scripts/webkit/star-reminder.mjs`

Backend tests use explicit clock values and temporary persisted files. CLI boundary
tests launch local test subprocesses and verify the exact host, repository and
method, without using a real GitHub account. Component tests mock Tauri events and
commands and cover actions, busy state, fallback, stale replies, focus and Escape.
