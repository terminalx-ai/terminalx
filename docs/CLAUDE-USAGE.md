# Claude account usage rollover (#119)

This concerns the account's five-hour rate-limit window, separate from conversation
context and historical usage statistics.

## Investigation and reproduced failures

Compared the local Legacy checkout at `6e07f4ba0ab39dd61ae7cfc69cb53380ad38a47a`,
including `rate-limits/service.ts`, `claude-usage-window.ts`,
`claude-usage-refresh-plan.ts`, and the live-Claude, refresh-orchestration and
window-activation service tests. Legacy's normal background interval is also
15 minutes. Its changed-sample acceptance, explicit refresh and attribution/race
handling are the relevant comparisons.

Three deterministic failures were observed before their fixes:

- `cargo test --manifest-path src-tauri/Cargo.toml changed_live_rollover --lib`
  rejected the changed post-reset live sample inside the 15-second dedup interval.
- `pnpm exec vitest run src/components/layout/StatusBar.test.tsx -t 'marks the expired'`
  rendered `100% usednow` after the controlled clock crossed the deadline.
- `oauth_one_percent_after_rollover_is_one_percent_not_one_hundred` returned
  `100.0` for OAuth `utilization: 1`. Legacy treats this field as a percentage.

These prove implementation defects, not which source or delay caused the original
screenshots. The regression samples are synthetic pre/post-reset payloads, not
captured traffic from the reporter's account.

## Behavior

Changed percentages or reset deadlines publish immediately. Identical samples
remain deduplicated, including across tabs. Partial live and OAuth responses keep
omitted weekly/Fable windows.

