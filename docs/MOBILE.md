# Mobile companion app

This document is the implementation plan for an iOS companion to Raccoon. The
current change is documentation only: it does not add an Expo workspace, move
shared code, or expose a host RPC.

The app is blocked on issue #6. Sign-in, host discovery, pairing, the encrypted
channel, credential revocation, method allowlists, and reconnect behaviour must
exist before mobile product work begins. The write phases also depend on the
host-side attribution and write gate from issue #5. An unsigned-in desktop must
continue to behave exactly as it does now.

## Product boundary

The Mac remains the source of truth. The phone discovers and pairs with a Mac,
then reads or drives sessions over that Mac's encrypted connection. There is no
cloud transcript store and no phone-only session.

Version one is deliberately small:

- iOS first, built with React Native and Expo in a `mobile/` workspace.
- Four screens: Machines, Sessions, Session, and Settings.
- One active Mac connection at a time. Switching Macs is explicit.
- The existing normalized `AgentEvent` log is the only chat model.
- The existing dashboard fold is the only session-status model.
- The existing parked hook request is the only permission authority.
- No session or worktree creation, files, editor, source control, review,
  issues, automations, dictation, attachments, or browser control.
- No third-party push service. Notifications are local and are limited by
  iOS background socket lifetime.

Android is not part of version one. The shared and host contracts must remain
platform-neutral so adding it later does not require a protocol fork.

## Workspace and shared code

The repository should become a pnpm workspace only when the first product phase
starts:

```text
packages/mobile-core/
  src/events.ts       normalized AgentEvent and related payload types
  src/transcript.ts   pure event-to-transcript fold
  src/dashboard.ts    pure buckets, filtering, and ordering
  src/rpc.ts          requests, results, refusals, capabilities, and streams
  src/index.ts
mobile/
  app/                Expo Router routes
  src/components/     native mobile views
  src/connection/     pairing, host selection, reconnect, subscriptions
  src/storage/        secure credentials, host records, cursors, cache
src/
  ...                 desktop UI, importing the same mobile-core package
```

`src/types/events.ts` and `src/lib/transcript.ts` are already pure TypeScript
apart from their path alias. They move without a React or Tauri dependency.
`src/lib/dashboard.ts` is also pure but currently consumes the desktop
`SessionEntry`; its shared input should be narrowed to a portable session-card
shape. The desktop adapts its existing entries to that shape and the mobile RPC
returns it directly.

The shared package owns data and folds, not views. Desktop React components and
native React Native components render the same `Transcript`, `Turn`,
`PendingAsk`, and dashboard buckets separately. This keeps native iOS layout
without creating a second transcript implementation.

The RPC client is transport-neutral:

```ts
interface RpcTransport {
  request<T>(method: RpcMethod, params: unknown): Promise<RpcOutcome<T>>;
  subscribe<T>(method: RpcStreamMethod, params: unknown): Promise<RpcStream<T>>;
}
```

The desktop adapter can continue to use Tauri invokes and events. The mobile
adapter uses issue #6's paired encrypted channel. Neither adapter is allowed to
change method semantics or normalize events differently.

Extraction is complete only when the desktop imports the package, its current
tests pass unchanged, and parity tests feed the same event fixtures through the
old and extracted entry points. No copy of `events.ts`, `transcript.ts`, or the
dashboard fold may remain under `mobile/`.

## App shell and navigation

Use an Expo development build rather than Expo Go. Pairing crypto, device-only
credential storage, local notifications, and the terminal surface all need to
be verified against the native iOS runtime.

The root uses a native tab bar for Machines, Sessions, and Settings. Session is
pushed from Sessions and keeps the tab bar available. Large titles, pull to
refresh, swipe actions, native sheets, and safe-area insets are preferred over
desktop-style panels.

Proposed routes are:

```text
/(tabs)/machines
/(tabs)/sessions
/session/[hostId]/[sessionId]
/(tabs)/settings
/auth/callback
```

The OAuth redirect registered by issue #6 should be
`raccoon://auth/callback`. Notification deep links use
`raccoon://session/<hostId>/<sessionId>?tab=<tabId>`. Cold-start, warm-start,
and already-open handling are all required; a callback or notification may not
depend on an existing navigation tree.

The app reuses the four palette IDs and semantic token vocabulary from
`src/styles/tokens.css`: surface, raised surface, foreground, muted ink,
hairline, accent, warning, and destructive. Native colour maps implement those
tokens for light and dark appearance. The phone does not copy the desktop rail,
window chrome, or composer animation.

