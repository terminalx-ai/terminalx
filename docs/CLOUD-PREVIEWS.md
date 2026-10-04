# Cloud previews and forwarded ports (PRO-28)

An application started in a cloud workspace (a dev server on port 3000, say)
is reached from the desktop as `http://127.0.0.1:<port>`. The desktop listens
on its own loopback and carries each connection to the workspace over the
connection it already holds: the relay tunnel, end-to-end encrypted, attached
with the person's own device.

There is no preview URL on the internet. Nothing in this design adds a
listener, a route or a firewall rule on the workspace, the relay or the API.

## Why a forward and not a hosted URL

The relay carries opaque end-to-end encrypted frames between a runtime and
attached devices. It terminates no HTTP for end users and cannot read what it
carries. A hosted preview URL would need a new ingress that sees the
application's traffic in the clear and its own session scheme for browsers.
A forward needs neither: it reuses the attachment, which is already
authenticated, authorized by role, fenced by runtime generation and revoked
with access.

Public links are a separate, explicit action and are **not built**. If they
are wanted later they need their own ticket: an ingress, per-link tokens,
expiry and revocation.

## Who may open a preview

| | none | viewer | driver | driver who may approve | manager |
| --- | --- | --- | --- | --- | --- |
| See which ports listen (`ports.list`) | | | | yes | yes |
| Open a preview (`ports.open`, `ports.write`) | | | | yes | yes |

Opening a preview needs exactly what typing into a terminal needs (PRO-88):
a manager, or a driver who may approve permissions. What listens on a
workspace's loopback is not only web pages: a debugger port or a notebook
server runs anything as the workspace's user for whoever connects. Someone
who may use a terminal could already reach every local port from there, so
this grants them nothing new; a plain driver or a viewer could not, and
still cannot. A refusal says so (`reason: "approval-required"`). The list of
listening ports follows the same rule: it names every loopback listener in
the machine, system services included, which is of use only to someone who
may connect to them.

The role is read on every call from the member list the API sends the
runtime (PRO-30). With an API that sends no member list, a `participate`
attachment cannot open a port. Organizations are separated where they
already are: an attachment exists only for a workspace the person may see,
and the relay admits only that attachment's device.

## How it is authenticated

The preview address is `http://127.0.0.1:<local port>` on the person's own
Mac. It carries no token, and cannot be used from anywhere else. What
authenticates the traffic is the workspace connection underneath:

1. the API issued the attachment after checking membership and visibility;
2. the relay admitted the device with a 60-second attach ticket bound to the
   workspace, organization and runtime generation;
3. the runtime checked the device token inside the E2EE handshake;
4. the runtime checks the person's role on every `ports.*` call.

### What a loopback listener exposes

Stated plainly, because "localhost" is not private to one program:

- **Other programs on this Mac.** Anything running as the same user can
  connect to the listener while the preview is open.
- **Web pages in the person's browser.** Any page can make the browser send
  requests to a loopback port. It cannot read the answers of another
  origin, but with DNS rebinding a page points a hostname of its own at
  `127.0.0.1` and then can. The forwarder refuses that: an HTTP request
  whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets a `403`
  and never reaches the workspace. The client's first bytes are judged
  before any of them is forwarded, however late they come (a browser may
  connect first and send its request later), and anything shaped like
  `<method> <target> HTTP/<version>` is a request, whatever the method. A
  request with no `Host` is refused too. That includes HTTP/2 with prior
  knowledge over plain TCP (`PRI * HTTP/2.0`, as plaintext gRPC clients
  send): it has no `Host` line to judge, so such a client cannot use a
  forward. HTTP/1.1, an upgrade from it, and TLS are unaffected. Bytes that are not HTTP (a
  database protocol, TLS) are carried as they are; a page cannot make a
  browser speak those to a preview and read the answer. A page can still
  send blind requests (for example a form post) to a preview whose port it
  can guess: they carry a loopback `Host` and are indistinguishable from
  the person's own.
- **Cookies.** Browsers scope cookies by host, not by port. A preview
  served at `127.0.0.1` can read and set cookies of everything else the
  person uses at `127.0.0.1`, and the other way round. A workspace is code
  the person chose to run, but a workspace that turns hostile sees those
  cookies.

