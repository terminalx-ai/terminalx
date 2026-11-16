# How the phone connection works today

Part of issue #989. This note is research only. It reads the phone transport,
the Mac's pairing code and the relay server source, and it says where a
foreground keep-alive and a faster reconnect would fit. Push notifications are
covered in a separate piece.

Citations:

- Paths without a prefix are in this repository.
- Paths that start with `terminalx-server/` are in the relay server repository
  (read at commit `0767db9b`, 2026-11-09). That repository is read only for this
  work.
- The nginx site files are named after host names. They are written
  here as `terminalx-server/deploy/nginx/<cell>.conf` and `<director>.conf`.

## Summary

- **There is a keep-alive today, though nobody named it one.** While the app is
  in the foreground, the phone sends an encrypted `pairing.getEndpoints` request
  every 30 s, and it closes the connection if no answer comes within 5 s
  (`mobile/src/transport/connection.ts:509`,
  `mobile/src/transport/connection.ts:543-547`). The request goes end to end
  (phone, relay, Mac), so it keeps every leg busy and it also detects a dead
  path. The phone never sends WebSocket ping frames
  (`mobile/src/transport/relay-client.ts` has none).
- **The shortest idle timeouts that apply to the phone's data path** are a home
  router's NAT (as low as 1 to 4 minutes in published measurements), Cloudflare's
  100 s if the cell is ever proxied through it, and the cell's own Bun WebSocket
  limit of 120 s. The 30 s interval is under all of them.
- **Recommendation:** keep one end-to-end request about every 30 s in the
  foreground (range 25 to 45 s). Make it a cheap no-op instead of an address
  lookup, and send nothing in the background.
- **The cold start is mostly serial.** The phone waits for an account-token check
  (a network call when the token is near expiry), then a director lookup, then a
  relay socket. The Mac then opens a new socket to the relay, after which two
  encrypted handshake round trips and one confirmation round trip follow.
  Capabilities and the session list then take two more serial requests. Several
  of these steps could overlap.
- **Saved content:** the phone saves the last 500 events of each conversation
  tab it has opened (`mobile/src/data/transcript-cache.ts:26-56`). It does not
  save the session list, which is emptied on every connect
  (`mobile/src/state/AppProvider.tsx:207`).

## 1. What keeps the socket alive today, and every idle timeout on the path

### The path

A relay connection has three legs. A direct connection (LAN or Tailscale) has one.

```
phone --WSS--> cell (Bun) <--WSS-- Mac data socket (one per phone connection)
                    ^
                    +------WSS---- Mac control socket (one per Mac, long-lived)
phone --WS---> Mac port 6768 (direct path)
```

- The phone opens `wss://<cell>/v1/connect/<relayHostId>`
  (`mobile/src/transport/relay-client.ts:432-437`).
- The cell tells the Mac over its control socket that a phone has arrived
  (`terminalx-server/apps/relay/src/cell/cell-server.ts:548-562`).
- The Mac then opens a new data socket to `/v1/host/data/<connId>`
  (`src-tauri/src/pairing/relay.rs:1077-1110`).
- The cell splices the two
  (`terminalx-server/apps/relay/src/cell/cell-server.ts:313-324`).
- Direct connections are accepted on the Mac's listener
  (`src-tauri/src/pairing/mod.rs:986-1028`).

### What sends traffic when nothing else does