## Screen 1: Machines

Machines is both the signed-out landing screen and the signed-in host
directory.

Signed out, it explains that sign-in discovers the reader's Macs and that QR or
code pairing works without an account. Sign-in uses issue #6's user-scoped
OAuth 2.0 + PKCE session. The mobile session deliberately has no selected
profile or active organisation.

Signed in, each directory row shows the host label, platform, compatibility,
and relative liveness such as `Live · 2m ago · macOS`.

- Live compatible hosts can be selected.
- Offline, stale, and incompatible hosts remain visible but are disabled.
- A host becomes stale after two missed heartbeats.
- Hosts already paired on this installation do not appear in the discovery
  list; they appear in Settings instead.
- Pairing never starts merely because a host is visible. The reader taps Pair.
- Every discovery or pairing failure offers both Retry and Use QR code.
- QR and code pairing remain available whether or not the reader is signed in.

The UI gives these states distinct copy and progress treatment:

| state | presentation |
| --- | --- |
| `loading` | Loading machines |
| `connecting` | Connecting · Requesting secure credential |
| `reauthentication_required` | Sign in again to verify this installation |
| `awaiting_approval` | Awaiting approval on the Mac |
| `incompatible` | Incompatible; show the required host protocol |
| `offline` | Offline; disabled but still visible |

A successful deliberate pairing mints a credential unique to the installation
and host. The app verifies that the public key in the encrypted offer matches
the directory record before storing anything. Failed or cancelled pairing
revokes the grant and removes partial local state. A logout epoch prevents an
in-flight grant from installing a credential after sign-out.

## Screen 2: Sessions

Sessions is the default screen once a Mac is connected. It shows every
non-archived session in the same three buckets as the desktop dashboard:

1. Needs you: at least one tab is waiting.
2. Working: no tab is waiting and at least one is in progress.
3. Done: everything else, newest first.

The phone requests summaries, not transcripts. Each card contains the session
title, project display name, worktree or branch display name, issue reference,
agent tab, last prompt, last reply, waiting reason, and updated time. Absolute
project paths are not needed on the phone and should not cross the channel.

Search covers the visible title, project, worktree, and issue reference. Pull
to refresh performs a new summary request; live status changes update the same
portable records and run through the shared bucket fold. A disabled offline
state retains the last successful list but marks it with the time it was cached.

Opening a card selects the tab chosen by the host summary: a waiting tab first,
then a working tab, then the active or most recently modified tab. A tab picker
in Session allows switching among the session's existing tabs. The phone cannot
create, close, rename, or reorder them.

## Screen 3: Session

Session has a compact header and a Chat | Terminal segmented control. Both
segments are views of the same PTY-first tab. Switching never starts, stops,
resumes, or reconciles an agent process.

### Chat

The first load asks for the last 20 turns. Load earlier walks backwards in
20-turn pages. The host returns normalized `AgentEvent` records in ascending
`seq` order even though it scans the JSONL file backwards. The client merges
pages and live appends by `seq`, treats an identical event as idempotent, and
logs a protocol fault if the same sequence arrives with different content.

The transcript is a native `ScrollView`. Only the transcript scrolls; the
composer is a pinned sibling above the keyboard and safe-area inset. Loading an
earlier page restores the visual anchor instead of jumping. New live events
follow the existing desktop pinning rule: stay pinned only if the reader was
already at the bottom.

The mobile view renders the shared transcript model with native components for
prompts, assistant prose, reasoning, tool calls, edits, results, decisions,
errors, and turn duration. It does not import desktop HTML renderers. The cache
stores only event pages that the reader displayed.

The composer keeps typed text in memory while disconnected. The send button is
disabled until a writable host connection and capability are present. Sending
uses the host's existing `send_message` path, including bracketed paste and the
delayed Enter; the phone never writes prompt bytes directly to the PTY.

The host constructs and prefixes the effective-user attribution from the
authenticated connection. Client-supplied attribution text is stripped or
escaped and overwritten. A non-owner receives the host-defined guardrail. The
renderers hide the transport envelope while retaining the visible author.

If the agent is busy, the host reports that the prompt is queued and the mobile
transcript shows that state. The draft is cleared only after an accepted
response. A connection failure keeps the draft.

### Permission cards

Permission cards come only from a normalized `permission_requested` event.
There is no terminal scraping, prompt heuristic, or simulated keypress.

