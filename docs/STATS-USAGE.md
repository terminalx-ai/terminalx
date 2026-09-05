# Saved Stats & Usage

Stats & Usage reads the last successful combined result before refreshing local
transcripts. The page uses the app-level `statsUsageStore` subscription; unmounting
only removes a reader. The backend owns the worker, so a refresh also survives a
renderer reload. An app restart reads the persisted result.

`stats_usage_snapshot` returns the saved snapshot, scope, generation, refresh
status, and last error. It loads a compact file once per data scope and thereafter
reads memory. It does not load the scanner cache, discover sources, run Git, or
wait for scanning. `stats_usage_refresh` takes the reader's observed scope and
generation and starts or joins work immediately. Requests with an older generation
return the current state, including when they arrive just after completion. The
frontend polls every 500 ms while work is active, even without page subscribers.

The worker builds a candidate from all supported provider histories and the
existing app-stat collector. It reuses `stats-usage-cache.json` projections by
path, modification time, and size. Discovery, transcript I/O, worktree/scope reads,
app reads, and persistence must succeed before publication. Confirmed missing
sources are removed; other I/O errors abort the candidate. Existing parser rules
for unrelated/malformed transcript records, attribution, token accounting,
deduplication, PRs, and agent activity otherwise remain in place. Changes to the
activity collector tracked by #111 feed into this same candidate.

Only after the complete result is saved does the backend replace the snapshot and
its success timestamp. The frontend replaces all metrics and charts together.
While refreshing, saved content stays undimmed and interactive, with a spinning
Refresh button and live status. Errors retain the snapshot and timestamp and offer
Retry. The initial scan-loading panel appears only after a cached read confirms
there is no usable snapshot. The heatmap's date range uses the snapshot timestamp,
so even its padding remains stable until the next successful refresh. A new scan
recomputes the local-day cutoff even when all transcript projections are reused.

## Persistence and scope

`stats-usage-snapshot.json` lives under the active `RACCOON_HOME`. It contains only
display aggregates plus the display calculation schema, scanner schema, and source
namespace (canonical app data root, user home, and predecessor data root). Worktree
membership is rediscovered during refresh: a saved result describes membership at
its successful timestamp, rather than requiring a Git walk to render historical
data. The enabled provider set is currently fixed in the aggregator.

Bump `DISPLAY_SCHEMA` in `src-tauri/src/stats/saved.rs` when calculation, pricing,
attribution, enabled providers, or app-stat definitions become incompatible. Bump
`CACHE_SCHEMA` when per-file projections become incompatible. Unknown versions,
corrupt files, unrelated scopes, and missing success timestamps are rejected with
an explicit recovery error and repopulated by a complete refresh.

Publication checks scope and generation under the store lock before saving, so a
late candidate cannot replace another scope or a newer generation. Writes use the
existing private temporary-file, file-fsync, and atomic-rename helper, then sync the
parent directory on Unix. Reads ignore interrupted temporary files. No display
writes are deferred after publication. Orderly application exit acquires the
publication lock to drain pending writes and prevents unfinished scans from
publishing during shutdown.

## Verification and timing

The UI and subscription tests use delayed promises for cached rendering, remounts,
renderer restart, one shared refresh, completion while closed, failures, retry,
and out-of-order responses. Backend tests exercise persisted reloads, actual
provider parsing blocked on app reads, duplicate requests, invalid scope/version,
corruption, interrupted and failed writes, retry, late generations, and shutdown.

Run the deterministic regression tests:

```sh
pnpm test src/components/stats/StatsUsageView.test.tsx src/lib/statsUsageStore.test.ts
cargo test --manifest-path src-tauri/Cargo.toml stats:: --lib
```

The explicit large-history harness runs both production provider parsers,
aggregation, incremental projections, durable display persistence, and a fresh
backend store read. Its generated history uses unique event identities so normal
deduplication remains active. It creates and removes a temporary history; it does
not modify the user's saved analytics.

```sh
cargo test --manifest-path src-tauri/Cargo.toml large_history_readiness --lib -- --ignored --nocapture
```

Measured on the development Mac on 2026-09-05, with 1,742 files, 222,976 events, and
281.3 MiB of generated Claude/Codex transcripts:

| Operation | Time |
| --- | ---: |
| Persisted display read in a fresh backend store | 0.191 ms |
| Full transcript scan and projection write | 1,610 ms |
| Incremental scan and projection rewrite | 479 ms |

The display file was 1,616 bytes; the projection cache was 85,935,920 bytes. The
saved-read timing measures backend data readiness, not Tauri IPC or browser paint.
Delayed DOM tests separately verify that saved metrics render while refresh is
unresolved. These are warm-filesystem development timings, not a hardware-independent
latency guarantee; the blocked-worker regression establishes independence from
scan duration without a brittle absolute timing threshold.
