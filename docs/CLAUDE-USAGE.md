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
Within the same deadline, the newer observation wins; OAuth observation time is
request start. Live data wins a timestamp tie against OAuth. Snapshot revisions
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

Expired Claude windows keep their last-known percentage, show an expired/stale
label and muted meter, and remain stale even when recently received. Receiving
that expired window again does not advance its confirmation timestamp. Each
detail window has its own freshness label. No elapsed-time path invents 0%.

Usage attribution hashes the canonical Claude config path, account UUID and
organization UUID. It is captured before CLI launch, checked against the
status-line forwarder's current identity, and compared with the system account.
Account changes clear only Claude data and fence in-flight OAuth responses by
generation. Unknown or mismatched attribution is not merged. A custom
`CLAUDE_CONFIG_DIR` uses its own credentials file and cannot fall back to another
account's default Keychain entry. Missing attribution/credentials yields visible
refresh feedback; it does not trigger authentication changes.

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