The host hook flow is authoritative:

```text
CLI PermissionRequest hook
        |
        v
host creates requestId, stores suggestions, and publishes permission_requested
        |
        v
hook thread waits on its decision channel for up to 600 seconds
        |
        +-- desktop or phone submits one optionId
        |
        v
host atomically consumes the pending request and returns the CLI-specific JSON
```

The event carries `requestId`, tool name, tool input, title, description, and
display-safe options. The options include opaque IDs, labels, and kinds such as
allow once, deny, allow for the session, or allow and switch mode. Raw
permission suggestions remain only in the host's pending-request map. The
phone echoes the selected `optionId`; it never reconstructs a rule.

For a normal Allow, the parked hook ultimately receives a real decision:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

Deny returns `behavior: "deny"` with the host's denial message. An
allow-and-switch option makes the host attach the suggestion it retained; it
does not trust a suggestion supplied by the phone. The first valid response
wins if the phone and desktop race. Later responses receive a
`request_lapsed` refusal and cannot affect a newer prompt.

When the 600-second hook timeout expires, the host publishes the existing
automatic `permission_decided` event labelled `Lapsed`. The card becomes
read-only and says to open Terminal, where the CLI has fallen back to its own
prompt. Losing the connection, stopping the agent, or restarting the desktop
also retires open cards. A permission response must never call
`terminal.write`; an integration test observes the PTY writer while an allowed
tool actually proceeds.

Question prompts remain visible as Needs you. Version one shows an Answer on
Mac message rather than adding a second form contract; `permission.respond`
does not pretend to answer them.

### Terminal

The terminal phase begins read-only. Coalesced raw bytes from the existing pane
are base64-framed over the paired channel and rendered by xterm.js in a single
isolated WebView. The rest of the app remains native. A bounded initial
scrollback snapshot is followed by live bytes; reconnect obtains a fresh
snapshot so byte gaps cannot produce a corrupt screen.

Writable terminal input is a later step behind the same host write gate used by
remote prompts. Direct keystrokes are the default the first time a terminal
handle is opened. The choice is one-shot per handle and can be toggled to a
native buffered command box for the rest of that handle's life.

Terminal activation alone never raises the keyboard. The reader taps inside
the terminal to focus direct input. Buffered text is retained across a
disconnect and only its send control is gated.

The host owns driver state:

```text
idle | desktop | mobile { clientId }
```

Claiming mobile control also supplies the mobile viewport. While mobile is the
driver, desktop keystrokes and resize requests are refused server-side and the
desktop tab strip shows a lock naming the driving device. Heartbeats refresh
the claim; disconnect, explicit release, or lease expiry returns control. A UI
lock without server enforcement is not sufficient.

## Screen 4: Settings

Settings contains four grouped sections rather than additional top-level
routes:

- Account: identity, sign in, and sign out.
- Paired machines: label, last connection, pairing provenance, and Revoke.
- Notifications: permission state, honest delivery limits, and a test action.
- Connection log: recent state changes and refused capabilities with Retry,
  Copy diagnostics, and Troubleshoot actions.

Revoking a credential on the Mac closes that phone's channel within one second.
Signing out on the phone is local-first: it fences in-flight pairing, closes
connections, deletes automatically granted host credentials and cloud tokens,
then attempts server logout. Explicit QR/code pairings remain and the
confirmation says so. No running Mac agent is stopped.

The connection log is bounded and local. It records timestamps, host IDs,
endpoint class, reconnect attempt, negotiated protocol, refusal code, and state
transition. It does not record device tokens, transcript text, prompt text, or
raw encrypted frames. Exact endpoint addresses are redacted from copied
diagnostics.

## Mobile persistence

Almost nothing belongs on the phone:

| store | contents |
| --- | --- |
| device-only secure storage, excluded from backups | installation P-256 keypair, installation ID, per-host credentials, cloud tokens |
| `hosts.json` | host ID, label, pinned public key, provenance, endpoints tried, last connected time |
| `notifications.json` | per-host notification cursor and a bounded set of recently delivered event IDs |
| in-memory and LRU disk cache | event pages for the last N turns of sessions the reader opened |
| memory only | unsent composer and buffered-terminal drafts for the running app process |

The secure-storage configuration must use a this-device-only accessibility
class. A restored device backup must not inherit an installation identity.
Cloud tokens and device credentials never enter AsyncStorage, logs, crash
messages, or the transcript cache.