What is done about it: the local port is random by default (not the
workspace's number, which a page could guess), the listener never shares a
port with another program, the `Host` check above, and previews close with
the connection. What is not done: a hostname per workspace (for example
`<workspace>.preview.localhost`), which would give each preview its own
cookie jar and origin. That is a decision for the owner; it needs the
preview address to be a name rather than `127.0.0.1`, and a browser that
resolves `*.localhost` to loopback (Safari and Chrome do, not every tool
does).

## Never public

- The runtime connects only to its own loopback (`127.0.0.1`, then `::1`).
  `ports.open` takes a port number and nothing else: it cannot be pointed at
  another host, the provider's metadata address or the workspace's network.
- The runtime opens no listener for previews.
- The provider's network policy is not touched.

## Stopped workspaces

A forward exists only inside a live connection, so a stopped workspace has
no previews, and nothing about a preview can start one:

- Opening a preview does not use the `wake` activation. On a suspended
  workspace the desktop says the workspace is stopped and offers the same
  explicit "Start workspace" action as everywhere else.
- When the workspace stops, its local listeners close. A browser tab that
  reloads gets "connection refused", and nothing is resumed. The preview is
  not revived when the workspace runs again: the person opens it again.
- An open connection counts as use of the workspace, as any attached client
  does. A preview adds no activity signal of its own.

## How previews are removed

Every stream belongs to one connection and ends with it.

| Event | What ends the preview |
| --- | --- |
| Suspend, archive | The API revokes attachments; the runtime closes the device's connections; the VM stops. |
| Delete | Attachments and the bootstrap grant are deleted; the relay refuses the runtime. |
| Share revoked, workspace made private, member removed | The attachment is revoked and the member list changes: the runtime closes the connection. |
| Role lowered, or the right to approve removed | The runtime ends that person's streams with `reason: "revoked"` and refuses new ones. |
| New runtime generation | The relay fences the old generation. |
| Desktop quits or disconnects | The connection closes; the runtime ends its streams. |

The desktop closes its local listeners in every one of these cases, and
also when the active organization changes. They are not kept for a
connection that might return. Nothing is stored on the server, so there is
no route table to clean up.

## The protocol: `ports/1`

Negotiated in `rpc.hello` like every namespace; an older runtime simply does
not grant it.

| Method | |
| --- | --- |
| `ports.list` | `{}` → `{ detected, ports: [{ port }], streams: [{ streamId, port }] }`. Listening ports are read from `/proc/net/tcp` and `tcp6` (loopback and any-address listeners). `detected: false` where that is not available; a port can still be opened by number. `streams` are the caller's own. |
| `ports.open` | `{ port }` → `{ streamId, port, window, maxWriteBytes }`, or `port_unreachable`. |
| `ports.write` | `{ streamId, data }` (base64, at most `maxWriteBytes`) → `{}`, or `backpressure`. |
| `ports.ack` | `{ streamId, bytes }` → `{}`. |
| `ports.close` | `{ streamId }` → `{}`. |

Notifications: `ports.data { streamId, data }`, `ports.drained { streamId,
bytes }`, `ports.closed { streamId, reason }` with `eof`, `error`, `revoked`,
`idle` or `limit`.

A stream is a TCP connection, so HTTP, WebSockets and server-sent events all
work without the runtime knowing about them.

### Flow control

The relay cannot pause a sender. It buffers 4 MiB per connection for 30
seconds and then closes the connection, which would take the workspace's
terminals and sessions with it. So port data is paced end to end:

- Toward the client, a stream has at most 256 KiB that the client has not
  acknowledged with `ports.ack`, and a connection at most 1 MiB over all its
  streams. The runtime stops reading from the application until then.
- Toward the application, the client keeps at most 256 KiB that
  `ports.drained` has not covered. A write beyond that is refused with
  `backpressure`, never buffered.
- A connection holds at most 32 streams, the runtime 128, and at most 8
  opens are in flight per connection.
- An application that takes nothing for 30 seconds loses its stream.
- A stream nothing has crossed for 30 minutes ends (`reason: "idle"`), and
  one that has carried 8 GiB ends (`reason: "limit"`).

The `ports.open` answer travels in the same ordered queue as the stream's
data, and nothing is read from the application until the answer is on its
way: an application that speaks first is never heard before the client knows
the stream's id. An open that finishes after its connection closed or lost
the right to open makes no stream. Each open is logged with who and which
port, never with what was carried.

Half-closed connections are not modelled: when either side closes, the
stream ends.

## Delivery

1. Runtime: `ports/1` in `terminalx-serve` (this document, `remote/ports.rs`).
2. Desktop, native: the local forwarder. One listener per (workspace, port)
   on `127.0.0.1`, on a random free port by default. A listener is bound to
   one workspace and is never reused for another.
3. Desktop, interface: a Ports panel in the cloud session (listening ports,
   open previews, states: starting, unavailable, stopped), and "Open
   preview" in the built-in browser.

The API and the relay need no change for private previews.

## The desktop forwarder (`src-tauri/src/cloud_ports.rs`)

One `PortForwarder` per workspace connection. Commands:
`cloud_port_forward(connectionId, port, localPort?, exact?)`,
`cloud_port_unforward`, `cloud_port_forwards`.

- It binds `127.0.0.1` only, **without address reuse**. With `SO_REUSEADDR`
  (which a plain listener sets) macOS lets a loopback bind succeed while
  another program listens on the wildcard address of the same port, and the
  new socket takes that program's loopback traffic. Before using a named
  port it also checks that nothing listens on it on the IPv4 wildcard, IPv6
  loopback or the IPv6 wildcard.
- The local port is a random free one. A caller may name one (`localPort`);
  when any program has it, a random one is used and the answer says
  `reassigned`, or with `exact` the forward is refused (`cloud_port_in_use`).
- Forwarding the same port again returns the same forward. A forwarder's
  listeners belong to its connection.
- Each accepted connection has its first bytes judged (the `Host` rule
  above) before `ports.open` is sent. A client that says nothing for 400 ms
  gets its stream anyway, so a protocol whose server speaks first works;
  what it sends later is still judged before any of it is forwarded, and a
  refused request ends the stream. Each connection becomes one stream. Requests carry ids starting `ports-`;
  their answers and every `ports.*` notification are consumed natively and
  never reach the web view. They are sent under the same identity rule as
  the web view's frames: nothing goes out for an identity that is no longer
  current, a pending sign-out included.
- It never changes the connection's activation. `cloud_port_forward` on a
  connection that is not live answers `cloud_port_not_connected`.
- Listeners and streams close when the connection stops being live for any
  reason, when it is detached, when the account changes and when the active
  organization changes. Nothing reopens by itself.
- A refusal by the runtime is a short plain-text page in the forwarder's own
  words, sent with `nosniff`; the runtime's text and codes are not echoed.
- Stopping a forward closes the connections it was carrying.
- Limits: 64 local connections per forwarder; the runtime's window is never
  taken as larger than 256 KiB; a runtime that sends more than two windows
  without waiting for acknowledgements has its stream ended rather than
  buffered.
