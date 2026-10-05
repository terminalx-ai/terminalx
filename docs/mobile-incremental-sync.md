# Mobile incremental conversation sync (#347)

The phone renders its existing AsyncStorage transcript before waiting for the
connection. `sync.capabilities` advertises `transcript: 1` and
`conditionalLists: 1`; a refusal means the original bounded-tail protocol. No
new parameters are sent to an older host. Capabilities are shared by concurrent
callers and renegotiated on a new connection; list versions are cleared when
switching hosts.

## Transcript protocol

`session.sync({sessionId, tabId, cursor?})` returns:

- `events`: a forward page of at most 500 canonical log records, additionally
  bounded so the complete serialized RPC response fits within 6 MiB.
- `cursor: {offset, digest}`: record count plus a SHA-256 hash of the entire
  canonical prefix, including protocol generation and conversation identity.
- `hasMore`: another forward page is required.
- `reset`: discard previous displayed/cached history before applying this page.
- `hasEarlier`: older history exists before this page.

An absent or invalid cursor resets to the most recent 20 turns, capped at 500
records and the response-byte budget. A single event too large to fit returns a
visible error with a retry action; its checkpoint is never skipped. A valid
cursor returns only subsequent records, irrespective of turn
boundaries. An unchanged prefix returns an empty event array. The client never
uses a live event's sequence number as its checkpoint. It validates page shape
and offset progression, applies records in order, and atomically stores data and
checkpoint after each page. An interrupted catch-up resumes at the last saved
page, including gaps larger than the legacy 5,000-event tail cap.

The digest detects edits to existing records, replacement logs, truncation,
wrong conversation identity, and protocol-generation changes. These get an
explicit bounded reset, not a merge across an unknown range. Identical restored
history can keep its cursor across a desktop restart. Permission reconciliation
runs before computing a page; because reconciliation publishes events, the host
rereads canonical log order afterward, including concurrent appends. A deleted
session/tab produces `{deleted: true}` and clears the phone's copy. Index read
errors fail the request instead of impersonating deletion.

The client subscribes before the first sync request. Subscription acknowledgement
and live events invalidate the current snapshot; a single worker drains all
pages and any invalidations received while working. Repeated/out-of-order live
notifications are coalesced for 100 ms. They cannot overwrite authoritative
records or skip history. A 15-second conditional poll repairs missed
notifications, transient failures, and silent host-side changes while the pane
is connected. Repeated resets are limited to two per drain; errors retain the
last checkpoint and retry later. Navigation/reconnection cancels late results.