The cache is keyed by host, session, tab, and sequence range. It is bounded by
age and size, and signing out removes cached data associated with automatic
pairings while retaining caches reachable through surviving explicit pairings.
No transcript is uploaded to the account service. The phone stores only pages
it displayed.

## Paired-channel RPC

Issue #6's handshake must advertise a protocol version and an explicit method
capability set. Fields are additive. A client ignores unknown fields and never
assumes a method exists from a version number alone.

Every call returns an outcome rather than throwing for an expected refusal:

```ts
type RpcOutcome<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      refusal: {
        code:
          | "unsupported_method"
          | "scope_denied"
          | "not_found"
          | "cursor_expired"
          | "request_lapsed"
          | "not_driver"
          | "session_closed";
        message: string;
        retryable: boolean;
      };
    };
```

Transport loss, authentication failure, and malformed ciphertext remain
connection failures. An older host refusing a method is data: the app logs it
once per method and connection, disables only that feature, and continues.

All methods are deny-by-default in the host allowlist. Read and write are
separate capabilities. Authorization is rechecked on every request and every
stream drain, not only when the subscription starts. Revocation cancels live
streams immediately.

### Session methods

`sessions.summaries()` returns portable cards:

```ts
interface SessionCard {
  sessionId: string;
  title: string;
  project: { id: string; name: string };
  worktree: { name: string; branch?: string };
  issue?: { identifier: string; title?: string };
  activeTabId?: string;
  cardTabId: string;
  tabs: Array<{
    tabId: string;
    title?: string;
    harness: string;
    status: "idle" | "in_progress" | "waiting" | "completed";
    modified: string;
  }>;
  lastPrompt?: string;
  lastReply?: string;
  waitingOn?: string;
  updatedAt: string;
}
```

The host obtains snippets with the existing bounded backward log reader. The
shared dashboard fold classifies and sorts the returned cards. Archived
sessions are absent, and no absolute filesystem path is sent.

`session.tail({ sessionId, tabId, beforeSeq?, limitTurns })` returns:

```ts
interface SessionTail {
  events: AgentEvent[];       // ascending seq
  oldestSeq?: number;
  latestSeq?: number;
  hasEarlier: boolean;
  nextBeforeSeq?: number;     // exclusive cursor
}
```

`limitTurns` defaults to 20 and is capped by the host. The scan walks backwards
to complete turn boundaries, then reverses the records. `beforeSeq` is
exclusive. A page is never allowed to split a pending permission card from the
event that retires it.

`session.subscribe({ sessionId, tabId, afterSeq })` returns a stream handle and
replays any committed events after `afterSeq` before live appends. Registering
the stream and capturing its high-water sequence happen under the same
publisher lock, so an event cannot land between the tail and subscription.
Closing the stream is transport-level cancellation, not a new session RPC.

The initial sequence is: tail, render, subscribe with its `latestSeq`, merge
replay, then live appends. Reconnect repeats that sequence from the greatest
contiguous cached sequence. Access is rechecked for each replay or live batch.

`session.send({ sessionId, tabId, text })` returns the accepted prompt event and
whether the running CLI queued it. It has no image field in version one. The
host checks the write capability, constructs attribution, and calls the same
send implementation as the desktop composer.

### Permission method

`permission.respond({ sessionId, tabId, requestId, optionId })` returns
`{ status: "accepted" }` or a refusal such as `request_lapsed`. It requires a
specific mobile permission capability; a read-only or generic viewer
credential can see that attention is needed but cannot decide it.

The host validates that the request is still pending in that exact tab and
that `optionId` belongs to the request. It then calls the same
`respond_permission` implementation as the desktop. The client never sends a
hook payload, decision JSON, rule, tool name, or tool input back to the host.

### Terminal methods

`terminal.subscribe({ paneId })` returns a bounded screen snapshot and a stream
of coalesced byte frames. It is read-only and checks that the pane belongs to a
session visible to this credential.

`terminal.driver.acquire({ paneId, cols, rows })`,
`terminal.driver.viewport({ paneId, cols, rows })`, and
`terminal.driver.release({ paneId })` manage the authoritative driver state.
They are introduced only with terminal input and share the write gate and lease
rules from issue #5.

`terminal.write({ paneId, bytes })` accepts literal terminal input only while
the caller owns mobile driver state. It rejects oversized frames and refuses
when the session is closed, the lease is absent, or the credential lacks the
write capability. Prompt sending never calls this method.