| Leg | Who sends | Interval | Detects a dead peer after | Source |
| --- | --- | --- | --- | --- |
| Phone to Mac, end to end (both paths) | Phone: encrypted `pairing.getEndpoints` RPC | 30 s, foreground only | 5 s without an answer; the phone then closes and reconnects | `mobile/src/transport/connection.ts:506-509`, `mobile/src/transport/connection.ts:541-547` |
| Same, on return from background | Phone: one `pairing.getEndpoints` probe | once | 1.5 s (`RESUME_PROBE_MS`) | `mobile/src/transport/connection.ts:28`, `mobile/src/transport/connection.ts:182-195` |
| Mac control socket to cell | Cell: JSON `ping`; Mac answers `pong` | 20 s | Cell closes after 60 s without a pong | `terminalx-server/apps/relay/src/cell/cell-server.ts:57-58`, `terminalx-server/apps/relay/src/cell/cell-server.ts:599-615`, `src-tauri/src/pairing/relay.rs:881-884` |
| Mac control socket, Mac side | Mac: silence check every 2 s | 2 s tick | 45 s with no frame; also a lost source address or a sleep gap | `src-tauri/src/pairing/relay.rs:24-30`, `src-tauri/src/pairing/relay.rs:79-100` |
| Mac control socket, kernel | Mac: TCP keepalive | idle 30 s, then every 5 s, 3 tries | about 45 s | `src-tauri/src/pairing/relay.rs:31-34`, `src-tauri/src/pairing/relay.rs:107-115`, `src-tauri/src/pairing/relay.rs:682` |
| Any cell WebSocket (phone leg, Mac data leg) | Bun: automatic WebSocket ping (`sendPings`, default true) | Bun internal | 120 s with no messages or pings (`idleTimeout` default, not overridden) | `terminalx-server/node_modules/bun-types/serve.d.ts:448-454`, `terminalx-server/node_modules/bun-types/serve.d.ts:463-468`, `terminalx-server/apps/relay/src/cell/cell-server.ts:99-105` |
| Mac data socket and direct socket | Nobody. The Mac answers pings (`mod.rs:1233-1235`) but sets no timer, no TCP keepalive and no silence check | none | never on its own; only when the socket errors or closes | `src-tauri/src/pairing/mod.rs:1188-1252`, `src-tauri/src/pairing/relay.rs:1077-1110` (no `enable_keepalive`) |

Other timers on the path:

- They are not idle timeouts, but they bound how long a step may take:
  - The phone's handshake deadline: 15 s (`mobile/src/transport/relay-client.ts:149`).
  - The approval wait while pairing: 150 s (`mobile/src/transport/relay-client.ts:47`).
  - Each RPC: 30 s (`mobile/src/transport/relay-client.ts:170`).
  - The cell's deadline for the Mac to attach a data socket: 15 s (`terminalx-server/apps/relay/src/cell/cell-server.ts:56`, `terminalx-server/apps/relay/src/cell/cell-server.ts:479-489`).
  - The Mac's relay connect timeout: 15 s (`src-tauri/src/pairing/relay.rs:22`).
- The splice closes a connection whose buffered frames are older than 30 s
  (`terminalx-server/apps/relay/src/environment.ts:116`). That is congestion,
  not idleness.
- When one leg of a splice closes, the cell closes the other with the same code,
  or 4408 (`terminalx-server/apps/relay/src/cell/cell-server.ts:571-596`,
  `terminalx-server/apps/relay/src/protocol/close-codes.ts:10`). So a phone leg
  that times out also ends the Mac's data socket.

### Idle timeouts in front of and around the relay

| Where | Idle timeout | Applies to | Source |
| --- | --- | --- | --- |
| nginx in front of the cell | 3600 s read and send | all cell sockets | `terminalx-server/deploy/nginx/<cell>.conf:38-43` |
| nginx in front of the director | 60 s | director requests only (`/v1/resolve` answers and closes) | `terminalx-server/deploy/nginx/<director>.conf:37-41` |
| Caddy (alternative deploy) | no timeout set; Caddy defaults | all | `terminalx-server/deploy/Caddyfile.relay:13-15` |
| Cloudflare, if the cell is proxied through it | 100 s with no data in either direction (Free, Pro, Business) | all cell sockets | Cloudflare WebSockets docs: <https://developers.cloudflare.com/network/websockets/> (they confirm an idle close but give no number); the 100 s figure is from Cloudflare community answers: <https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865> |
| Bun WebSocket server on the cell | 120 s | all cell sockets | `terminalx-server/node_modules/bun-types/serve.d.ts:448-454` |