On an older host, the first `session.tail` on each connection replaces the
unverified cached window, buffering live events arriving during that read. A
subscription catch-up merges into the pane when it shares unchanged events with
the previous authoritative tail. This keeps a late catch-up response from
discarding pages loaded through `Load earlier` (#386). Changed or missing overlap
still replaces the window rather than joining ranges across an unprovable gap.
Older hosts are not polled repeatedly. `Load earlier` retains its existing `before`
pagination and does not advance the forward checkpoint. Its cursor comes from
the authoritative history window and remains stable during live catch-up;
failed backward reads retain that cursor and offer a retry.

## Cache and cleanup

The v2 cache key encodes `[host, session, tab]` without delimiter ambiguity. Each
record stores schema version, events, checkpoint and earlier-history flag, with
a checksum covering the complete stored data. Invalid schemas, corrupt JSON,
invalid events, cross-conversation data and checksum failures discard the
checkpoint and trigger a bounded reset. Valid old v1 arrays can still render
immediately; their first successful sync replaces them with a v2 record.

Persistence remains bounded to 500 events per conversation, as in the previous
cache. Older pages stay in retained pane memory and remain available through
on-demand pagination. This is an event-count bound, not a byte or global
conversation-count quota. A single unusually large event can still be large.

Unpairing removes that host's transcript caches and drafts, including v1 keys;
automatically paired host removal does the same. Sign-out or rejected account
refresh clears all transcript caches, drafts and retained pane state. Explicit
unpairing also clears retained pane state. Serialized writes and per-host cleanup
generations prevent in-flight sync from recreating removed data, while unpairing
an unrelated host does not cancel the active pane.

## Notes and session metadata

`chat.list` and `sessions.summaries` accept an optional content `version` only
after negotiation. Unchanged responses contain `{notModified: true, version}`;
changed responses contain the existing bounded list plus its version. The phone
retains list contents and versions in memory. Concurrent identical reads share
one request. Notes invalidations are scoped to the session and coalesced; summary
invalidations are throttled, with a trailing refresh when one arrives during an
in-flight request. Notes remain limited to 100 per response. These are conditional
snapshots, not persisted note/summary delta journals.

## Synthetic measurements

`pairing::mobile::tests::synthetic_sync_payload_measurement` creates 2,000
synthetic turns (12,000 events), with five 512-character assistant records per
turn. It serializes the actual Rust host response implementation. No private
conversation data is read. The small delta is one appended synthetic prompt.

| Case | Transcript page requests | Request bytes | Result bytes |
| --- | ---: | ---: | ---: |
| Original recent tail | 1 | 83 | 71,047 |
| Incremental cold load | 1 | 72 | 71,181 |
| Cached unchanged reopen | 1 | 174 | 163 |
| Reconnect with one new event | 1 | 174 | 348 |

The unchanged result is 99.77% smaller than the original tail; the small-delta
result is 99.51% smaller. Cold load adds 134 result bytes for checkpoint metadata.
Request bytes include method and parameters. Result bytes exclude the RPC
envelope, encryption/base64, WebSocket framing and unsolicited live broadcasts;
these are serialized application-payload measurements, not packet captures or
wall-clock latency claims.

Client tests separately check request counts: a cold process makes one capability
request and one initial transcript request; an unchanged reopen on the same
connection makes one initial transcript request; process restart/reconnect also
negotiates capabilities. Opening a pane also establishes one live subscription.
An acknowledgement racing the first snapshot can add an empty sync request.
Subsequent polling and notifications add conditional requests. Notes and summaries
are separate requests and are not included in the transcript table. The 6,100
event offline-gap test verifies every 500-record checkpoint, interruption after
the first page, and all 12 remaining requests on restart.

The host currently reads and hashes canonical log history to validate a cursor;
this reduces network transfer but is still O(total history) host work per page.
There is no persistent change journal or indexed prefix-hash cache yet. Existing
broadcasts still carry live event bodies. A rewrite triggers a bounded recent
snapshot instead of a patch to every previously viewed older page. These costs
and reset semantics are intentional limits of this protocol version.

## Verification

```sh
pnpm --dir mobile typecheck
pnpm --dir mobile test
pnpm --dir mobile lint
pnpm check
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml synthetic_sync_payload_measurement -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The mobile tests cover cold/cache-only load, unchanged reopen, fresh API restart,
small delta, large interrupted gaps, subscription acknowledgement races, live
arrivals during catch-up, duplicate/out-of-order notifications, late cancellation,
capability retries, corrupt cache, isolation, deletion, reconciliation, cleanup,
and old-host fallback. Rust tests exercise the actual cursor/hash implementation,
rewrites, truncation, conversation scope, empty logs, conditional lists and the
synthetic response-size benchmark.

Local validation after merging the oversized-transcript fix completed with 310
mobile tests, 1,988 desktop tests, and 1,289 Rust tests passing (six Rust tests
ignored). Both TypeScript checks and Clippy
with `-D warnings` passed. Mobile lint had no errors and one pre-existing
`import/first` warning in `transport/connection.test.ts`. The full Rust suite passed with `--test-threads=4`. Local Rust commands used SDK 26.5 via
`SDKROOT` / `CMAKE_OSX_SYSROOT` and `MACOSX_DEPLOYMENT_TARGET=14.0` because the
installed SDK 27 stub files were incompatible with the default linker.

For #386, the conversation-screen regression delays an old-host subscription
catch-up until after backward pagination. Before the fix, its 40 displayed turns
shrank to 20; afterward, all turns and the backward cursor remain available.
Additional sync tests cover unchanged overlap, live envelopes, reconnects,
rewritten events, and missing overlap.

A separate synthetic check exercised the production conversation pane on an
iPhone 17 / iOS 26.5 simulator with two pages of 20 turns and 200-line responses.
After the delayed catch-up, the native offset stayed at 180,394.33 px and the
oldest loaded turn stayed `t240`; **Jump to latest** remained visible.
[Native measurements](testing/mobile-pagination-386.json) contain synthetic data
only. The temporary driver reused an existing simulator binary and stubbed its
unavailable clipboard module; pairing and clipboard behavior were outside this
check. The driver and instrumentation were removed afterward.