### Notification methods

`notifications.subscribe()` registers a live stream and returns the current
host epoch and high-water cursor.

`notifications.missedSince({ epoch, lastSeenSeq })` returns ordered notification
events after the cursor, including a transition into a newer process epoch:

```ts
interface NotificationEvent {
  eventId: string;            // hostId:epoch:seq
  hostId: string;
  epoch: string;
  seq: number;                // monotonic within epoch
  kind: "done" | "waiting" | "failed" | "terminal_bell" | "test";
  sessionId?: string;
  tabId?: string;
  title: string;
  body: string;
  emittedAt: string;
}

interface MissedNotifications {
  events: NotificationEvent[];
  latest: { epoch: string; seq: number };
  cursorFound: boolean;
}
```

The host appends each event to
`$RACCOON_HOME/notifications.jsonl` before broadcasting it. The journal keeps a
bounded retention window across desktop restarts; each process creates a fresh
epoch and starts its own monotonic sequence. This durable bridge is necessary:
an epoch alone prevents a stale cursor from silently swallowing new events,
but it cannot replay events from before a restart.

If the supplied epoch and sequence still exist in the journal, the host returns
everything after them across epoch boundaries. If retention has removed the
cursor, `cursorFound` is false and the client says that older notifications may
be missing instead of pretending catch-up was exact. The planned retention must
comfortably exceed the ten-minute acceptance case.

The phone subscribes first, records the returned high-water point, then asks
for missed events and merges any buffered live events by `eventId`. It raises
local notifications in journal order, stores a bounded delivered-ID set to
deduplicate replay, and advances `notifications.json` only through the greatest
contiguous event it handled. A notification carries the session deep link.

The initial mobile sources are the same attention transitions the desktop
already grades: a turn completed, a permission or question waiting, and a turn
failure. They are journaled for mobile delivery only when the desktop window is
unfocused; focused desktop notices keep their existing in-app or tone
treatment. Terminal bell lands with terminal streaming. Test is generated only
by the explicit Settings action. The host event is created independently of a
webview so closing or reloading the desktop frontend cannot lose it.

## Notifications and iOS background limits

After the first successful pairing, Settings offers notification opt-in. The
app requests iOS permission only after the reader chooses it. A received event
becomes a local notification; no transcript text or device credential is sent
to a notification provider.

Version one makes this limitation visible next to the toggle:

> Notifications arrive while Raccoon is open or recently backgrounded. iOS may
> suspend the connection; missed updates appear when you reopen the app.

There is no promise of indefinite background delivery and no silent-push
fallback. Reopening performs missed-since catch-up and deep links remain valid
whether the target transcript is cached or has to be fetched.

## Connection and offline behaviour

The connection state machine is owned by issue #6 and surfaced consistently on
all screens. Reconnect delays are 0.5, 1, 2, 4, 8, 15, 30, and 60 seconds for
the first 12 attempts, followed by a 90-second trickle that never gives up.

- Attempts 1–2 show `Reconnecting…` without replacing cached content.
- Attempt 3 shows `Can't connect` with Retry and connection-log actions.
- Attempt 12, or a connection stale for 60 seconds, shows
  `Host unreachable — re-pair?` while preserving an ordinary Retry path.
- An endpoint in `100.x` or `*.ts.net` adds a hint to check Tailscale on both
  devices.
- Returning to the foreground restarts a stale dial immediately.
- Endpoint hysteresis avoids oscillating between direct and relay paths.
- A healthy relay can upgrade to direct after a grace period; failure falls
  back without resetting subscriptions or drafts.
- Two resume credentials overlap during rotation so a lost refresh response
  does not strand a valid connection.

The client keeps a small connection journal so endpoint upgrades and resume
attempts are diagnosable. Cached transcripts and the last session list remain
readable offline. Composers retain their text, but every send or permission
action is visibly disabled; no offline action is guessed or replayed without a
fresh user tap.

## Security and privacy invariants

- Cloud sign-in never substitutes for a per-host device credential.
- The directory and relay never receive transcripts, prompts, terminal bytes,
  device tokens, project paths, or notification contents.
- The relay carries ciphertext and cannot authorize an RPC.
- The host pins the device identity and the phone pins the host public key.
- Every RPC is checked against the live credential, method capability, and
  target session or pane.