Whether Cloudflare proxies the cell is not stated in the relay repository. The
real-IP snippet is written to be "safe to install before turning the proxy on"
(`terminalx-server/deploy/nginx/cloudflare-real-ip.conf:8-10`). So the proxy may
be turned on later, and the keep-alive should already stay under 100 s.

### NAT and carrier timeouts outside our control

| Source | Finding |
| --- | --- |
| RFC 5382 (TCP NAT), REQ-5 | An established TCP connection's idle timeout MUST NOT be less than 2 hours 4 minutes (7440 s). <https://www.rfc-editor.org/rfc/rfc5382> |
| RFC 4787 (UDP NAT), REQ-5 | A UDP mapping MUST NOT expire in less than 2 minutes; 5 minutes or more is the recommended default. Relevant only if the transport ever moves to QUIC or UDP. <https://www.rfc-editor.org/rfc/rfc4787> |
| Hätönen et al., IMC 2010, home gateways | About half of the tested home gateways time out idle TCP sooner than 7440 s; the shortest was about 4 minutes; median about 60 minutes. <https://conferences.sigcomm.org/imc/2010/papers/p260.pdf>, slides <https://www.ietf.org/proceedings/78/slides/behave-8.pdf> |
| Neubert, ITC 36, 2025, home gateways revisited | 11 of 23 devices stay well below 7440 s; one went as low as 1 minute. <https://thomasez.folk.ntnu.no/itc36/itc2025-final4.pdf> |
| Wang et al., SIGCOMM 2011, cellular middleboxes | 11 of the carriers measured close idle TCP in under 10 minutes; one major carrier at 255 s. <https://web.eecs.umich.edu/~zmao/Papers/netpiculet.pdf> |
| Apple | Apple publishes no foreground keep-alive interval for app sockets. In the background, iOS suspends the app and may reclaim its sockets (Technical Note TN2277, "Networking and Multitasking": <https://developer.apple.com/library/archive/technotes/tn2277/_index.html>). Apple recommends Network framework for WebSockets (TN3151: <https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api>). |

## 2. What interval to use

The shortest idle timeouts that can apply to the phone's data path, in order:

1. A home router NAT: 60 s at worst (Neubert 2025), about 4 minutes in the 2010
   study.
2. Cloudflare: 100 s, but only if it ever proxies the cell.
3. The Bun cell: 120 s.
4. A carrier NAT: 255 s at worst (Wang 2011).
5. nginx: 3600 s.

The Mac's data and direct sockets set no idle timeout of their own.

So a keep-alive must leave each leg idle for less than 60 s. To leave room for
one lost probe, the interval should be under half of that worst case plus the
probe's own wait:

- **Recommended range: 25 to 45 s, foreground only. Keep 30 s.**
- At 45 s, one missed probe still keeps traffic within the 100 s and 120 s limits.
  It does not cover a 60 s router: such a router would cut the path after one
  missed probe, and that is what the 5 s answer deadline then detects.
- Going below 25 s buys no margin against any timeout above. It only adds radio
  wake-ups.
- For battery, each probe is a short exchange, and the radio's high-power tail
  after it costs more than the bytes do. That makes the interval, not the payload,
  what the device-measurement piece should vary.

Two changes would make today's probe a proper keep-alive:

- **Use a cheaper request.** `pairing.getEndpoints` enumerates the Mac's network
  interfaces on every call (`src-tauri/src/pairing/mod.rs:1372-1432`, which calls
  `advertised_endpoints()`). It then writes the stored host on the phone whenever
  addresses came back (`mobile/src/transport/connection.ts:550-554`). A no-op RPC
  (for example `transport.ping`) every 30 s would do the same job for liveness,
  and the address refresh could run less often.
- **Do not rely on WebSocket ping frames alone over the relay.** Bun answers them
  at the cell, so they keep the phone's NAT entry and the phone leg alive. They do
  not reach the Mac, so they do not show that the Mac's data leg is still up. The
  end-to-end request does.

What the measurement piece should test: 15 s, 30 s and 45 s, on Wi-Fi behind a
home router and on cellular, plus one control run with the probe off. The run
with the probe off should show a router or Bun cut at 60 to 120 s.

## 3. The cold-start path, from launch to current content

"Serial" means the next step waits for this one. "Could overlap" means nothing in
this step's output is needed by the next one.

| # | Step | Where | Today | Could overlap? |
| --- | --- | --- | --- | --- |
| 1 | JS starts; providers mount; `HostConnection` and `HostApi` are created | `mobile/app/_layout.tsx:12-14`, `mobile/src/state/AppProvider.tsx:64-67` | serial (app start) | no |
| 2 | Read the account session (keychain), the saved Macs and the connection log | `mobile/src/state/AppProvider.tsx:218`, `mobile/src/auth/native.ts:47-50` | the three run in parallel | already parallel |
| 3 | Account token check, `refreshStoredSession`. A network POST when the token expires within 60 s, with a 30 s timeout. Otherwise it returns at once. | `mobile/src/state/AppProvider.tsx:220-232`, `mobile/src/auth/native.ts:11`, `mobile/src/auth/native.ts:52-67`, `mobile/src/auth/protocol.ts:116-123` | serial: blocks everything after it | **yes.** The relay and direct connections use the saved device credential and resume token, not the account token (`mobile/src/transport/connection.ts:380-383`, `mobile/src/transport/relay-client.ts:156`). Only a "rejected" outcome needs to undo a connect. |
| 4 | Recover a half-finished pairing | `mobile/src/state/AppProvider.tsx:236-238` | not awaited | already overlaps |
| 5 | `Linking.getInitialURL()` (sign-in callback) | `mobile/src/state/AppProvider.tsx:242-246` | serial | yes, for a saved Mac |
| 6 | Pick the most recently connected Mac; read its credential (keychain); set it active; `connection.start` | `mobile/src/state/AppProvider.tsx:251-253`, `mobile/src/state/AppProvider.tsx:188-209` | serial | the keychain read could start in step 2 |
| 7 | `setReady(true)`; the Machines tab stops showing "Loading" | `mobile/src/state/AppProvider.tsx:255`, `mobile/app/(tabs)/index.tsx:35` | after step 6 | could be set right after step 2 |
| 8 | Load the phone's long-lived E2EE key (keychain) | `mobile/src/transport/connection.ts:374` | serial, at the start of each attempt | could be read once in step 2 |
| 9 | Race every direct address and the relay at once | `mobile/src/transport/connection.ts:412-446` | parallel | already parallel |
| 9r.1 | Relay: POST the director's `/v1/resolve` for the current cell (5 s timeout), then fall back to the saved cell | `mobile/src/transport/connection.ts:416-419`, `mobile/src/transport/connection.ts:606-620` | serial before the socket | **yes.** Dial the saved cell at the same time, and use the director's answer only on a 4409 (wrong cell). |
| 9r.2 | Relay: open the WSS socket (TCP and TLS); send `relay-auth` | `mobile/src/transport/relay-client.ts:146-158` | serial | no |
| 9r.3 | Cell: check the credential (registry lookup); tell the Mac through its control socket | `terminalx-server/apps/relay/src/cell/cell-server.ts:391-491` | serial | no |
| 9r.4 | Mac: open a **new** data socket to the cell (TCP and TLS), then `host-data-auth` | `src-tauri/src/pairing/mod.rs:1030-1046`, `src-tauri/src/pairing/relay.rs:1077-1110` | serial | only with a relay change (a spare data socket kept warm, or multiplexing over the control socket) |
| 9r.5 | Cell: attach; release the `relay-hello` to the phone | `terminalx-server/apps/relay/src/cell/cell-server.ts:313-324`, `mobile/src/transport/relay-client.ts:221-232` | serial | no |
| 10 | E2EE: phone `e2ee_hello`, Mac `e2ee_ready` (round trip 1) | `mobile/src/transport/relay-client.ts:231`, `src-tauri/src/pairing/mod.rs:1078-1096` | serial | see section 4 |
| 11 | E2EE: phone `e2ee_auth`; Mac finds the device, checks approval, writes `registry.touch`, sends `e2ee_authenticated` (round trip 2) | `mobile/src/transport/relay-client.ts:234-247`, `src-tauri/src/pairing/mod.rs:1097-1177` | serial | see section 4 |
| 12 | Mac: open the mobile runtime connection before it reads the first RPC | `src-tauri/src/pairing/mod.rs:1180-1186`, `src-tauri/src/pairing/mobile.rs:221-223` | serial on the Mac | could start while step 11 is in flight |
| 13 | Phone: `transport.negotiate` (not awaited) | `mobile/src/transport/relay-client.ts:274-275` | overlaps | already overlaps |
| 14 | Relay only: awaited `pairing.getEndpoints` resume confirmation (round trip 3), then the connection counts as "connected" | `mobile/src/transport/relay-client.ts:276-288` | serial | **yes.** Mark the connection usable first and confirm in parallel. The confirmation only updates the stored credential version (`mobile/src/transport/connection.ts:489-493`). |
| 15 | Phone: write the credential and the stored host to storage, **awaited**, before streams and listeners | `mobile/src/transport/connection.ts:489-499` | serial | **yes.** Nothing after it reads those writes. |
| 16 | Re-subscribe streams; `device.describe`; a second `pairing.getEndpoints`; start the 30 s timer; fire `onConnected` | `mobile/src/transport/connection.ts:500-510` | in parallel with each other | the second `getEndpoints` is redundant right after step 14 |
| 17 | `onStage("connected")`: `host.describe`, restore notifications | `mobile/src/state/AppProvider.tsx:268-276` | parallel | already parallel |
| 18 | Session list: `sync.capabilities`, then `sessions.summaries` | `mobile/src/state/AppProvider.tsx:292-297`, `mobile/src/data/host-api.ts:146-172`, `mobile/src/data/host-api.ts:199-202` | two serial round trips | **yes.** Cache the capabilities per Mac across launches, and send summaries at once with the cached `version`. |
| 19 | Open conversation: show the saved tab at once, then `sync.capabilities` (shared with step 18), subscribe, `session.sync` from the saved cursor | `mobile/src/data/transcript-sync.ts:109-152`, `mobile/src/data/transcript-sync.ts:188-195` | the cache shows at once; the reads are serial | subscribe and the first `session.sync` could go out together |

Round trips before current content over the relay: TLS and `relay-auth` to the
cell; the Mac's own TLS to the cell; two E2EE round trips; one confirmation; then
capabilities and summaries (or capabilities and `session.sync`). That makes at
least six serial phone-to-Mac round trips and two TLS setups, plus the director
POST and possibly the account refresh. This fits the roughly 4 s seen in the
screen recording, but that link is not proven. The timing marks below are there
to show where the time actually goes.

The direct path skips steps 9r.1 to 9r.5 and step 14. On a LAN, the E2EE round
trips and steps 18 to 19 are what is left.

## 4. Could the relay session or the pairing handshake be resumed with a ticket?

### What the handshake does today

- The relay layer already uses a long-lived credential, not a full login. The
  phone presents a resume token (`relay-auth`, `credentialKind: "resume"`,
  `mobile/src/transport/relay-client.ts:156`). The cell matches it
  (`terminalx-server/apps/relay/src/cell/cell-server.ts:493-512`). The token is
  rotated and confirmed over the encrypted channel
  (`mobile/src/transport/connection.ts:511-515`).
- What cannot be resumed at the relay layer is the splice. Each phone connection
  gets a new `connId` and needs the Mac to open a new data socket
  (`terminalx-server/apps/relay/src/cell/cell-server.ts:470-490`). A ticket does
  not help here. Step 9r.4 is the cost, and it is removed only by changing how the
  relay and the Mac attach.
- The E2EE handshake takes two round trips. It derives keys from a **static to
  static** X25519 secret (the phone's long-lived key and the pinned Mac key) and
  fresh nonces from both sides
  (`mobile/src/transport/e2ee-session.ts:52-58`,
  `mobile/src/transport/e2ee-session.ts:109-114`). There is no ephemeral key, so
  the handshake has no costly step to skip and no forward secrecy to lose.

### What a ticket would change

A ticket would let the phone send `e2ee_auth`, and even the first read, together
with `e2ee_hello`, under a key from an earlier session. That saves one round trip
(step 10 and step 11 merge), at most two. Against the properties in
`docs/PAIRING-APPROVAL.md`:

- **Approval.** No change. Only a QR pairing of the pending, unclaimed device is
  gated (`docs/PAIRING-APPROVAL.md`, "The approval step on the Mac"). A ticket
  would be issued only after `e2ee_authenticated`, so it never exists for an
  unapproved phone. The Mac must refuse a ticket for a device that has no
  `approved_at`.
- **Fingerprint.** No change. The fingerprint binds the host key, the phone key
  and the device token at pairing time
  (`docs/PAIRING-APPROVAL.md`, "Fingerprint"). Later connections do not show it.
- **Replay by the relay.** This is new. Today, both nonces make every session's
  keys fresh, so the relay cannot replay a recorded session. Data sent in the
  first flight under a ticket key could be replayed by the relay or anyone on the
  path. So 0-RTT data must be limited to reads that are safe to repeat
  (`session.sync`, `sessions.summaries`, `sync.capabilities`). It must never
  include `session.send`, approvals or answers. Sends would still wait for the
  Mac's nonce.
- **Revoke and Disconnect.** "Revoke ends live connections at once" and
  "Disconnect keeps the pairing" (`docs/PAIRING-APPROVAL.md`, "Connection paths")
  must cover tickets too. The Mac would check the device entry and the
  disconnect hold on every ticket use. It would drop all of a device's tickets on
  revoke, on sign-out, and on a binding-generation change
  (`src-tauri/src/pairing/mod.rs:1110-1132`).
- **Credential on the phone.** The ticket becomes another secret in the
  keychain, beside the device token. Taking it gives the same access as taking
  the token. It should expire within hours and be single use.
- **Forward secrecy.** Unchanged, because there is none today (static keys).
  Adding an ephemeral exchange would gain it, at no extra round trip.

**Recommendation:** do not build tickets first. The larger and safer savings are
in section 3: steps 3, 9r.1, 14, 15 and 18 can overlap or be removed without
touching the protocol. Step 9r.4 needs a relay design change. A ticket for 0-RTT
reads is worth doing only if the measurements show that the E2EE round trips are
still a large part of the time after that.

## 5. Can the connection start before the first screen, and what can be shown at once?

- **The connection already starts before current content is drawn, but late.**
  `connectHost` runs inside the startup effect after the steps in section 3 above
  it (`mobile/src/state/AppProvider.tsx:216-255`). The effect runs after the first
  render of `AppProvider`. Nothing waits for a splash screen: no
  `SplashScreen.preventAutoHideAsync` is used in `mobile/app` or `mobile/src`.
  The earliest point is module load, before React renders: read the saved host,
  credential and E2EE key there, and call `connection.start` with them. The
  account token check (step 3) would then run in parallel.
- **What is saved on the phone and could be shown at once:**
  - **Saved Macs** (`readHosts`, `mobile/src/store/hosts.ts`), with name, last
    connected time and addresses. These are shown after step 2.
  - **Conversation transcripts:** the last 500 events per host, session and tab,
    with a sync cursor and a checksum
    (`mobile/src/data/transcript-cache.ts:6-56`). They are shown at once when a
    conversation opens (`mobile/src/data/transcript-sync.ts:188-191`), but only
    after an active host is set. Before that, the screen reads "Session
    unavailable" (`mobile/app/session/[sessionId].tsx:77`).
  - **Drafts** of the text being typed (`mobile/app/session/[sessionId].tsx:196-206`).
  - **The connection log**, last 200 entries
    (`mobile/src/state/AppProvider.tsx:62`, `mobile/src/state/AppProvider.tsx:239-241`).
- **What is not saved:**
  - The **session list.** It is set to `[]` on every connect
    (`mobile/src/state/AppProvider.tsx:207`) and filled only by
    `sessions.summaries`. While it is empty, the Sessions tab shows "Loading
    sessions" or "Sessions are offline"
    (`mobile/app/(tabs)/sessions.tsx:95-97`).
  - The **capabilities** (`mobile/src/data/host-api.ts:131-153`). They are
    cleared on every connection.

  Saving both per Mac, and showing the saved session list marked as not yet
  current, would put a full screen up at once on return. The conditional-list
  `version` that already exists (`mobile/src/data/host-api.ts:155-172`) would
  then make the refresh cheap.
- **On return from the background** the app already keeps what is on screen,
  probes once (1.5 s), and reconnects quietly for up to 1 s before it shows
  "reconnecting" (`mobile/src/transport/connection.ts:25-30`,
  `mobile/src/transport/connection.ts:168-197`). That matches the owner's
  direction, so the work there is mainly the speed of the reconnect in section 3.

## Timing marks for the measurement piece

Each mark should record `Date.now()`, or `performance.now()` relative to the
first mark, with the connection's generation and path. On the Mac, add the
equivalent marks to the relay diagnostics. The list is in the order the steps
happen.

Phone:

1. `mobile/app/_layout.tsx:RootLayout`: first render (app start).
2. `mobile/src/state/AppProvider.tsx:AppProvider` startup effect: before and after
   `Promise.all([readSession, readHosts, …])` (line 218).
3. `mobile/src/auth/native.ts:refreshStoredSession`: start, end, and whether it
   was `fresh` or went to the network.
4. `mobile/src/state/AppProvider.tsx:AppProvider`: after `Linking.getInitialURL`
   (line 242), and at `setReady(true)` (line 255).
5. `mobile/src/state/AppProvider.tsx:connectHost`: before and after
   `readHostCredential`, and at `connection.start`.
6. `mobile/src/transport/connection.ts:HostConnection.connectOnce`: after
   `loadOrCreateE2EESecretKey` (line 374), and at the race start (line 412).
7. `mobile/src/transport/connection.ts:resolveRelay`: start and end.
8. `mobile/src/transport/relay-client.ts:RelayClient.connect`: at socket
   creation (line 146), at `onopen` (line 150), at the `relay-hello` (line 229),
   at `e2ee_ready` (line 235), at `e2ee_authenticated` (line 272), and at
   `setState("connected")` after the resume confirmation (line 287).
9. `mobile/src/transport/connection.ts:HostConnection.connectOnce`: the winner
   and its path (line 440), and after the awaited storage writes (line 496).
10. `mobile/src/data/host-api.ts:HostApi.features`: request and answer.
11. `mobile/src/data/host-api.ts:HostApi.summaries`: request and answer, and the
    first render with a non-empty list in `mobile/app/(tabs)/sessions.tsx`.
12. `mobile/src/data/transcript-sync.ts:watchTranscript`: the cache shown
    (line 191), the first `session.sync` sent and answered (line 152), and
    `caughtUp(true)` (line 172). That last mark is "current content".
13. `mobile/src/transport/connection.ts:HostConnection.foreground`: the probe sent
    and answered or failed (lines 182-195), for the return-from-background case.
14. `mobile/src/transport/connection.ts:HostConnection.refreshEndpoints`: each
    keep-alive sent and answered (line 543), for the battery runs.

Mac:

15. `src-tauri/src/pairing/mod.rs:PairingManager.handle_relay_connection`: when
    `connection-open` arrives and when the data socket is attached (lines
    1043-1046).
16. `src-tauri/src/pairing/relay.rs:open_data_socket`: TCP and TLS done, and
    `host-data-auth` sent.
17. `src-tauri/src/pairing/mod.rs:PairingManager.handle_e2ee_socket`: hello
    read, ready sent, auth read, `e2ee_authenticated` sent, and after
    `MobileConnection::open` (lines 1078-1186).

Relay (for a staging run, read only here):

18. `terminalx-server/apps/relay/src/cell/cell-server.ts:CellServer.admitPhone`:
    credential resolved and connection announced; and
    `CellServer.attachHost`: hello released.