For the same account/window key, a later reset deadline wins over an earlier one.
Deadlines within 60 seconds are the same window (#729), and there the newer
observation wins; OAuth observation time is request start. Live data wins a
timestamp tie against OAuth. See "Matching and refresh outcomes" below. Snapshot revisions
prevent delayed command responses or events from rolling back the frontend store.
All three usage surfaces subscribe to that store. Claude refresh results publish
before waiting for the separate Codex app-server refresh.

A known deadline schedules one active-window revalidation and one follow-up at
least 60 seconds after the first attempt. After those two checks, ordinary
15-minute polling resumes. Focus/visibility also revalidates, including a deadline
whose timer fired while the app could not poll. Backend attempt tracking prevents
focus or repeated old-window responses from restarting the reset loop.

Manual Refresh bypasses ordinary polling debounce, waits for any in-flight call,
and respects provider backoff. Failures back off exponentially from one minute to
four hours; Retry-After seconds and HTTP dates can extend that deadline. The
popover explains retry pauses and transport failures. No credential refresh,
login, account switching, CLI usage generation or new provider source is added.

Reading Claude Code's login is local (#664): on macOS, `/usr/bin/security
find-generic-password -w` for `Claude Code-credentials`, then
`~/.claude/.credentials.json`. Claude Code writes that item with `security`, so
reading it through `security` raises no Keychain prompt for TerminalX. The item
holds an entry per MCP server Claude Code has signed in to and can reach
several kilobytes, so its output is drained while `security` runs; read only
after exit, a payload larger than the pipe buffer blocked it until the
three-second deadline. A failed read is reported as timed out, failed with its
exit code, not found (`security` exit 44), or holding no access token (with the
payload's size), never with the payload. Such a failure backs off the timer as
any other, but manual Refresh clears that backoff and tries again at once; a
failure of the request itself, or a provider's Retry-After, still holds it.

Expired Claude windows keep their last-known percentage, show an expired/stale
label and muted meter, and remain stale even when recently received. A status
line or endpoint reply repeating that expired window replaces nothing (#738).
Each detail window has its own freshness label. No elapsed-time path invents
0%: only the provider's answer shows a window as not started (below).

Usage attribution hashes the canonical Claude config path, account UUID and
organization UUID. It is captured before CLI launch, checked against the
status-line forwarder's current identity, and compared with the system account.
Account changes clear only Claude data and fence in-flight OAuth responses by
generation. Unknown or mismatched attribution is not merged, and the detail
card says so (below). A custom
`CLAUDE_CONFIG_DIR` uses its own credentials file and cannot fall back to another
account's default Keychain entry. Missing attribution/credentials yields visible
refresh feedback; it does not trigger authentication changes.

## Automatic refresh (#407)

Settings → Appearance → **Usage auto-refresh interval** offers Off, 1, 2, 5 and
15 minutes, one minute by default, stored as `statusBar.usageRefreshMinutes`. A
value outside that list reads as the default. The "ordinary 15-minute polling"
above is now this interval; fifteen minutes remains the floor for focus and
visibility refreshes when the timer is Off.

The frontend keeps one timer (`createUsagePolling`). It arms the next tick only
when the previous refresh settles, so a slow request is never overlapped and a
wake from sleep produces one late tick, not a replay. Changing the setting
re-arms that timer from the last tick. Each window has its own timer; the
backend is the arbiter: `status_usage_refresh` reads the interval per request and
reuses the last answer until one interval (less five seconds of slack) has
passed, with one request in flight per provider. Focus, visibility, `online`,
manual Refresh and reset-boundary revalidation are unchanged and share the same
gate. Usage refreshes need the window visible, not focused. While the usage
indicator is hidden the timer stops and the fifteen-minute floor applies, as it
does with the timer Off. The first tick is timed from the boot refresh.

The interval is a normal cadence only. Failure backoff and Retry-After still
gate every request, manual ones included (except after a local credential read
failure, above), and an account change starts its own cadence. A failure keeps the last windows. Snapshots carry `lastSuccessAt` for
Claude and a `codexRefresh` block (`retryAt`, `error`, `lastSuccessAt`); the
agent detail panel shows "Last refreshed …" and, while paused or failed, that
the values are last known. Since #729 "Last refreshed" counts only answers that
replaced a window; see below.

## Matching and refresh outcomes (#729)

A refresh could report success, set "Last refreshed just now", and change no
window, with nothing saying why. The two Claude sources write one deadline
differently: the status line in whole epoch seconds, the usage endpoint as an
RFC 3339 time with fractions that moves between requests. A strict comparison
read the endpoint's window, a fraction of a second earlier, as the previous
window and dropped it on every refresh; the next turn's whole seconds could be
dropped the same way against it.

Each received window now gets a verdict against the window shown under its key
(`judge` in `status/usage.rs`):

- **Taken**: nothing shown under the key; a deadline more than 60 s later (the
  next window); the same window (deadlines within 60 s) observed later; or no
  deadline once the shown window's deadline has passed (a window not started).
- **Refused**: a deadline more than 60 s earlier (a late receipt of the previous
  window, such as an idle tab's last sample); the same window observed no later;
  a deadline that had passed when the shown window was observed; the same window
  observed after its deadline (`endedWindow`, #738: it does not confirm a reset);
  or no deadline from a status line while the shown window still runs. Only the
  endpoint's fresh answer may say a running window has none.

The endpoint names an account window with nothing running (`five_hour`,
`seven_day`) as `null`, or with neither utilization nor deadline. That is read as
a window not yet started, 0% with no countdown, and it replaces an expired one.
An endpoint window whose deadline had already passed more than 60 s before the
request is shown the same way: none of its usage still counts. Within 60 s of
its deadline it may not have rolled yet, so it is refused as `endedWindow`: the
shown window stays as it was, the answer is not an update (the card says
"Checked … · no newer usage" and "5h kept: the reply still had the window that
just expired"), and the follow-up check a minute later settles it.

The snapshot carries the outcome. `claude.lastUpdatedAt` is the last answer
that replaced at least one window; `lastSuccessAt` the last answer at all. The
card's "Last refreshed" is the later of `lastUpdatedAt` and the newest window
(a runtime that sends no `lastUpdatedAt` falls back to `lastSuccessAt`). When
the provider answered after that and replaced nothing, the card adds "Checked
just now · no newer usage", and `claude.refused` gives each kept window's
reason; the card lists those that leave an older window up.

Live usage refused for attribution (the system account cannot be identified,
`unidentified`; the tab captured no account when it started, for example before
Claude Code was signed in, `launchUnknown` (#738); the tab started under another
account, `launchMismatch`; or the status line reported another,
`statuslineMismatch`) is `claude.liveRefused` while it is newer than any live
sample used. The card shows it as a warning; it is not shown beside newer live
data.

A manual refresh that does not reach the provider records `skipped` (`reason`:
`inFlight`, `retryPending`, `recent`, `resetInFlight`; and `nextAt`, when the
button will fetch again). The popover says so: "Codex was refreshed 2m ago ·
Next refresh available in 3m", or that a refresh is already out. A retry pause
keeps its own notice. Automatic skips are routine and are not recorded.

Every refresh is logged at info: each received window (key, percent, reset
deadline), what became of it and why, the result ("updated 2 of 3", "no newer
usage", or the failure with its retry pause), and any shown window the reply
left out, which stays as it was. Account refusals of live
usage are logged when they start; manual skips at info, automatic ones at
debug.

## Validation and remaining live check

Automated coverage includes controlled-clock rollover, changed/identical samples,
expired snapshots, delayed OAuth success/failure, partial updates, account changes,
Retry-After, bounded reset scheduling, background/focus activation, command/event
ordering, manual refresh during a background call and cross-surface rendering.

The full frontend check passed (298 tests), and the Rust library suite passed
(307 tests, one existing ignored test).

**Real-account comparison remains unverified.** On 2026-09-05, the connected app
answered `terminalx status --json` but rejected the computer-use capability probe
with `Unknown control command computer.capabilities.` No shared account or
upcoming reset was confirmed during this work, and no live five-hour reset was
observed. The original discrepancy's duration and source remain unknown.

To finish that acceptance check, confirm both apps' Claude account/config before
observing an actual reset. Record UTC observation times, app versions, the raw
five-hour percent/reset deadline and source for each pre/post sample, and all
three rendered values. Raccoon's snapshots now expose `source`, per-window
`updatedAt`, opaque `claudeAccount`, `revision`, `retryAt` and `revalidateAt` for
attribution. OAuth `updatedAt` is request start; also record response arrival time.
Capture Legacy's source metadata alongside its rendered value: a display-side
0% alone is not proof of a provider-confirmed reset. Keep credentials and account
identifiers out of shared captures.
