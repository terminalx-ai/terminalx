# Mobile network recovery (#135)

Pairing offers retain `endpoint` and add optional `directEndpoints`. New mobile
clients accept old offers and stored hosts. Both apps must be updated to use the
new offer field (older mobile offer parsers reject unknown fields).

The Mac keeps port 6768 bound on all IPv4 interfaces, enumerates addresses for
each offer and authenticated `pairing.getEndpoints` call, and includes its macOS
Bonjour `LocalHostName.local` address. Numeric candidates exclude loopback,
link-local, unspecified, multicast, broadcast and proxy fake-IP ranges. The
fallback when no usable address or Bonjour name exists is localhost.

Mobile races all direct candidates and available relay resume credentials using
the existing pinned host key. Losing sockets close, including on stop/restart.
It fetches current candidates through the winning encrypted channel after each
connection and every 30 seconds. A failed 5-second refresh request closes a
silently dead channel and starts reconnection. Bonjour resolution on each dial
allows local recovery when saved numeric addresses change. No unauthenticated
endpoint-discovery service is exposed.

An existing pairing learns candidates when any saved path next connects. If all
paths in an old single-address pairing are already unreachable, the new client
cannot infer the Mac's identity-bound current address. Restore one old path to
upgrade it. LAN-only pairings still require a reachable direct path; Bonjour
requires local-network permission and a network that permits mDNS.

## Automated checks

- `pnpm --dir mobile test`
- `pnpm --dir mobile typecheck`
- `cargo test --manifest-path src-tauri/Cargo.toml pairing:: --lib`

Transport tests cover LAN fallback from a hanging VPN address, learning a VPN
address then reconnecting through it, Bonjour recovery, legacy pairing upgrades,
all-address failure diagnostics, socket cancellation, late relay resolution and
silently dead connections. These tests simulate reachability; they do not verify
iOS DNS behavior or real interface changes.

## Device and simulator verification

Run with updated desktop and mobile builds, without removing the saved pairing.
For a live connection, check that Sessions updates and that the connection card
shows the winning address. On failure, check the attempted addresses and reasons.

| Initial state | Change | Expected recovery |
| --- | --- | --- |
| Paired on Wi-Fi, Tailscale off | Enable Tailscale on Mac | LAN or Tailscale |
| Paired with Tailscale on | Disconnect phone from tailnet, keep same Wi-Fi | LAN |
| Connected over LAN with Tailscale available | Move Mac to hotspot | Tailscale or configured relay |
| Connected on LAN | Change Mac's LAN IPv4 | Bonjour name resolves new LAN address |
| Connected over direct or relay | Blackhole that connection without closing TCP | Probe detects failure and another path connects |

Repeat the first three rows in the iPhone simulator, which shares the Mac's
network stack. Wait for one address refresh after enabling a new interface before
removing the previous path when testing learned numeric candidates. Also test an
immediate change with relay available. Physical phone and simulator verification
must be recorded separately from the automated tests.
