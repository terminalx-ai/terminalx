# Cloud previews and forwarded ports (PRO-28)

An application started in a cloud workspace (a dev server on port 3000, say)
is reached from the desktop as `http://localhost:<port>`. The desktop listens
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
| See which ports listen (`ports.list`) | | yes | yes | yes | yes |
| Open a preview (`ports.open`, `ports.write`) | | | | yes | yes |

Opening a preview needs exactly what typing into a terminal needs (PRO-88):
a manager, or a driver who may approve permissions. What listens on a
workspace's loopback is not only web pages: a debugger port or a notebook
server runs anything as the workspace's user for whoever connects. Someone
who may use a terminal could already reach every local port from there, so
this grants them nothing new; a plain driver or a viewer could not, and
still cannot. A refusal says so (`reason: "approval-required"`).

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

The desktop listener binds loopback only. Other programs running as the same
user on that Mac can reach it, as with any local development server.

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
- A local listener that is still open when the workspace stops refuses
  connections with a short page saying so. It does not reconnect with
  `wake`, and it never resumes compute because a browser tab reloaded.
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

The desktop closes its local listeners when the connection goes, and shows
the forward as unavailable. Nothing is stored on the server, so there is no
route table to clean up.

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
bytes }`, `ports.closed { streamId, reason }` with `eof`, `error` or
`revoked`.

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
- A connection holds at most 32 streams, the runtime 128.
- An application that takes nothing for 30 seconds loses its stream.

Half-closed connections are not modelled: when either side closes, the
stream ends.

## Delivery

1. Runtime: `ports/1` in `terminalx-serve` (this document, `remote/ports.rs`).
2. Desktop, native: the local forwarder. One listener per (workspace, port)
   on `127.0.0.1`; the same local port when it is free, otherwise the next
   free one, with the reassignment shown; an optional "exact port only"
   setting that refuses instead. A listener is bound to one workspace and is
   never reused for another.
3. Desktop, interface: a Ports panel in the cloud session (listening ports,
   open previews, states: starting, unavailable, stopped), and "Open
   preview" in the built-in browser.

The API and the relay need no change for private previews.