- Permission rules and hook reply construction stay on the Mac.
- Revocation closes that device's streams and refuses later responses; it does
  not cancel a host permission request that the desktop can still answer.
- Logs contain method names, counters, and refusal codes, never content or
  secrets.
- Cached content is namespaced by host identity so a same-named reinstall
  cannot inherit another host's data.

## Delivery phases

### Planning — this change

Land this architecture document only. It fixes the app boundary, screen model,
host RPC, hook decision flow, notification catch-up, storage, security
invariants, and implementation order. There is no product code or live app
proof in this change.

### 1. Shared package

Create the pnpm workspace and extract events, transcript, dashboard, and RPC
contracts into `packages/mobile-core`. Move existing tests with them, add
desktop adapter and parity coverage, and keep desktop behaviour unchanged.

Exit gate: the desktop builds against the package; identical fixtures produce
identical transcripts and buckets; all four repository checks pass.

### 2. Read-only app

After issue #6 provides identity, pairing, encrypted transport, allowlists, and
reconnect, add the Expo app, auth callback, Machines, Sessions, paged Chat, live
appends, cache, and connection-state UI. QR/code pairing remains available.
There is no mobile write method in this phase.

Exit gate: a warm connection renders the last 20 turns within two seconds;
paging and a concurrent append preserve strict sequence order; revocation
drops the stream within one second.

### 3. Notifications

Move attention-event creation to an authoritative host service, add the
durable epoch journal, live stream, missed-since catch-up, local notification
opt-in, deduplication, and deep links.

Exit gate: a ten-minute app absence replays every event exactly once, including
events around a Mac restart, and a deliberately expired cursor reports the gap.

### 4. Sending and permissions

After the write gate and effective-user attribution exist, enable the composer
and host-attributed sending. Add permission cards using opaque option IDs and
the existing parked hook decision path.

Exit gate: Allow runs the tool, Deny blocks it with a message, allow-and-switch
uses the host-retained suggestion, a 600-second request lapses on both surfaces,
and none of those actions writes a terminal byte.

### 5. Terminal

Add bounded read-only snapshot plus streaming, then driver state, write-gated
input, direct-keystroke default, buffered toggle, viewport ownership, and the
desktop lock indicator.

Exit gate: a phone can watch the live TUI; while it drives, input reaches the
pane and desktop input and resize are refused by the host; release restores
desktop control.

### 6. Offline polish and release readiness

Finish cache eviction, retained drafts, staged reconnect copy, Tailscale hint,
connection log, compatibility degradation, accessibility, and distribution
work.

Exit gate: airplane-mode and unsupported-method scenarios degrade without a
crash, sign-out preserves explicit pairings and running agents, and the iOS
background limitation is visible in product copy and release notes.

## Verification plan

Each product phase runs the repository's TypeScript, Vitest, Clippy, and Rust
test suites plus the mobile package's lint, type, unit, and native integration
checks.

Required focused coverage includes:

- Shared transcript and dashboard parity on real captured event fixtures.
- Tail paging at turn boundaries, concurrent subscribe, duplicate replay, and
  conflicting-sequence rejection.
- Allowlist tests for every allowed method and one denied method per excluded
  family.
- Revocation during every stream and during a parked permission request.
- Permission Allow, Deny, suggestion, race, stop, disconnect, and timeout with
  a PTY-write spy.
- Notification replay in one epoch, across an epoch change, with duplicate
  live/backlog delivery, and with an expired cursor.
- OAuth and notification deep links from cold, warm, and foreground states.
- Reconnect thresholds, foreground restart, direct-to-relay fallback, cached
  transcript reading, and retained composer text.
- VoiceOver labels and dynamic type for every permission action and connection
  state.

Live acceptance uses a real paired Mac, real CLI sessions, real hook decisions,
and a development build on an iPhone or iOS simulator where the behaviour is
representative. Mock session data is not an acceptable substitute.

## Decisions carried into implementation

- Version one ships the honest local-notification limitation; it does not add
  a push service.
- Distribution begins with TestFlight while protocol and release cadence are
  proven. Public App Store work is a later release decision.
- Protocol evolution is additive, capability-negotiated, and refusal-based
  from the first host method.
- The transcript builder and event vocabulary are shared; presentation remains
  platform-native.
- The app keeps one active Mac connection and switches explicitly.
- A generic read-only credential cannot answer permission requests. The exact
  capability name is finalized with issue #6 before phase 4, without widening
  any existing scope by implication.
