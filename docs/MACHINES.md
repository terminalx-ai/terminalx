# Machines: operating TerminalX on another computer (PRO-338)

The owner confirmed the nine decisions below on 2026-11-13. This note was
originally written against TerminalX 0.2.32 at `46c6250f`. Machines became
available by default in 0.2.35 ([PRO-360](#as-built-pro-360-machines-for-everyone)).
Start with the [Machines guide](MACHINES-GUIDE.md) for setup instructions.

A **machine** is another computer that runs TerminalX: a second Mac, a Mac mini,
or a headless Linux server running `terminalx-serve`. From this desktop a person
sees the machine's projects and sessions in the sidebar and works in them. Every
session, terminal, file change and git command runs on the machine.

This note is the shared reference for PRO-340 to PRO-360. A ticket that needs
something this note does not settle adds it here in the same pull request.

Words used here:

- **Machine**: the computer being operated. Its runtime is the **host**.
- **Operating computer**: the desktop a person sits at, which connects to a machine.
- **Paired computer**: an operating computer that a machine has approved.
- **Route**: one way to reach a machine: this network, Tailscale, or the relay.

Related documents: [HEADLESS-SERVE.md](HEADLESS-SERVE.md) (the runtime and the
workspace protocol), [LOCAL-RUNTIME.md](LOCAL-RUNTIME.md) (the local owner),
[CLOUD-AGENT-TABS.md](CLOUD-AGENT-TABS.md) (the mailbox this replaces for
machines), [MOBILE.md](MOBILE.md) and [PAIRING-APPROVAL.md](PAIRING-APPROVAL.md)
(phone pairing, which this reuses).

Designs: Superdesign project
[TerminalX · 21 Machines](https://superdesign.dev/teams/6ed56485-0705-4853-abab-a4d702daa54e/projects/5246b893-8372-4562-83ce-08b667032584).
This note has no screen of its own. It was checked against what
[21.01 Sidebar and overview](https://p.superdesign.dev/draft/d2eca059-90a2-4773-aaf9-f8dc7c3eadbf)
and [21.08 Session on another machine](https://p.superdesign.dev/draft/2c6f364b-5101-48ff-861a-f42feb64720b)
need: a machine's name, kind (Mac or headless) and route ("Direct over
Tailscale · 9 ms"); its projects and their sessions; and, inside a session,
chat, Changes, Checks, Files, Ports and terminals named after the machine.

## The decisions

Each decision is recorded as confirmed. "Why" gives the reason from the code,
"Rejected" says what was not chosen, and "What follows" lists the rules the
tickets share because of it.

### 1. The remote UI is a third `WorkspaceTarget` kind, `machine`, that reuses the cloud views

**Why.** The local UI reaches its backend through Tauri commands: 592 are
registered in `generate_handler!` (`src-tauri/src/lib.rs`), and `src/lib/api.ts`
calls 418 distinct ones. Each takes local paths, and `invoke()` refuses any
argument that is not local (`src/lib/api.ts:104`). The cloud views
(`src/components/cloud/*`) already render a session, its chat, terminals,
files, git and ports over one `WorkspaceRpcClient`, and the debug-only
Development section proves they work against a hand-run `terminalx-serve`
(`src/components/cloud/DevRuntime.tsx`, `cloud_remote_attach_dev` in
`src-tauri/src/cloud_remote.rs:433`).

**Rejected.** Routing each local command per target. That would mean a remote
form of each of the ~590 commands, each kept in step with its local one.
Forwarding command names over the wire would also undo the rule that the
runtime serves only the methods in `METHODS` and has no generic "invoke"
(`src-tauri/src/remote/protocol.rs:1`, tested by
`every_method_names_a_served_capability_and_mutations_are_idempotent`).

**What follows.**

- `WorkspaceTarget` (`src/lib/api.ts:3031`) gains
  `{ kind: "machine"; machineId: string; projectId?: string }`.
- `workspaceTargetKey` (`src/lib/api.ts:3043`) returns `machine:<machineId>`
  for every machine target, with or without `projectId`. `workspaceConnection`
  keeps one connection per key (`src/lib/api.ts:3148`), so every project of a
  machine shares one connection (decision 2).
- The parts of the cloud views that belong to organisations are absent for a
  machine: sharing, presence, driver leases, wake and sleep, price, and the
  mirror. The method table below says which calls a machine does not serve.
  PRO-347 keeps the feature parity list at the end of this note.

### 2. One connection per machine serves all its projects

**Why.** Sessions, terminals, ports, agents and resources belong to the runtime
process, not to a project. `runtime.agents`, `lifecycle.resources`, `ports.*`,
`pty.*` and the session list are all per runtime. One connection means one
E2EE handshake, one reconnect owner and one route choice per machine.

**Rejected.** One connection per project. A Mac mini with ten projects would hold
ten handshakes and ten reconnect loops. The machine-wide calls would have no
single home, and switching routes would have to move ten connections together.

**What follows.**

- The workspace protocol serves one root today: the relay host builds one
  `WorkspaceRpc` for one folder (`src-tauri/src/remote/host.rs:1040`), and
  `--relay-link` requires `--project-root` (`src-tauri/src/serve.rs:147`).
  PRO-340 adds the additive namespace `machine/1` and the project rule in
  [Project scoping](#project-scoping).
- A local project has no id today: `Project` is keyed by its `path`
  (`src-tauri/src/store/projects.rs:19`). `machine/1` defines `projectId` as in
  [projectId](#projectid).

### 3. Agent commands travel as live calls, with idempotency ids and receipts kept by the runtime

**Why.** In a cloud workspace, send, steer, stop and the permission decision go
through the API's command mailbox. That gives one delivery path and one receipt
per command (`docs/CLOUD-AGENT-TABS.md:13`). A personal machine has no API in
the path when it is paired by code (decision 6). The runtime already holds the
exactly-once half of the mailbox: `applying` and `receipt` records fsynced
before and after a command is applied (`src-tauri/src/cloud_agents/receipts.rs`,
contract §11.4 in `docs/CLOUD-AGENT-TABS.md`). The phone already sends live,
with an id and replies kept for a day (`src-tauri/src/pairing/send_ids.rs:26`).

**Rejected.** A mailbox kept on the machine. The cloud mailbox is useful because
the API holds commands while the runtime is suspended or offline. A mailbox on
the machine is offline whenever the machine is, so it adds a second queue in the
same process and gains nothing.

**What follows** (PRO-343 builds this):

- A new additive namespace, `agent-commands/1`, offered only by a runtime with
  no cloud mailbox. A cloud workspace runtime never offers it, so cloud commands
  keep exactly one path.
- Its methods, with the same plaintexts and meanings as the mailbox kinds
  (`docs/CLOUD-AGENT-TABS.md:73`):
  - `session.send`: the method exists today (`src-tauri/src/remote/server.rs:3160`).
    With `agent-commands/1` granted, its receipt is the durable one below,
    not the ten-minute cache.
  - `session.steer`, `session.stop` and `session.decide` (the
    `permission-decision` kind), all new.
  - Each takes `sessionId`, `tabId` and a `clientRequestId`
    (`valid_client_request_id`, `src-tauri/src/remote/protocol.rs:434`).
- Receipts are durable. `IdempotencyCache` keeps results in memory for ten
  minutes (`src-tauri/src/remote/protocol.rs:363`). A laptop that slept for an
  hour, or a runtime that restarted for an update, would replay a send. So:
  - These four commands use a journal with the `receipts.rs` rules: `applying`
    fsynced before the command is applied, the receipt fsynced after. After a
    crash, an id with `applying` but no receipt is answered `outcome_unknown`,
    except `stop`, which is safe to apply again.
  - A receipt is keyed by the paired computer and the `clientRequestId`. It also
    stores a digest of the method, session, tab and body. The same id with a
    different body is refused, as `send_ids.rs` refuses it for phones.
  - There is no API to acknowledge receipts, so they are kept by age: 24 hours
    and at most a bounded count, as in `send_ids.rs`.
  - A send queued behind a running turn is not settled. A repeat finds the queued
    copy instead of queueing a second one (`send_ids.rs`, "Only settled replies
    answer a repeat").
    *Built in PRO-343:* the copy waits in the tab's durable follow-up queue
    (`receipts::FollowUps`, the mailbox's own), not in a queue tied to the
    connection as a phone's is. Its receipt (`queued: true`) is written once it
    is queued, and a repeat is answered from it, so it is queued once.
- `session.interrupt` stays live and is never idempotent (#427,
  `src-tauri/src/remote/protocol.rs:142`). After a drop it is not resent.
- Refusals reuse existing codes with a `data.reason`, as the server already
  does: `conflict` with `request-not-pending` for an answered or vanished
  request, and `conflict` with `id-reused`. The code set is closed
  (`leak_code`, `src-tauri/src/remote/protocol.rs:407`). A new code must be
  added there and in the client, or a stored one comes back as `internal`.
  `IdempotencyCache` keeps only the code and message of an error. The durable
  journal must also keep `data`.
- `session.attach` stores uploaded images in `cloud_agents::attachments`
  through `self.agents()` (`src-tauri/src/remote/server.rs:3368`). A machine
  runtime has no cloud agents layer, so PRO-343 must give it that store without
  the mailbox, or images cannot be sent to a machine.
  *Settled in PRO-343:* the "cloud agents layer" splits in two. The mailbox
  (`CloudAgents::api`, its poller, launches and scheduled runs) is absent on a
  machine. The rest (agent tabs, the follow-up queue and the attachment store)
  is `CloudAgents::open` with no API, as `terminalx-serve` already opens it
  without a cloud bootstrap (`start_cloud_agents` in `src-tauri/src/serve.rs`).
  The machine host (PRO-341) builds its `WorkspaceRpc` with that, so
  `session.attach` works unchanged.

PRO-343 settles the rest of the namespace as follows:

- `agent-commands/1` is offered exactly when the runtime's agents have no
  mailbox API and the receipt journal opened (`WorkspaceRpc::set_agents`). A
  runtime with a mailbox does not grant it in `rpc.hello`, and answers
  `session.steer`, `session.stop` and `session.decide` with `method_not_found`.
- `session.followUp` (`follow-ups/1`, #1328) is the mailbox's `follow-up`
  kind, live: it edits, withdraws or releases a follow-up the machine holds,
  with the same receipts. A runtime with a mailbox grants `follow-ups/1` (it
  takes the command there) and answers `session.followUp` with
  `method_not_found`.
- The four commands are decided and applied by the mailbox's own code
  (`cloud_agents::mailbox::decide`), so they mean what the mailbox kinds mean:
  who may send, steer and stop (a driver, or a manager over a held lease), who
  may decide (an approver), what a plain driver may type (PRO-88), and settings
  on a send. Tab driver leases apply only to a connection that names a person,
  as for the live `session.send` before it: a paired computer names none, and
  a machine serves no `lease.*`, so one computer's send never locks another
  out of a tab with no way to take it over.
- Parameters are the mailbox plaintexts plus `sessionId`, `tabId` and
  `clientRequestId`: `text`, `images`, `model`, `effort` and `mode` for a send;
  `text` for a steer; nothing more for a stop; `requestId` with `optionId` or
  `answers` for a decision. The result names `sessionId` and `tabId` with the
  receipt's own fields (`queued` and `settingsIgnored` for a send,
  `droppedFollowUps` for a stop, `requestId` for a decision).
- Receipts live in `agent-commands.jsonl` beside the rest of the agent state,
  keyed by the connection's `device_id` (the paired computer on a machine) and
  the `clientRequestId`. Each stores a digest of the method and every
  parameter but the id. No message text is written there.
- A refusal made before the `applying` mark (not allowed, a held lease, a
  malformed body, a slash command from a plain driver) touched nothing. It is
  not kept, so a send that was refused can be tried again in full, as a phone's
  failed send can.
- Refusals: `conflict` with `data.reason` `request-not-pending` (and the
  `requestId`) for a decision whose request was answered or is gone, `id-reused`
  for an id sent again with another body. `outcome_unknown` with `data.reason`
  `runtime-interrupted` for an id cut off mid-apply. The rest map from the
  mailbox category, which is `data.reason`: `forbidden`, `lease_held`,
  `invalid_params` (`payload-invalid`, `attachment-missing`) and `not_found`.
  No new error code was needed.
- While a machine cannot be reached, nothing is queued on the operating
  computer. The composer says it cannot send (PRO-352). A command whose reply
  was lost is resent with the same id once the connection is back.

### 4. The host endpoint lives in the runtime, so it works with the window closed

**Why.** The runtime already owns sessions, terminals, permissions and pipelines
with the window closed (`docs/LOCAL-RUNTIME.md`). A headless server has no
window at all. Today the paired-device endpoint is the window's: "phones cannot
connect while the desktop is closed" (`docs/LOCAL-RUNTIME.md:215`). The pairing
module is compiled only into the desktop build (`docs/HEADLESS-SERVE.md:15`).

**Rejected.** The window as the endpoint, as for phones today. A Mac mini would
have to keep TerminalX open and logged in, and a server could never be a host.

**What follows** (PRO-341 builds this):

- **One host key per machine.** On macOS the key is the phone pairing key that
  exists today: login Keychain service `<app identifier>.pairing`, account
  `host-e2ee-key` (`src-tauri/src/pairing/registry.rs:11`, `:48`). Reusing it
  keeps every phone's pinned key, its fingerprint and its account directory
  entry. Its bytes never change. A new key would be a new machine to every phone
  and every paired computer.
- **The runtime must be able to read that key.** The item was written by the
  app, and the runtime is a different signed executable. Before PRO-341 relies
  on it, it must show the runtime reads the item with no Keychain prompt, with
  the window closed, after a reboot. If it cannot, the app moves the key to an
  item the runtime owns, once, without changing its bytes.
- On Linux there is no Keychain. The key is a file in the data directory, mode
  0600, written as `cloud-workspace/host-key.json` is (temp file, fsync, rename,
  fsync dir; `docs/HEADLESS-SERVE.md`, "Cloud workspace bootstrap") and never
  regenerated.
- **One listener and one relay registration per machine.** If the window and the
  runtime both registered with the relay under the same host id, the relay's
  generation fence would close one of them (`4101`,
  `src-tauri/src/remote/protocol.rs:459`). The phone listener binds TCP 6768
  exclusively (`src-tauri/src/pairing/direct.rs:9`), and phones keep
  `ws://…:6768` endpoints from their offers (`advertised_endpoints`,
  `src-tauri/src/pairing/mod.rs:2044`). So the runtime takes over that listener
  on 6768 rather than opening a second port, and while the runtime hosts, the
  window opens neither a listener nor a relay registration.
- **The device's scope decides what a connection is served.** Phones and
  computers run the same E2EE v2 handshake with the same context
  (`terminalx-mobile-e2ee`, `src-tauri/src/relay_e2ee.rs:524`). It stays
  unchanged. After `e2ee_authenticated`, the runtime looks up the device that
  proved its token. A paired computer gets `terminalx-workspace-rpc/1`; a phone
  gets the phone protocol.
- The phone's handler (`src-tauri/src/pairing/mobile.rs`) is desktop-only today.
  Until PRO-359 moves it into the runtime, a hosting runtime passes an
  authenticated phone connection to an attached window over the existing
  authenticated desktop IPC (`src-tauri/src/local_runtime/mobile.rs`). With no
  window attached, it refuses the phone as unreachable, which is what a phone
  sees today when the window is closed. PRO-341's criterion "Phone pairing on
  the same Mac keeps working, with the same fingerprint" holds either way.
  **Amended by PRO-359:** with no window taking phones, the runtime now serves
  the phone itself instead of refusing it (see "As built (PRO-359)" below).
  A window that takes phones still gets every phone, as before.
- **Paired computers are kept apart from phones.** They go in their own registry
  file in the runtime's data directory, never in `devices.json`. `DeviceScope`
  is a strict enum (`src-tauri/src/pairing/model.rs:73`), and `devices.json`
  is read with `?` (`src-tauri/src/pairing/registry.rs:298`). One unknown scope
  value would make an older build fail to load every phone pairing.
- The runtime stays alive while a computer is connected, as for an attached
  window (`docs/LOCAL-RUNTIME.md`, "Lifetime and honest recovery").

#### How PRO-341 builds it

PRO-341 settled these points while building decision 4.

- **The runtime keeps its own copy of the key on macOS.** The app's item
  `host-e2ee-key` was added by the app with the default access, which trusts
  only the app that created it. The runtime is another executable, installed
  at `~/.raccoon/runtime/<hash>/terminalx-serve` (`local_runtime/launch.rs`), so
  reading the app's item would ask the person to allow it, and nobody answers
  that prompt on a Mac mini after a reboot. So, as this decision allows, the
  window hands the runtime the item's bytes once (`runtime.machineHost.adoptKey`)
  and the runtime keeps them in an item it creates itself: service
  `<app identifier>.machine-host`, account `host-e2ee-key`. The bytes never
  change, so the fingerprint, the phones' pinned key and `machineId` stay the
  same. A desktop-launched runtime never makes a key of its own; until it has
  one it reports `hostKey: "needed"`. A runtime the app did not launch (a
  headless server on Linux or macOS, and the serve tests) keeps the key in
  `<data dir>/machine-host/host-key.json`, mode 0600, written as
  `cloud-workspace/host-key.json` is, and makes it the first time the switch is on.
- **Paired computers** are in `<data dir>/machine-host/paired-computers.json`,
  mode 0600, holding token hashes only (decision 4 keeps them out of
  `devices.json`). PRO-342 adds pairing; PRO-341 admits what is there.
- **The direct listener routes by WebSocket path, before the handshake.** An
  operating computer connects to `ws://<address>:6768/machine/1`; a phone
  connects to `/`, as its offers already say. The runtime serves `/machine/1`
  itself. Any other path is a phone: it passes the TCP stream, from its first
  byte, to the window over a private Unix socket the window registered
  (`runtime.machineHost.phoneRoute`), and the window runs the phone's E2EE
  handshake and pairing unchanged. Routing after `e2ee_authenticated`, as this
  decision first said, would mean moving a live E2EE session's keys and
  counters from one process to another until PRO-359. Routing by path gives
  the same result: each side checks the token against its own registry, so a
  phone's token is refused on `/machine/1` and a computer's on `/`. PRO-342
  and PRO-345 put `/machine/1` in a machine offer's direct endpoints. With no
  window registered, a phone is refused as unreachable, as today.
- **The relay route goes through PRO-340's `serve_machine`**, so a machine has
  one relay registration. PRO-341 adds two hooks to its `RelayHost`: paired
  computers are admitted from the registry by their relay device id and
  token, and a `conn-open` for any other device goes to the window's phone
  route, which opens the data leg itself. PRO-368 registers a signed-in
  machine from the account; while it is registered the window stays off the
  relay and makes its phones' invites, credential installs and revocations
  through the runtime's registration ("As built (PRO-368)").
- **The switch is `machines.allowOperating`** in `settings.json`, off by
  default. The runtime watches the file. On, it is a standing service: it does
  not exit when idle, so a computer can connect with the window closed. It
  keeps this Mac awake while a computer is connected and
  `pairing.keepAwake` is on, as for a phone.
- **The port changes hands by closing connections.** Both sides bind 6768
  exclusively, as the phone listener always has, and on macOS and Linux an open
  connection on the port keeps it from being bound again. So when the switch
  turns on, the window closes its listener and the phones connected to it
  (they reconnect through the runtime, which passes them back), and when it
  turns off the runtime closes its listener, its computers and the phones it
  passed on, and the window binds the port again. On macOS, connections closed
  this way hold the port in TIME_WAIT for up to 30 seconds; both sides retry
  once a second until it is free, as the window already did after an app
  restart. On Linux, where only the runtime listens, it sets SO_REUSEADDR:
  Linux still refuses a second listener with it, and TIME_WAIT is 60 s there.
- **The window gives the port up only to a runtime that can take it.** The
  status says `takesPort` while the runtime is on, its host key is not in
  error, and nothing but the port being in use keeps it from listening. With
  a key it cannot read, or a port it cannot bind for another reason, the
  window keeps serving phones on 6768; the runtime retries every second and
  says `takesPort` again once it can.
- The relay host is given the machine's routes before it registers, so no
  connection is answered without them. A paired computer's relay connection
  is closed with every other one when the runtime loses its credential, is
  fenced by a newer generation or loses the control connection. The relay
  host reads the registry off its async tasks.
- **Paired computers' file is rewritten under a cross-process lock**
  (`paired-computers.lock`, the store's transaction lock), so one process
  never undoes another's removal.
- `TERMINALX_MACHINE_HOST_PORT` moves the listener off 6768 for tests.
- The contract between the runtime and the window is
  `src-tauri/src/machine_wire.rs`.

### 5. A paired computer has full operating rights on the machine's projects

**Why.** A narrower role means a method-by-method threat review and a second set
of UI states. The first version is for one person's own computers.

**Rejected.** A narrower role for now. Phone scopes (`viewer`, `driver`,
`session`) do not change.

**What follows** (PRO-342 builds this):

- A paired computer's pairing offer uses `scope: "runtime"`. The client decoder
  already accepts it (`src-tauri/src/remote/client.rs:76`), and the host maps it
  to `Authority::Manage` (`src-tauri/src/remote/host.rs:773`). Every method in
  the table below marked as served is open to it.
- **Full operating rights include a shell.** `pty.create` and every agent run as
  the user the runtime runs as. A paired computer can therefore read and change
  anything that user can, including the machine's agent sign-ins, git
  credentials and TerminalX's own files. Keeping `fs.*` inside the projects
  guards against mistakes. It is not a security boundary.
- What the protocol does not offer: pairing other computers, changing "Let other
  computers operate this Mac", the built-in browser, computer use, dictation and
  Local VM. No method does any of these (no `pairing.*`, `browser.*` or
  `computer.*` in `METHODS`), and the dialog may say so. It must not promise that
  a shell cannot reach them. Screen
  [21.05](https://p.superdesign.dev/draft/5e4f895d-7861-412c-9756-38672b0e4584)
  says "It won't be able to: control this Mac's screen, browser or other apps;
  approve other computers or change these settings". PRO-342 and PRO-357 must
  either word that as what TerminalX offers, or enforce it against a shell, for
  example by keeping the device registry's integrity key where a shell cannot
  read it.
- **Revoking a computer ends its credential, not what it already did.**
  Revocation closes its connections and removes its token hash, so that
  credential is refused from then on. It cannot undo anything done through a
  shell before then. A paired computer could have written its record back into
  the registry, added an SSH key, installed a launch agent or changed
  TerminalX's files. Unless PRO-357 enforces more (a registry integrity key a
  shell cannot read, at least), the UI must not say revocation removes all
  access. A person who no longer trusts a computer treats the machine as exposed
  to it: they check its login items, SSH keys and paired computers, and rotate
  the sign-ins it held.
- **Every pairing of a computer needs "Allow" on the machine, including through
  the account.** Phones paired through the account skip that step
  (`docs/PAIRING-APPROVAL.md`, Decisions). A computer gets a shell, so a
  compromised account must not be able to add one without the person at the
  machine.
- **The fingerprint the person compares is the 64-bit pairing fingerprint**
  (`src-tauri/src/pairing/fingerprint.rs:24`). It is four groups, binds both
  keys and the one-time token, and is different for every code. PR #923 chose
  64 bits and the token so that a key cannot be searched for ahead of time
  (`docs/PAIRING-APPROVAL.md`, "Why the token and 64 bits"). Screens
  [21.02](https://p.superdesign.dev/draft/7a55514c-1456-452a-b830-93a5ac556711)
  and [21.04](https://p.superdesign.dev/draft/64486c0c-cfb3-4b26-b384-475795a30031)
  show one two-group code ("7F3A·91C2") as both the machine's identity and the
  comparison code. The comparison code must be the pairing fingerprint. A short
  label on a machine's card is allowed, but nobody compares it to approve
  anything.

### 6. No account for a code on the same network or Tailscale; an account for the relay and the account list

**Why.** A code exchanged by the person between two computers they can see
already proves intent, and the direct route needs nothing hosted. The relay
admits a host only with a relay token, and the account list is the account's.
Both need sign-in.

**Rejected.** None was offered. This is how phones work today
(`docs/MOBILE.md`, "Machine discovery").

**What follows.**

- A code made without sign-in carries the machine's direct endpoints and no
  relay bundle. Today the client requires one (`relay` in `PairingOffer`,
  `src-tauri/src/remote/client.rs:54`). PRO-342 and PRO-345 make it optional for
  a machine offer.
- The offer carries every direct endpoint, not only the first. The phone offer
  carries `direct_endpoints[0]` (`src-tauri/src/pairing/mod.rs:416`), but the
  machine needs the LAN, `.local` and Tailscale addresses, so the operating
  computer can try each one (`advertised_endpoints`,
  `src-tauri/src/pairing/mod.rs:2044`).
- Signing out keeps the computers paired by code and drops the relay route, as a
  phone's explicit pairing stays on sign-out (`docs/MOBILE.md`).
- Tailscale is recognised by `100.64.0.0/10` or a `*.ts.net` name
  (`docs/MOBILE.md`, "Direct networking"). That is a label for the route, never
  an authentication decision.
- The desktop's `Info.plist` has no `NSLocalNetworkUsageDescription`. macOS asks
  for Local Network access when the operating computer first connects to a LAN
  address. PRO-345 adds the string and handles a refusal.

### 7. The built-in browser, computer use, dictation, Local VM and orchestration runs stay on the machine a person sits at

**Why.** These act on the screen, apps and audio of the computer in front of the
person. The runtime already answers `browser.*` and `computer.*` with
`unsupported` (`docs/HEADLESS-SERVE.md`, "Control socket"). Orchestration runs
need projects on the computer that starts them (`src-tauri/src/control.rs:773`).

**Rejected.** None. The epic lists these as out of scope (PRO-338, Scope).

**What follows.**

- No method in the workspace protocol reaches them, and none is added.
- Dictation runs on this Mac and can fill the composer of a machine session. It
  never types into a machine's terminal.
- A forwarded port opens in this Mac's built-in browser (PRO-355). The browser
  runs here; only the stream crosses.
- Orchestration runs on a machine can still be started by someone sitting at it.
  The operating computer neither starts nor drives them.

### 8. Key format for machine rows in the sidebar and stores

**Why.** Sidebar rows, preferences and stores are keyed by plain strings. A
local project is its path, a local session its uuid, and every cloud row starts
with `cloud:` (`src/types/target.ts`). A fixed prefix keeps machine rows apart
from both, and every guard can recognise them by that prefix. Ids derived from
the host key, rather than from a name or an address, stay the same through a
rename and over every route. Keeping `:` and `/` out of the ids means a key can
be parsed by counting its parts. The layout mirrors the cloud keys, so the code
that builds and reads cloud rows can be reused.

**Rejected.**

- The machine's name: it changes on rename, and two machines can share one.
- An address or route: a machine has several, and they change.
- The project's path: it has `/` in it, means something only on that machine,
  and would put paths into the operating computer's stores.
- `cloud:` with a pretend organisation: machine rows would pass every cloud
  check and reach the organisation, sharing and mailbox code.

**What follows.**

- Every machine key starts with `machine:`, so it cannot collide with a local
  path (absolute, starts with `/`), a session uuid, a `cloud:` key or an `org:`
  section key (`src/types/target.ts`).
- Machine section: `machine:<machineId>`.
- Project: `machine:<machineId>:<projectId>`.
- Session: `machine:<machineId>:<projectId>:<sessionId>`.
- The display root of a project's files is `machine://<machineId>:<projectId>`,
  as a cloud workspace's is `cloud://<orgId>:<workspaceId>`
  (`cloudWorkspaceRoot`, `src/types/target.ts:27`).
- `machineId` and `projectId` never contain `:` or `/`. A session id is a uuid.
  Splitting a key on `:` therefore always gives 2, 3 or 4 parts, and the count
  says which row it is. A display root starts with `machine://` and is not a
  key: a parser checks for it first, as `parseCloudWorkspaceKey` refuses a
  `/` (`src/types/target.ts:81`).
- `isRemotePath` and `assertLocal` refuse the `machine:` prefix as they refuse
  `cloud:` (`src/types/target.ts:32`, `src/types/target.ts:47`).

The code fits this format. Three things must change with it:

- The central guard covers every Tauri call: `invoke()` runs `assertLocal` on
  each path argument (`src/lib/api.ts:104`). Extending `isRemotePath` protects
  all of them at once.
- `isLocalKey` is `!key.startsWith("cloud:")` (`src/types/target.ts:56`). It
  must exclude `machine:` too, or every machine key reads as local.
- Every check that reads "not a cloud key" as "local" treats a machine row as
  local. PRO-346 moves each to `isLocalKey` or a new `isMachineKey`. On
  `46c6250f` they are:
  - Eight that compare against `"cloud:"` directly:
    `src/components/session/IssueLinkMenuItems.tsx:31`,
    `src/components/settings/EnvironmentSettings.tsx:16`,
    `src/components/settings/LayeredConfiguration.tsx:23`,
    `src/lib/multiOrg.ts:53`, `src/lib/prefs.ts:312`,
    `src/lib/sessionRowStatus.ts:43`, `src/lib/sessions.ts:682` and
    `src/lib/sessions.ts:701`.
  - Six that call `isCloudKey` and treat a key it rejects as local:
    `!isCloudKey` in `src/components/layout/AppShell.tsx:254` (archive),
    `src/lib/sessionNavigation.ts:22` (custom order) and
    `src/lib/mergedCleanup.ts:212` (project toggles counted as local); and an
    `else` that selects a local session or view in
    `src/components/layout/AppShell.tsx:278`,
    `src/lib/sessionNavigation.ts:40` and `src/lib/notify.ts:100`.
  - Correct as written, because they only accept cloud keys:
    `src/lib/cloudTerminals.ts:693`, `src/lib/cloudSelection.ts:48`,
    `src/lib/mergedCleanup.ts:384`, and the two refusals in
    `src/lib/cloudControl.ts:365` and `:806`.
  - Before PRO-346 merges, it searches again for `"cloud:"` and `isCloudKey(`,
    since main moves.

#### machineId

`machineId` is the machine's relay host id, which is derived from its host key:

```
machineId = base64url_nopad( SHA-256( host_public_key[32] ) )[0..16]
```

- `HostKeypair::host_id`, `src-tauri/src/relay_e2ee.rs:54`. `host_public_key`
  is the raw 32-byte X25519 public key of decision 4's host key.
- 16 characters from the base64url alphabet `A–Z a–z 0–9 - _`, 96 bits. It
  matches `^[A-Za-z0-9_-]{16}$`.
- It is the same value as the relay host id and the account directory's
  16-character host id (`docs/MOBILE.md`, "Machine discovery"). So a machine has
  one id over the direct route, the relay and the account list, and it survives
  a rename.
- Compare it byte for byte and never change its case. Do not use it as a file or
  directory name on a case-insensitive volume: keep machines in one file keyed
  by id.
- On pairing and on every connection, the operating computer checks that
  `machineId == host_id(publicKeyB64)` of the key it pinned. An offer whose ids
  disagree is refused.
- A development build has its own app identifier, so its own Keychain item, host
  key and `machineId`.
- Test vectors: a public key of 32 bytes `0x01` gives `cs1uhCLEB_ttCYaQ`;
  32 bytes `0x02` gives `dYd7tB05O1-4RVzm`.

#### projectId

`machine.projects` gives each project an id derived from the path the machine's
store keys it by:

```
projectId = base64url_nopad( SHA-256( "terminalx-project-id/1" || 0x00 || UTF-8(Project.path) ) )[0..16]
```

- Same length and alphabet as `machineId`, with no `:` or `/`.
- Derived, not stored: the desktop and the runtime compute the same id with no
  new field in `projects.json`, and an older build never drops it.
- Removing a project and adding the same folder again gives the same id, so the
  operating computer's pins and order come back. Moving the folder gives a new
  id, as a moved folder is a new project locally, where the key is the path.
- Test vectors: `/Users/me/code/terminalx` gives `1_xp39fWQj0RTKD0`;
  `/home/me/repos/terminalx` gives `oV5UO5z-ckp09tDS`.

### 9. "Let other computers operate this Mac" is off by default

**Why.** A listener and a relay registration expose a machine that has never
been paired. Nothing should be reachable until the person asks for it.

**Rejected.** On by default, or on after the first app launch.

**What follows.**

- While it is off, the runtime opens no listener, registers nothing with the
  relay, and advertises no operating capability in the account directory.
  Phones are served by the window, as they are today.
- Turning it off closes every paired computer's connection and removes the
  runtime's relay registration; phones go back to the window's endpoint. It keeps the paired computers' records, so turning it on
  again needs no new pairing. Revoking a computer is a separate action.
- Only the person at the machine changes it: in Settings → Machines with a
  window, with `terminalx-serve` on a headless server (PRO-353). No method of
  the workspace protocol reads or writes it.
- On a headless server, installing the service does not turn it on.
  `terminalx-serve pair`, with the person's consent in that terminal, does.
- Data privacy mode forces it off, and stops this computer operating others
  (PRO-357, [Trust model](#trust-model)).

## Protocol

### Compatibility: namespaces are additive

`terminalx-workspace-rpc/1` versions each namespace on its own. A newer
namespace version adds methods or fields; it never changes what an older one
means (`src-tauri/src/remote/protocol.rs:16`). `rpc.hello` grants the
intersection of what the client asks for and what the runtime serves, and
answers `update_required` only when nothing is shared (`negotiate`,
`src-tauri/src/remote/protocol.rs:344`).

For machines:

- `machine/1` and `agent-commands/1` are new entries in `CAPABILITIES`
  (`src-tauri/src/remote/protocol.rs:69`), with their prefixes in
  `namespace_prefixes`. A cloud workspace runtime offers neither, so the cloud
  client and the cloud views keep exactly one shape.
- The operating computer requires `machine/1`. A runtime that does not grant it
  is not a machine host, and the desktop shows "Needs update" (PRO-354).
- Every other namespace is used only when granted. A feature whose namespace is
  missing is hidden, with one message naming the machine and saying to update
  it, as the phone does (`docs/MOBILE.md:283`).
- A newer machine keeps serving the older namespace versions, so an older
  operating computer is served as before.
- A runtime that serves one root (a cloud workspace, or `--project-root`) serves
  a client without `machine/1` exactly as today.
- Every reply fits the relay's 1 MiB frame (`MAX_FRAME_BYTES`,
  `src-tauri/src/remote/server.rs:38`; `RELAY_MESSAGE_BYTES_LIMIT`,
  `src-tauri/src/pairing/wire.rs:35`), on every route, with no fragments. A
  connection can move from a direct route to the relay without the session
  view reloading (PRO-345), so no message may rely on a direct route's larger
  limit.

### machine/1

PRO-340 adds these methods to `METHODS` and to the method table below.

| Method | Authority | Result |
| --- | --- | --- |
| `machine.describe` | `Participate` (read-only) | `machineId`, `name` (the existing "This Mac's name"), `os` (`family` of `macos` or `linux`, and `version`), `arch`, the TerminalX `version`, `hasWindow` (a desktop app, or headless) |
| `machine.projects` | `Participate` (read-only) | `projects`: each with `projectId`, `name`, `path`, `kind` (`git` or `folder`), `defaultBranch` (or null) and `archived` |

The runtime sends a `machine.changed` notification when the name or the project
set changes, so the sidebar and the new-session form update without a reload.
A session in the session list and its notifications names its `projectId`.

As built (PRO-340):

- `machine.changed` carries `{ machine, projects }`: the same values as
  `machine.describe` and `machine.projects`, so a client need not ask again.
  It is sent to connections granted `machine/1` only. The runtime checks on
  `projects_changed` and `settings_file_changed` and every five seconds,
  since the desktop writes `projects.json` itself.
- `name` is "This Mac's name" as Settings → Account shows it: the chosen
  name, else one an earlier version saved in `account.json`, else the
  computer's own (`src-tauri/src/machine_name.rs`, shared with pairing).
- `hasWindow` is true when the desktop app started the runtime
  (`TERMINALX_LOCAL_DESKTOP=1`).
- `os.version` is `sw_vers -productVersion` on macOS and `VERSION_ID` from
  `/etc/os-release` on Linux, or null.
- Besides sessions, these name their project too: each `pipeline.list` entry
  and `pipeline.changed`, each terminal in `pty.list` and `pty.create`
  (whose `cwd` is relative to that project), and each `cleanup.scan` row.
- Archived projects are listed (with `archived: true`) and served.
- A runtime serves its machine when it is built with
  `WorkspaceRpc::machine(identity, …)` (`src-tauri/src/remote/server.rs`).
  `terminalx-serve --runtime-kind local --relay-link <file>` with no
  `--project-root` does so through the relay (`serve_machine`,
  `src-tauri/src/remote/host.rs`), and keeps the local runtime's own
  pipelines, automations and worktree retention. A cloud workspace still
  requires `--project-root`. PRO-341's direct listener serves the same
  `WorkspaceRpc` (`RelayHost::rpc`), so every route sees one set of terminals.

### Project scoping

When `machine/1` is granted:

- A call that names a session, tab, terminal, pipeline, search or watch takes no
  `projectId`. The runtime knows which project it belongs to. If a `projectId` is
  given and does not match, the call is refused with `invalid_params`.
- A call that names none of these takes `projectId`: creating a session, a shell
  outside a session, and the `fs.*` and `git.*` calls.
- `fs.*` paths are relative to the project's folder and may not leave it, as
  workspace paths may not leave the workspace today
  (`src-tauri/src/remote/files.rs`). The project's worktrees are allowed too.
  The worktree folder is `project.join(worktree_dir)`
  (`src-tauri/src/git.rs:777`), which leaves the project when a person sets an
  absolute `worktreeDir`.
- `git.*` takes the `projectId`, and `repo` is relative to that project's
  folder, as `git.repositories` lists it for that project
  (`src-tauri/src/remote/git.rs`).
- A runtime serving several projects refuses a project call without `projectId`
  with `capability_not_granted`, naming `machine/1`.

As built (PRO-340):

- With `machine/1` granted, a project call with no `projectId` is
  `invalid_params`, and one naming a project the machine does not have (or
  no longer has) is `not_found`. The store is read on every call, so a
  project removed on the machine stops being served at once.
- A mismatched `projectId` is checked against a call's `sessionId`, its
  `pipeline`, its `ptyId` (an agent's terminal by its tab's session) and an
  `fs.unwatch` subscription. `fs.cancel` with a `projectId` cancels only in
  that project.
- `session.create` refuses `repository` with `invalid_params`, and ignores
  `pipelineSettings`: a machine keeps its own project settings, and a caller
  does not replace them. Its pipelines run on the machine's own host
  (`LocalHost::new`), so they merge with its `gh`.
- A project's registered linked worktrees outside its folder are named by
  absolute path in `fs/1` and as `repo` in `git/1`. The registered project
  must be a checkout root to serve its Git registry. The runtime checks the
  checkout, its registration and their common Git directory before admitting
  an external checkout.
  `worktreeDir` controls creation. A worktree inside the project uses a
  relative path. Other absolute paths are `path_forbidden`.
- A machine project's `git.repositories` is its checkout (`.`) and its
  linked worktrees, up to 100 rows. `preferredRepo` keeps a known checkout in
  that response. An explicit `repo` can name any verified checkout. Git
  operations require the repository's effective top-level directory to
  match the authorized checkout.
- File rename and delete refuse directories that contain a registered
  project or linked checkout, including a checkout with a damaged marker
  whose registration still names the directory.
- `cleanup/1` and `workspace/2` on a machine use the local runtime's own
  clean-up host: every open project, archived ones protected, as Settings →
  Storage does (`local_runtime::workspaces::host`).

### Method table

Every entry in `METHODS` (`src-tauri/src/remote/protocol.rs:113`) on a machine
connection:

- **Served**: as it is today, addressed by an id the runtime resolves.
- **Needs a project**: takes `projectId` (above).
- **Not served**: a machine connection cannot call it. The runtime does not
  grant `keys/1`, `mirror/1` or `collab/1` to a machine connection, so their
  methods are refused as for any namespace not granted. The other four
  (`session.nudge`, `pipeline.noteMerge`, `pipeline.noteTracker`,
  `lifecycle.dispositionFacts`) are refused with `method_not_found`.

`every_method_is_classified_for_machines` (`src-tauri/src/remote/protocol.rs`)
fails when a method in `METHODS` has no row here. A new method is classified in
the pull request that adds it.

| Method | Namespace | On a machine | Notes |
| --- | --- | --- | --- |
| `session.list` | `session/1` | Served | Every project's sessions; each names its `projectId` |
| `session.get` | `session/1` | Served | |
| `session.create` | `session/1` | Needs a project | `projectId` names where it runs; `repository` (`session-repository/1`) is not used; `baseRef` (`session-base/1`, PRO-348) names the branch a worktree is cut from |
| `session.close` | `session/1` | Served | |
| `session.send` | `session/1` | Served | With `agent-commands/1`, a durable receipt (decision 3) |
| `session.subscribe` | `session/1` | Served | |
| `session.tabs` | `session/1` | Served | Every session's tabs |
| `session.configure` | `session/1` | Served | |
| `session.markRead` | `session/1` | Served | |
| `session.nudge` | `session/1` | Not served | Wakes the cloud mailbox poll; a machine has no mailbox |
| `session.unsubscribe` | `session/1` | Served | |
| `keys.get` | `keys/1` | Not served | The content key opens checkpoints kept by the cloud API; a machine keeps transcripts on its own disk |
| `keys.rotate` | `keys/1` | Not served | As `keys.get` |
| `session.update` | `session/2` | Served | |
| `session.addTab` | `session/2` | Served | |
| `session.delete` | `session/2` | Served | |
| `session.interrupt` | `session/3` | Served | Live only; never resent after a drop |
| `session.toTerminal` | `session/3` | Served | |
| `session.turnCheckpoint` | `checkpoints/1` | Served | What a finished turn changed, from the checkpoint the machine kept (#1326) |
| `session.keepTurn` | `checkpoints/1` | Served | Manage only |
| `session.undoTurn` | `checkpoints/1` | Served | Manage only; refused with the overlapping paths and a token, done when sent again with it |
| `session.restoreUndo` | `checkpoints/1` | Served | Manage only; as `session.undoTurn` |
| `session.reset` | `checkpoints/1` | Served | Manage only; the chat (and, when asked, the checkout) back to a turn, or the last reset undone |
| `session.fork` | `checkpoints/1` | Served | Manage only; into a tab beside the source or a session on a worktree of its own; a new session stays in the source's project |
| `session.handoff` | `handoff/1` | Served | Manage only; another agent tab with its first prompt in one call: a second opinion, Retry in a new chat, the agent handoff (#1327) |
| `session.handoffContext` | `handoff/1` | Served | Manage only; names the session and an agent tab; the tab's context with the machine's own transcript path, for a handoff's prompt |
| `session.steer` | `agent-commands/1` | Served | Into the running turn; a durable receipt (decision 3) |
| `session.stop` | `agent-commands/1` | Served | Drops queued sends, stops the agent; applied again after a crash (decision 3) |
| `session.decide` | `agent-commands/1` | Served | Answers the named permission request or question once (decision 3) |
| `session.followUp` | `follow-ups/1` | Served | Edits, withdraws or releases a held follow-up, by the mailbox's rules with the receipts of `agent-commands/1` (#1328) |
| `runtime.agents` | `agents/1` | Served | Machine-wide; with each agent's version and sign-in, and the agents with no CLI there (PRO-350) |
| `bots.list` | `bots/1` | Served | The connected person's bots that live there, what needs them and what each is doing (PRO-482) |
| `bots.home` | `bots/1` | Served | One of the person's bots there: its list, chats, duties and role (PRO-482) |
| `bots.answer` | `bots/1` | Served | Answers one of the person's bots' questions there (PRO-482) |
| `bots.importPart` | `bots/1` | Served | One part of a bot moved there, held for this connection only (PRO-482) |
| `bots.import` | `bots/1` | Served | Takes in a bot moved there, owned by the person who connected (PRO-482) |
| `bots.export` | `bots/1` | Served | Reads out one of the person's bots there to bring it back (PRO-482) |
| `bots.exportPart` | `bots/1` | Served | One part of that read (PRO-482) |
| `bots.remove` | `bots/1` | Served | Lets go of one of the person's bots there once it is brought back (PRO-482) |
| `session.commands` | `composer/1` | Served | |
| `session.files` | `composer/2` | Served | |
| `session.attach` | `composer/3` | Served | Needs its store without the cloud agents layer (decision 3); `kind: "file"` with `composer/4` (PRO-407) |
| `session.prs` | `composer/5` | Served | The composer's `#` list from the machine's `gh`, in the session's project (#1329) |
| `session.prContext` | `composer/5` | Served | A pull request's context for the composer's `#` list, from the machine's `gh` in the session's project (#1329) |
| `pty.create` | `pty/1` | Needs a project | Unless it names a `sessionId` (`pty/2`), which places it in that session's folder |
| `pty.list` | `pty/1` | Served | Every terminal; each names its session or project |
| `pty.write` | `pty/1` | Served | |
| `pty.resize` | `pty/1` | Served | |
| `pty.control` | `pty/1` | Served | |
| `pty.kill` | `pty/1` | Served | |
| `pty.attach` | `pty/1` | Served | |
| `pty.detach` | `pty/1` | Served | |
| `fs.list` | `fs/1` | Needs a project | |
| `fs.stat` | `fs/1` | Needs a project | |
| `fs.read` | `fs/1` | Needs a project | |
| `fs.write` | `fs/1` | Needs a project | |
| `fs.writePart` | `fs/1` | Needs a project | |
| `fs.search` | `fs/1` | Needs a project | |
| `fs.cancel` | `fs/1` | Served | Names the search |
| `fs.rename` | `fs/1` | Needs a project | |
| `fs.delete` | `fs/1` | Needs a project | |
| `fs.mkdir` | `fs/1` | Needs a project | |
| `fs.watch` | `fs/1` | Needs a project | |
| `fs.unwatch` | `fs/1` | Served | Names the watch |
| `mirror.manifest` | `mirror/1` | Not served | The offline mirror of a cloud workspace (PRO-25); a machine session reads live and shows its last known state while unreachable (PRO-352) |
| `git.repositories` | `git/1` | Needs a project | The project's checkout and its worktrees |
| `git.status` | `git/1` | Needs a project | |
| `git.branchBase` | `git/1` | Needs a project | |
| `git.branchDiffSize` | `git/1` | Needs a project | |
| `git.diff` | `git/1` | Needs a project | |
| `git.workingChanges` | `git/1` | Needs a project | |
| `git.reviewRange` | `git/1` | Needs a project | |
| `git.changesBetween` | `git/1` | Needs a project | |
| `git.fileContents` | `git/1` | Needs a project | |
| `git.mediaContent` | `git/1` | Needs a project | |
| `git.log` | `git/1` | Needs a project | |
| `git.branches` | `git/1` | Needs a project | |
| `git.prs` | `git/1` | Needs a project | |
| `git.prConversation` | `git/1` | Needs a project | |
| `git.prReviewerSearch` | `git/1` | Needs a project | |
| `git.prConversationAction` | `git/1` | Needs a project | |
| `git.prAssociations` | `git/1` | Needs a project | Advertises support for linking existing branch PRs. URL-only targets require `git-pr-target/1`. Older clients get PR-bound locators for GitHub.com and manually linked machine PRs. |
| `git.prLanded` | `git/1` | Needs a project | |
| `git.checkout` | `git/1` | Needs a project | |
| `git.commit` | `git/1` | Needs a project | |
| `git.commitForPush` | `git/1` | Needs a project | |
| `git.stage` | `git/1` | Needs a project | |
| `git.unstage` | `git/1` | Needs a project | |
| `git.fetch` | `git/1` | Needs a project | With the machine's git sign-in |
| `git.push` | `git/1` | Needs a project | With the machine's git sign-in |
| `git.pushHead` | `git/1` | Needs a project | Pushes the confirmed commit with the machine's git sign-in |
| `git.pull` | `git/1` | Needs a project | With the machine's git sign-in |
| `git.prCreate` | `git/1` | Needs a project | With the machine's `gh`. Older requests can add an open PR as a removable link and respect prior withdrawals. Set `associateExisting: false` to leave existing PRs for explicit linking. |
| `git.prCreateForSession` | `git/1` | Needs a project | Verifies the session checkout, optionally publishes the confirmed commit, and opens the PR with the machine's `gh` |
| `git.prReconcileCreation` | `git/1` | Needs a project | Clears a pending create's cleanup guard by PR URL once the machine's `gh` shows it merged or closed; the record must belong to one of the project's checkouts and the URL to its origin repository. Open or unreachable PRs stay protected |
| `git.prLinkBranch` | `git/1` | Needs a project | Verifies a manager-supplied PR URL against the session's checkout and saves a removable link |
| `git.prUnlink` | `git/1` | Needs a project | Removes a manually added PR link using the machine's registry |
| `git.prReady` | `git/1` | Needs a project | With the machine's `gh` |
| `git.prMerge` | `git/1` | Needs a project | With the machine's `gh` |
| `cleanup.scan` | `cleanup/1` | Served | Every project of the machine, as Settings → Storage scans every local project; each row names its project |
| `cleanup.size` | `cleanup/1` | Served | Names what the scan listed |
| `cleanup.cancel` | `cleanup/1` | Served | |
| `cleanup.remove` | `cleanup/1` | Served | Names what the scan listed |
| `workspace.disposition` | `workspace/1` | Served | Names the session |
| `workspace.remove` | `workspace/1` | Served | Names the session |
| `workspace.sweepMerged` | `workspace/2` | Served | Every project |
| `workspace.holdMerged` | `workspace/2` | Served | |
| `workspace.removedRecords` | `workspace/2` | Served | |
| `workspace.restoreRemoved` | `workspace/2` | Served | |
| `pipeline.reviewers` | `pipeline/2` | Served | |
| `pipeline.list` | `pipeline/1` | Served | Every project's pipelines |
| `pipeline.act` | `pipeline/1` | Served | Names the pipeline |
| `pipeline.resolveConflicts` | `pipeline/1` | Served | Names the pipeline |
| `pipeline.noteMerge` | `pipeline/1` | Not served | Exists because a cloud runtime cannot merge; a machine's pipelines merge with the machine's own `gh` (`src-tauri/src/issue_pipeline/host.rs`) |
| `pipeline.noteTracker` | `pipeline/1` | Not served | Exists because a cloud runtime holds no Linear key; a machine uses its own (`src-tauri/src/issue_pipeline/host.rs:81`) |
| `lifecycle.dispositionFacts` | `lifecycle/1` | Not served | Facts before a cloud workspace is archived or deleted; nothing archives a machine |
| `lifecycle.resources` | `lifecycle/1` | Served | Measures the disk of the root it is given (`src-tauri/src/remote/server.rs:1064`); a machine measures its data directory's disk, its memory and its processor (PRO-350) |
| `collab.state` | `collab/1` | Not served | Sharing with other people is out of scope (PRO-338) |
| `presence.update` | `collab/1` | Not served | As `collab.state` |
| `notes.list` | `collab/1` | Not served | As `collab.state` |
| `notes.post` | `collab/1` | Not served | As `collab.state` |
| `lease.acquire` | `collab/1` | Not served | As `collab.state`; two operating computers on one tab are not arbitrated in the first version |
| `lease.release` | `collab/1` | Not served | As `lease.acquire` |
| `lease.takeOver` | `collab/1` | Not served | As `lease.acquire` |
| `environment.report` | `environment/1` | Served | Manage authority only; bounded installed-tool versions from the machine, fixed probes and a per-caller limit, no caller-supplied command or project path |
| `environment.cancel` | `environment/1` | Served | Manage authority only; cancels only this attachment's report request |
| `ports.list` | `ports/1` | Served | The machine's loopback |
| `ports.open` | `ports/1` | Served | A forward ends with the connection (PRO-355) |
| `ports.write` | `ports/1` | Served | |
| `ports.ack` | `ports/1` | Served | |
| `ports.close` | `ports/1` | Served | |
| `machine.describe` | `machine/1` | Served | Only a runtime that serves its machine; see [machine/1](#machine1) |
| `machine.projects` | `machine/1` | Served | As `machine.describe` |
| `machine.relayAccess` | `machine/2` | Served | A paired computer's relay invite, or `{ relay: null }` with no relay registration (PRO-345) |
| `machine.updateStatus` | `machine/3` | Served | The machine's version and what it could update to (PRO-354, [Versions and updates](#versions-and-updates-pro-354)) |
| `machine.update` | `machine/3` | Served | Manage only; refused with `update_confirm`, `update_busy` or `update_unavailable` as that section says |
| `machine.agentSetup` | `machine/4` | Served | Manage only; an agent's install or sign-in in a terminal on the machine (PRO-350, [The machine page](#as-built-pro-350-the-machine-page)) |
| `machine.agentSetupRunning` | `machine/4` | Served | Manage only; the setup step running there for one agent, if any |
| `machine.rotateCredential` | `machine/5` | Served | Manage only; a fresh device token for the paired computer that asks, kept beside its own until it connects with it ([Trust model](#trust-model), PRO-357) |
| `machine.browse` | `machine/6` | Served | Manage only; folder names under the home directory of the runtime's user, never a file's contents (PRO-351, [A machine's projects](#as-built-pro-351-a-machines-projects-from-another-computer)) |
| `machine.addProject` | `machine/6` | Served | Manage only; a folder under that home becomes a project |
| `machine.removeProject` | `machine/6` | Served | Manage only; names the project; its folder and worktrees stay on disk |
| `machine.cloneProject` | `machine/6` | Served | Manage only; starts a clone with the machine's git sign-in |
| `machine.cloneStatus` | `machine/6` | Served | Manage only; names the clone |
| `machine.cloneCancel` | `machine/6` | Served | Manage only; names the clone |
| `machine.sessionActions` | `machine/7` | Served | Names a session; its project's saved actions, preview URLs and setup script as the machine has them, its ports and its setup run (PRO-403, [Setup and Run](#as-built-pro-403-setup-and-run-in-a-machine-session)) |
| `machine.runAction` | `machine/7` | Served | Manage only; runs a saved action in the session's folder on the machine |
| `machine.setupRerun` | `machine/7` | Served | Manage only; runs the session's setup script again on the machine |
| `machine.setupStop` | `machine/7` | Served | Manage only; stops the session's setup attempt |
| `machine.setListen` | `machine/9` | Served | Manage only; `listen` (`relay`, `tailscale`, `lan`, `all`) and `allowPublic`; answers the new listen status. Refused (`unavailable`) for `relay` on a machine not registered with the relay, which would leave it unreachable (PRO-487) |
| `session.usage` | `machine/8` | Served | Names the session; its tokens and cost read again from the machine's transcripts, how each agent signs in there, and the machine's usage windows (PRO-408, [Session parity](#as-built-pro-408-cost-account-continue-and-fix-check-errors)) |
| `session.prepareContinuation` | `machine/8` | Served | Names the session and an agent tab; the tab's context with the machine's own transcript path |
| `session.checkFailures` | `machine/8` | Served | Manage only; names the session, an agent tab and a pull request's https URL; its failed check logs read with the machine's `gh` into the session's attachments folder there |

Not settled by any ticket yet: asking a machine to merge one of its pipelines
from the operating computer. A runtime has no `pipeline.merge`
(`src-tauri/src/remote/protocol.rs:531`), and a cloud merge runs on the desktop
(`issue_pipeline_merge_cloud`). On a machine, the machine's own pipeline
merges as it does today. A person can still merge the pull request with
`git.prMerge`.

## Sequences

### Pairing by code (no account)

1. On the machine, the person turns on "Let other computers operate this Mac".
   The runtime loads the host key and opens the direct listener. If it is signed
   in, it also registers with the relay.
2. "Create pairing code": the runtime makes a fresh device token
   (`random_token`, 32 bytes), keeps only its SHA-256 as a pending,
   unclaimed device, and shows a version 2 offer: `deviceToken`, `publicKeyB64`,
   `scope: "runtime"`, `identityMode: "authenticate"`, every direct endpoint, and
   a relay bundle only when signed in. The code expires in five minutes
   (`OFFER_TTL_MS`) and works once.
3. On the operating computer, the person pastes the code. It decodes the offer,
   computes `machineId` from `publicKeyB64`, and shows the machine's name and the
   pairing fingerprint. It holds every input already: the host key, its own key
   and the token (`docs/PAIRING-APPROVAL.md`, "Fingerprint").
4. It connects to the first endpoint that answers and runs the E2EE v2
   handshake. It pins the host key to the offer's and sends the token only inside
   `e2ee_auth`, with its `label` and `platform` beside it. A phone sends those
   later, in `device.describe`, after it is authenticated, but the machine must
   name the computer before "Allow" (screen 21.05). The phone host parses
   `e2ee_auth` strictly (`deny_unknown_fields`, `src-tauri/src/pairing/mod.rs:1873`),
   so these fields go only to a machine offer, and only the machine host reads
   them.
5. The machine matches the token to the pending device and computes the same
   fingerprint from the connection's client key. It shows the approval dialog
   with the operating computer's name and the fingerprint, and does not send
   `e2ee_authenticated` yet. The approval waits two minutes (`APPROVAL_TTL_MS`).
   On a machine with no window, the prompt is `terminalx-serve pair` in the
   terminal that made the code (PRO-353). It names the computer, shows the
   fingerprint and asks "Allow? [y/N]". Only "y" from that terminal approves.
   Nothing approves by default, and no answer means "Don't allow".
6. "Allow" writes the paired computer (token hash, client public key, name,
   fingerprint, `approved_at`) to the paired-computer registry, spends the code,
   and sends `e2ee_authenticated`. "Don't allow" or no answer discards everything
   (`docs/PAIRING-APPROVAL.md`, steps 4 and 5).
7. The operating computer stores the machine (`machineId`, name, pinned key,
   routes, last seen) and keeps the device token in its Keychain. It then calls
   `rpc.hello`, `machine.describe` and `machine.projects`.

Five wrong or expired attempts in a minute pause pairing for a minute (PRO-342).

#### As built (PRO-342)

The owner settled four points against the screens on 2026-11-15: both dialogs
show the four-group pairing fingerprint; 21.05's "won't" list says what
TerminalX offers, with a line saying a shell runs as the machine's user; the
controls live in a small Settings → Machines section behind Experimental →
Machines until PRO-349 builds the page; and 21.04 shows only the pairing code,
with no tab bar until PRO-344 and PRO-353 add their tabs.

**The code.** `txm2.` followed by base64url (no padding) of this JSON:

```json
{
  "v": 2, "kind": "machine", "scope": "runtime", "identityMode": "authenticate",
  "deviceToken": "<random_token, 32 bytes, base64url>",
  "publicKeyB64": "<host key, standard base64>",
  "machine": { "machineId": "cs1uhCLEB_ttCYaQ", "name": "Mac mini",
               "os": { "family": "macos", "version": "26.1" }, "version": "0.2.33" },
  "directEndpoints": ["ws://192.168.1.20:6768/machine/1", "ws://mac-mini.local:6768/machine/1"],
  "expiresAt": 1763200000000
}
```

- `machine` carries what `machine.describe` would, so the operating computer
  names the machine before it connects. `machineId` must equal
  `host_id(publicKeyB64)`, or the code is refused.
- `directEndpoints` are `advertised_endpoints` (moved to a module both builds
  compile) with the path `/machine/1`, LAN and `.local` and Tailscale alike.
- `relay` is absent. A desktop runtime has no relay registration of its own
  until PRO-344, and minting a relay invite for a new device needs the account.
  The decoder accepts an optional `relay` in the `RelayOffer` shape so PRO-344
  adds it without a new version. "Relay and nearby" is kept with the machine and
  uses the relay once there is one.
- The code works once and lasts five minutes (`OFFER_TTL_MS`). Creating a new
  code ends the one before. The token is kept only as its SHA-256, in memory:
  a restarted runtime has no code.

**The operating computer's key.** One long-lived X25519 key per installation,
in the login Keychain (service `<app identifier>.machines`, account
`client-e2ee-key`), used as the E2EE client key on every connection to every
machine. The fingerprint binds it, and the machine pins it.

**`e2ee_auth` from an operating computer** adds `label` (This Mac's name, 1–64
characters, control characters stripped) and `platform` (`macos` or `linux`)
beside `deviceToken`. The machine host reads them; the phone host never sees them.

**The machine host answers `e2ee_auth`** in this order:

1. While pairing is paused, a token that is not a paired computer's gets
   `pairing_refused` `pairing-paused`.
2. A paired computer's token is admitted only with the client key it paired
   with (`clientPublicKeyB64`). Another key is a wrong attempt, refused with
   close `4401`. A code that was used therefore cannot be replayed from
   another computer. The relay route checks the same. A record with no
   client key (only PRO-341's tests and hand-written records have none) is
   admitted by its token alone, as before; every record pairing writes has one.
3. The live code's token starts an approval: the host computes the fingerprint
   from the connection's client key, publishes `pending` in its status, and
   waits up to two minutes (`APPROVAL_TTL_MS`). More connections with the same
   client key share the request; one with another key gets
   `pairing_refused` `another-computer`.
4. An expired, used or ended code's token, or one that matches nothing, is a
   wrong attempt: `pairing_refused` `code-inactive`, then close `4401`. The
   machine cannot tell a revoked computer's token from a spent code's, so a
   computer that was connecting sees "Access removed" (Connect, step 2) and
   one that was pairing has read the reason first.

`pairing_refused` is `{"type":"pairing_refused","v":1,"reason":…}`, sealed,
then the socket closes. **Allow** writes the paired computer (token hash,
client key, label, platform, fingerprint, `approvedAt`), spends the code and
sends `e2ee_authenticated`; the connection then serves workspace RPC with
`Authority::Manage`. **Don't allow**, two minutes with no answer, or the
asking connection closing, ends the code and sends `not-approved`.

**Attempt limit.** Five wrong attempts (rules 2 and 4) within 60 s pause
pairing until 60 s after the fifth. While paused, `createCode` is refused
(`pairing_paused`, with `pausedUntil`) and the status says `pausedUntil`. Paired
computers with the right key still connect.

**Runtime IPC** (`machine_wire`), each with the window's `epoch` and `lease`:

| Command | Params | Result |
| --- | --- | --- |
| `runtime.machineHost.createCode` | none | `{ code, expiresAt }`, or `pairing_paused` / `not_enabled` |
| `runtime.machineHost.approve` | `requestId` | `{ approved: true }`, or `not_found` |
| `runtime.machineHost.decline` | `requestId` | `{ declined: true }` |

The runtime fills `machine` as `machine.describe` does and computes the
endpoints itself, so a headless runtime (PRO-353) makes the same code. `Status` gains
`pending` (`{ requestId, label, platform, fingerprint, transport, requestedAt,
expiresAt }` or null), `code` (`{ expiresAt }` or null; never the code) and
`pausedUntil` (or null).

**Tauri commands.** On the machine: `machines_host_status`,
`machines_set_allow_operating { enabled }`, `machines_create_code`,
`machines_approve { requestId }`, `machines_decline { requestId }`,
`machines_revoke { id }`; the window re-emits the runtime's status as
`machines_host_changed`. On the operating computer: `machines_inspect_code
{ code }`, `machines_pair { code, route }`, `machines_cancel_pairing`,
`machines_list`, `machines_set_route { machineId, route }`. The shapes are in
`src/types/machines.ts`; `machines_pair` answers `{ paired: false, reason }`
for a refusal, with the reasons of `pairing_refused` plus `unreachable`,
`invalid-code` and `cancelled`.

**The operating computer's store.** `~/.raccoon/machines.json` (the store's
root), one record per `machineId` (name, os, version, pinned
`publicKeyB64`, `directEndpoints`, `route` of `relayAndNearby` or
`thisNetwork`, `pairedAt`, `lastSeenAt`), and the device token in the Keychain
(service `<app identifier>.machines`, account `machine:<machineId>`).
`machines_pair` tries each endpoint in order, five seconds each to connect,
and waits up to 150 s for Allow. PRO-345 connects with what it stores.

#### As built (PRO-353): a headless server

A person's own Linux server (or a Mac without the app) runs `terminalx-serve`
as a user service and is paired from its own terminal. The user's guide is
[HEADLESS-SERVER.md](HEADLESS-SERVER.md); the operator's notes are in
[HEADLESS-SERVE.md](HEADLESS-SERVE.md), "On a person's own server".

- **Commands** (`src-tauri/src/serve_cli/`): `service install|status|uninstall`
  (a systemd user unit with lingering, or a LaunchAgent), `pair`,
  `devices [revoke <id>]`, `projects [add <folder>]`, `login`/`logout` and
  `update [--check]`. Each finds the data directory as the runtime does:
  `--data-dir`, `TERMINALX_HOME`, then `~/.terminalx/data`.
- **Default data directory.** A runtime the desktop did not launch, given no
  `--data-dir` or `TERMINALX_HOME`, uses `~/.terminalx/data` (mode 0700, and
  `~/.terminalx` too), refused when `run/hooks-<pid>.sock` would not fit in a
  socket path (103 bytes). A desktop-launched runtime
  (`TERMINALX_LOCAL_DESKTOP=1`) still refuses to start without one.
- **Decision 9 as built.** `service install` never turns hosting on. `pair`
  asks "Let other computers operate this server? [y/N]" first, then makes the
  code, waits, names the computer with the four-group fingerprint and asks
  `Allow? [y/N]`. Only `y` approves; anything else, end of input, Ctrl-C or two
  minutes declines.
- **The screen's header.** 21.06's "On the server" panel shows a fingerprint
  before any computer has asked, which cannot exist yet: the fingerprint binds
  the computer's key and the token. `pair` shows `Machine ID <machineId>`
  there instead, and the fingerprint on the request line, as the dialog does.
- **Only a person answers.** `runtime.machineHost.createCode` and `approve`
  take a `consent` parameter naming a witness socket the caller binds in
  `<data dir>/run/`, with a nonce only the caller knows. The runtime reads the
  witness's pid from the kernel (`SO_PEERCRED`, `LOCAL_PEERPID`), challenges it
  with the nonce, and refuses (`person_required`) the runtime itself, any
  process it started, one whose controlling terminal is one of its terminals,
  and one with no controlling terminal: on a runtime with no window always;
  on a runtime the desktop launched on a Mac, unless it proves it is the
  window (PRO-369). The window signs the witness socket and nonce with its
  Keychain consent key. The desktop pins the public key when it launches the
  runtime. Adoption of a machine host key over IPC cannot change the consent
  key. `pair` also requires a terminal for input and output
  (`src-tauri/src/serve_cli/consent.rs`). A same-user process that detaches
  and opens a pseudo-terminal of its own can pass the terminal check.
- **`projects.add`** on the control socket (new): registers a folder as a
  project (`store::projects::ensure`) and emits `projects_changed`, so
  `machine.changed` reaches connected computers. The runtime is the store's
  only writer for it. A fresh server has no project until one is added, and
  `machine/1` has no way to add one remotely.
- **The account.** `login` uses the device authorization grant
  (terminalx-saas `machine-relay-access.md`, "Device-code sign-in") and keeps
  the desktop Cloud Session it ends in at `<data dir>/account/session.json`
  (0600, in a 0700 folder; `src-tauri/src/machine_account.rs`). The runtime
  registers with the relay from it while the switch is on (PRO-368). Since
  PRO-487 a code made on a registered machine carries `relay` (a single-use
  invite), so a server with no listener is paired through the relay
  ([As built (PRO-487)](#as-built-pro-487-where-a-machine-listens-and-what-it-runs-as)).
- **Signed releases.** `SHA256SUMS` of each runtime release is signed as an SSH
  signature (namespace `terminalx-runtime`, principal `release@terminalx`) on
  the owner's Mac (`scripts/release/sign-runtime.py`); no signing key is on
  GitHub. The installer and `update` refuse an unsigned release or a bad
  signature before anything under `~/.terminalx` changes, then check the
  binary and `terminalx-serve.json` against the signed hashes and that the
  binary reports the signed version.
- **Tested** by `scripts/remote-runtime/e2e-install-linux.sh`: a fresh Ubuntu
  24.04 container with systemd installs from a locally signed release over SSH,
  refuses one signed by another key, pairs through `ssh -tt`, serves a first
  session, and after `docker restart` the computer connects again and finds it.

### Pairing through the account

1. Both computers are signed in to the same account. The machine has the switch
   on, so its directory entry advertises the operating capability (PRO-344).
2. The operating computer lists the account's machines and the person chooses
   "Connect". It requests a one-time grant for the operating scope, signed with
   its installation key, as the phone does for `mobile` (`docs/MOBILE.md`,
   "Account-bound HPKE pairing").
3. The machine's runtime polls the grant, makes the same offer as step 2 above,
   and seals it with HPKE to the grant's key (`seal_account_offer`,
   `src-tauri/src/pairing/crypto.rs`).
4. The operating computer opens the envelope and checks that the offer's key is
   the directory's key byte for byte and that `machineId` matches it. It then
   continues at step 4 above, approval included (decision 5).

On a machine with no window, an account pairing waits for a person in a
terminal, as one by code does. While `terminalx-serve pair` runs, it lists the
pending request with its name and fingerprint and takes "Allow? [y/N]". With no
`terminalx-serve pair` running, the runtime keeps the request for
`APPROVAL_TTL_MS` and then declines it. The operating computer says to approve
it on the server with `terminalx-serve pair`. The runtime never approves a
computer by itself, and a signed-in account is not an approval.

Who may answer: the approval comes from the person, never from an agent. An
agent on the machine has a shell and could run `terminalx-serve pair` itself.
So `terminalx-serve pair` refuses to approve when it runs inside a terminal or
agent the runtime started, and when its input is not a terminal. PRO-357 tests
this ("an agent running on the machine cannot approve a pairing or create a
pairing code").

#### As built (PRO-349): through the account, and Settings → Machines

PRO-344 built the server side (terminalx-server
`apps/api/docs/machine-relay-access.md`). PRO-349 builds the desktop side,
because the "On your account" tab of Add a machine (screen 21.03) needs it.

- **The capability.** The window's host binding advertises
  `machine-operating.v1` beside `account-bound-host-pairing.v1` only while
  "Let other computers operate this Mac" is on and data privacy mode is off.
  Changing the switch sends a heartbeat at once
  (`PairingManager::machine_operating_changed`), so the account directory lists
  the Mac as not available without waiting for the next one.
- **The machine answers runtime grants.** The window polls
  `requestedScope=runtime` grants beside the phone's `mobile` ones (whose
  handling is unchanged). For each, it asks its runtime for a fresh machine code
  (`runtime.machineHost.createCode`, with the grant's id), seals the code's JSON
  (exactly the bytes a `txm2.` code base64url-encodes) with the phone grant's
  HPKE envelope and publishes it. Creating that code ends any code made before.
  The computer still waits for Allow and the four-group fingerprint (decision
  5); a granted account is never an approval. The approved computer's record
  keeps the grant's id, so a runtime revocation from the poll revokes it, and
  revoking it on the machine also revokes the grant on the server
  (`reason: "host-removed"`).
- **The operating computer** registers a client installation (a P-256 key in
  the Keychain, service `<app identifier>.machines`) with
  `account-bound-host-pairing.v1` and `machine-operating.v1`, lists
  `GET /v1/account/hosts`, and requests a grant whose signed transcript ends in
  `runtime`. It opens the envelope, refuses an offer whose key is not the
  directory's key byte for byte or whose `machineId` is not that key's
  (`key_mismatch`), and hands the dialog the offer as a `txm2.` code. From there
  it pairs exactly as a pasted code, and consumes the grant once paired or
  revokes it when not. Commands: `machines_account_list`,
  `machines_account_request { hostId }`, `machines_account_cancel`,
  `machines_account_finish { grantRequestId, paired }`; shapes in
  `src/types/machines.ts`.
- **A headless server** pairs computers from its terminal (PRO-353). Its
  account listing advertises terminal QR pairing for phones (PRO-359).
- **Remove** (`machines_remove { machineId }`) stops the machine's connection
  and deletes its record, its device token and its relay credential. Nothing on
  the machine changes: its sessions keep running, and it lists this computer
  until someone revokes it there.
- **Key labels.** Cards show a short label for a key ("7F3A·91C2"): the first
  four bytes of SHA-256 of the public key, read from `machineId` (or a paired
  computer's `keyId`, `host_id` of its client key). It is a label only; Allow
  compares the pairing fingerprint.
- **The machine record** keeps `hasWindow` from `machine.describe`, so a card
  says "headless". A paired computer's row says its `route` (`lan`,
  `tailscale` or `relay`) while it is connected.
- **Not built here.** The "Update" button for a machine that needs an update is
  PRO-354; the machine's own page is PRO-350 (a card opens the machine's view in
  the main slot until then).

### Connect

1. The operating computer loads the machine's record and opens one connection
   (decision 2). It tries the routes in order: the route that last worked, each
   LAN endpoint, the Tailscale endpoint, then the relay when both sides are
   signed in.
2. On each route it runs the same E2EE v2 handshake with the pinned key, proves
   its device token, and calls `rpc.hello`. A refused credential (`4401` on the
   relay, or `auth_failed`) means "Access removed", and it stops retrying.
3. It subscribes to the session list and `machine.changed`, then loads chat
   history and terminal replay for what is on screen.

### Reconnect

- One reconnect owner per machine, so sleep, wake, network changes and route
  probes cannot start parallel attempts (`Supervisor`,
  `src-tauri/src/remote/client.rs:301`).
- Backoff from 250 ms to 10 s with jitter (`backoff`,
  `src-tauri/src/remote/protocol.rs:482`). Relay close codes keep their meanings
  (`close_action`, `src-tauri/src/remote/protocol.rs:459`).
- After a reconnect, the client calls `rpc.hello` again, subscribes again,
  replays each open transcript past its cursor, and re-attaches each visible
  terminal with its bounded replay, as a local window does after a lag
  (`docs/LOCAL-RUNTIME.md`, "Proposed ownership and attachment").
- A command whose reply was lost is resent with the same `clientRequestId`, and
  its receipt answers it. `session.interrupt` is not resent.
- When a direct route comes back while on the relay, the client opens it, takes
  the same subscriptions on it, then closes the relay connection. Nothing in the
  session view reloads.

### As built (PRO-345)

PRO-345 settled these points while building Connect and Reconnect.

**`machine/2`** adds to `machine/1`, as namespaces do:

- `machine.describe` and `machine.changed` name `directEndpoints`: the
  machine's current `ws://…:6768/machine/1` addresses, computed as for a
  pairing code. The operating computer keeps the latest list, so a machine
  whose address changed is still found.
- `machine.relayAccess` (`Manage`, paired computers only), no params. A
  runtime with a live relay registration gives the computer a relay device id
  once (kept as `relayDeviceId` on its record in `paired-computers.json`),
  asks the relay for a fresh single-use invite for it (`invite-create`), and
  answers
  `{ "relay": { "v": 1, "directorUrl", "cellUrl", "assignmentEpoch", "relayHostId", "relayDeviceId", "inviteToken", "inviteExpiresAt", "e2eeFraming": 2 } }`.
  With no registration it answers `{ "relay": null }`. Revoking the computer
  also sends `device-revoke` for its relay device id, so its relay credential
  ends with it.
- A signed-in machine registers itself with
  `POST /v1/desktop/machine-host/relay-session` while the switch is on
  ("As built (PRO-368)"). Signed out, or with the switch off,
  `machine.relayAccess` answers `{ "relay": null }` and the relay route is
  skipped.

**Routes.** A route is `lan` (a direct endpoint that is not Tailscale),
`tailscale` (a host in `100.64.0.0/10` or under `.ts.net`), or `relay`. One
round tries, in order: the route that last worked, every `lan` endpoint, every
`tailscale` endpoint, then the relay. A direct endpoint gets 3 s to connect and
finish the handshake, the relay 15 s. The relay is tried only when the record's
route is `relayAndNearby`, this computer holds a relay credential for the
machine, and the account that obtained it is signed in. "Only this network"
(`thisNetwork`) never uses the relay. Choosing it (`machines_set_route`) tells
the owner at once: a relay link it no longer allows is closed then, not when
it happens to drop, and the next round tries only the direct routes.

**Relay credential.** After a direct connection is established, while signed
in, with `relayAndNearby` and no credential, the operating computer calls
`machine.relayAccess`. With an invite it connects through the relay at once
(`relay-auth` v1, `credential` the invite), runs the same E2EE and `e2ee_auth`,
calls `pairing.provisionRelay` with a fresh resume token's hash, and closes
that connection. The resume token goes in the Keychain (service
`<app identifier>.machines`, account `relay:<machineId>`); the record keeps
`relay: { directorUrl, cellUrl, assignmentEpoch, relayHostId, relayDeviceId, userId }`.
A later relay connection first asks the director for the cell
(`POST <directorUrl>/v1/resolve` `{ v: 1, relayHostId, resumeToken }`, as the
phone does), falls back to the saved cell, and connects with `credential` the
resume token. A relay that refuses the credential (`4401`) deletes it; the
next direct connection asks again. `4404` is the machine offline at the relay
(the relay's `HOST_OFFLINE`), not a refusal: the credential is kept and the
round moves on, and the next round tries the relay again.

**One owner per machine.** The desktop holds at most one supervisor per
`machineId`; `machine_remote_attach` returns the existing connection id when
there is one, and sends `cloud_remote_event` with the current state at once, so
a web view that attaches to a live connection (a second window, or the same
one after a reload) is not left waiting for the next change. Every web view
that attached it holds the connection, by its webview label (a reload holds
again under the same label). `cloud_remote_detach` lets go for the calling web
view, a window that closes lets go of everything it held (it runs no cleanup
of its own), and the owner stops when the last holder lets go. Sleep, wake, a network change, a route probe and "Try again"
only nudge that owner. Wake is a wall-clock jump of more than 3 s against the
monotonic clock (checked every second); a network change is a change in the
set of interface addresses (checked every 2 s). A nudge while connected checks
the link with `machine.describe` (3 s); no answer drops it. A nudge while
waiting retries at once with the backoff reset to 250 ms. Backoff is
`protocol::backoff`: 250 ms doubling to 10 s, with jitter.

**Each connection** runs E2EE v2 pinned to the stored key with this
installation's client key, proves the device token (Keychain
`machine:<machineId>`) in `e2ee_auth` with `label` and `platform`, calls
`rpc.hello` wanting every capability in `CAPABILITIES`, then
`machine.describe`. It refuses a runtime that does not grant `machine/1`
("needs update") and a `machineId` that is not the stored one. Close `4401`, or
`pairing_refused` before `e2ee_authenticated`, means "access removed": the
owner stops retrying until "Try again". A successful `machine.describe` updates
the record's name, os, version, `directEndpoints`, `lastSeenAt` and
`lastRoute`; while connected, the owner repeats it every 30 s, which also
measures `rttMs` end to end.

**Moving to a direct route.** While on the relay, the owner tries the direct
routes every 30 s and on every nudge. At most one such probe, or one use of a
relay invite, runs at a time, and never beside a round: when the link is lost
while one runs, the round starts at once. A direct link the probe already
found is used, a relay credential already obtained is kept, and an attempt
still under way is cancelled first. When one is established it becomes the
link: frames from the web view go to it from then on, and the web view is told
`connected` again with a new `link` number. The relay connection stays open
for 10 s more so answers to requests already sent on it still arrive; its
notifications are dropped. The portable client takes a new `link` while
connected as a new connection: it resubscribes from its cursors, so chat and
terminals pick up where they were without a reload. Losing a direct link while
the relay works goes through `reconnecting` the same way.

**macOS Local Network.** The desktop's `Info.plist` has
`NSLocalNetworkUsageDescription`. When a `lan` endpoint fails with
`EHOSTUNREACH` while Local Network access is refused, the state carries
`localNetworkDenied: true` and the other routes are still tried.

**Signing out** of the account closes relay connections and stops trying the
relay. Machines paired by code, their tokens and their relay credentials stay;
the credential is used again only when the same account signs in, and is
deleted when another one does.

**States** (`MachineConnectionState` in `src/types/machines.ts`): `idle` (not
attached), `connecting`, `direct` (with `lan` or `tailscale`), `relay`,
`reconnecting` (a link was lost less than 30 s ago), `offline` (no route
answered for 30 s; still retrying), `needsUpdate`, `accessRemoved`. The web
view's transport sees the cloud states it knows: `connecting`, `connected`,
`reconnecting` (for reconnecting and offline), `updateRequired` and `stopped`
(access removed).

**Tauri commands** on the operating computer:

| Command | Params | Result |
| --- | --- | --- |
| `machine_remote_attach` | `machineId` | The connection id for `cloud_remote_send`, `cloud_remote_detach` and `cloud_port_*`; its states and messages come as `cloud_remote_event`. Refused with `machine_unknown` or `machine_token_missing` |
| `machines_connections` | none | `MachineConnectionView[]`, one per paired machine (`idle` when not attached) |
| `machines_reconnect` | `machineId` | "Try again": nudges the owner; after `accessRemoved` or `needsUpdate` it tries once more |

The event `machines_connection_changed` carries one `MachineConnectionView`
whenever a machine's state changes. `machines_list` answers each record with
`lastRoute` and `relay` (no secret). `cloud_remote_attach_dev` and the debug
Development section are gone; their tests use `machine_remote_attach`.

### As built (PRO-368): a signed-in machine registers with the relay

**The registration.** While "Let other computers operate this Mac" is on, the
host key is ready and someone is signed in on the machine, its runtime
registers with the relay under its relay host id (`machineId`), through the
same `RelayHost` as `--relay-link` (`MachineHost::start_relay`,
`src-tauri/src/machine_host.rs`). It serves the machine's one `WorkspaceRpc`,
admits paired computers by their relay device id and routes other devices to
the window's phone route when present, or to the runtime's phone host. Its link is
`remote::account_link::AccountLink`:

- The token comes from `POST /v1/desktop/machine-host/relay-session`
  (terminalx-saas `machine-relay-access.md`, "Machine relay session") with
  the session's access token. A link's first request sends no
  `runtimeGeneration`, so the server starts a new generation for this
  process; later ones send it. The token is renewed 5 minutes before it
  expires.
- `409 machine_runtime_superseded` stops the relay registration for good in
  this process: status `superseded`, and it does not register again for that
  account until it restarts. When the relay retires the registration with
  `4101`, the link asks the server at once instead of waiting for the token
  to near expiry, so a fenced process learns it was superseded and stops.
  The direct listener keeps serving: two processes cannot both hold 6768.
- With no session file (signed out) or a refresh the account service refuses,
  the registration ends and every connection it carried closes. The runtime
  rereads the file at least every 15 s while registered, so signing out, or
  another account signing in, ends it within that, not at the next token
  renewal. Paired
  computers fall back to their direct routes (`4404` at the relay is "offline",
  so they keep their relay credential for when it is back).
- Switching off ends it the same way, with a close frame, so the relay lets the
  window register again at once.
- A debug build registers only with `TERMINALX_DEV_RELAY_DIRECTOR_URL` set, and
  then with that director, never production's, as the window does.
- `409 host_binding_owner_conflict` (another account binds this machine) ends
  the link too; the runtime asks again for that account after 10 minutes, or
  at once for another account. The window registers itself meanwhile.
- A registration the relay accepts and then closes with `4401` is refused,
  not dropped (#1579). The relay does this for a control frame its strict
  schemas do not take (`relay_unknown_control_message`) and for a socket it
  no longer counts as the host's control (`relay_control_not_active`). The
  close's reason is logged when it has the shape of a relay reason code
  (`remote::protocol::close_reason`: `relay_…` codes and the relay's typed
  runtime reasons only). The first refusal is retried as a drop; from the
  second in a row the wait doubles from 30 s to 30 min (`refused_backoff`). A
  refusal after a registration that served 5 min or more starts the count
  again, and the status says `retrying` with `relayRefused`
  (`code`, `reason`, `refusals`, `retryAt`).
- The window's control requests are checked against the relay's key sets
  before they are sent (`remote::host`, `forwarded_keys`): one the relay would
  close the registration for fails on its own instead. `device-revoke` takes
  no `v`; sending one cost every registration while a revocation was queued.
- Every other failure (the API or relay unreachable, a refresh the window
  could not make) is retried with the host's backoff.
- The registration is in the status (`machine_wire::Status`): `relayState`
  (`off`, `signedOut`, `connecting` for the first registration, `retrying`
  after one was lost or refused, `registered`, `superseded`) and, while
  registered, `relay` (`relayHostId`, `directorUrl`, `cellUrl`,
  `assignmentEpoch`, `generation`, `runtimeGeneration`). An older runtime says
  neither, which reads as `off`. While `retrying` after the relay refused it,
  `relayRefused` says why and when it tries again.

**The account session.** The runtime reads the desktop Cloud Session from
`<data dir>/account/session.json` (`machine_account`). A headless machine keeps
it there with `terminalx-serve login` (PRO-353). On a desktop the window keeps
the same file while the switch is on (`account.rs`, "The runtime's copy"), so
its runtime registers with the window closed. Desktop refresh tokens rotate, and
the account service revokes the whole session when a superseded refresh token is
presented again (`desktopTokens.ts`), so:

- One process rotates at a time, under `account/session.lock` (the store's
  cross-process transaction lock), and writes the result to the file before
  releasing it.
- While a window is attached, only the window rotates. The runtime asks it with
  the private window service `account.refresh` (no secret crosses: the window
  writes the file). A rotation by the runtime would leave the window's access
  token dead.
- With no window attached, the runtime rotates the session itself.
- The window takes a rotation it finds in the file (same session family,
  `drt_<family>.…`, a later expiry) before it uses or refreshes its own tokens:
  on every account read (one `stat`), and under the lock before a refresh. So a
  window that opens after the runtime rotated never presents the superseded
  token. It signs out with the token in the file, too.
- Switching off, or signing out, removes the file if it holds this window's
  session, after taking any rotation in it. A session `terminalx-serve login`
  saved for another account stays.
- A runtime that says `signedOut` while the window is signed in gets the file
  written at once (an app updated with the switch already on).

**The window's phones.** The relay keeps one registration per host id: the
generation-fenced runtime retires the window's (`4101`), and refuses the window
while its own control socket is open. So while the runtime is `registered` the
window does not register itself, and while it is `connecting` the window waits
up to 30 s for it (`pairing/relay.rs`, `connect_once`, `RUNTIME_WAIT`). It
waits the same way while the runtime is `retrying`, unless `relayRefused`
says the runtime tries again later than that (#1579): registering between two
of the runtime's tries seconds apart only had the window's registration
retired seconds later. When the runtime is `connecting` or `retrying` for
longer, the window registers for its phones as before; the runtime's
registration retires the window's (`4101`, recorded as `runtime-took-over`,
not a failure) when it comes, and the window then uses it. The window records
each refusal the runtime reports, with its close code and reason, in
`relay-diagnostics.json`, and from the second in a row shows it in Settings →
Devices. While it is `registered`, the window uses that registration as
its own: a `RelayLive` whose control requests (`invite-create`, with
`sessionShare` for a shared session, `device-revoke`,
`device-credential-install`, `device-credential-install-status`,
`device-resume-confirm`) go to the runtime as
`runtime.machineHost.relayControl` `{ epoch, lease, frame }`. The runtime sends
each frame on its control socket and answers the relay's reply to its `reqId`
(`control-error` included) within 15 s, or `relay_offline`. The relay's
`account-pairing-changed` hint on the runtime's registration reaches the window
as `machine_host_relay_hint`, so account grants are answered as promptly. The
window registers its phone route whenever the runtime is registered, whoever
holds the direct port. When that route takes over, runtime-served phones are
disconnected and reconnect through the window. When the runtime's registration
ends or changes, the window's use of it ends and the supervisor picks again.
Window forwarding retains registration cancellation, so an expired phone
registration also ends a forwarded connection
([#1243](https://github.com/terminalx-ai/terminalx/pull/1243)).

**Capability.** The window's host binding advertises `machine-operating.v1`
only while the switch is on (PRO-349, `PairingManager::host_capabilities`).
A standalone runtime advertises `headless-phone-pairing.v1` for the account
directory (PRO-359).

**Not yet.** A pairing code still carries no `relay`, so a computer pairs with
a machine over a direct route first and gets its relay credential from
`machine.relayAccess` then. Pairing a headless server that has no open port
through the relay, and the design's "It needs no open port" intro on the
headless server tab (21.06), are a follow-up.

### As built (PRO-346): the overview, the badge and the key guards

This first shipped behind Settings → Experimental → Machines. Since PRO-360
there is no switch (`setMachineDashboardEnabled` is gone): every reader below
gets the sessions of the paired machines, and none while no machine is paired.

**The overview.** The owner decided (2026-11-16) to fit machines into the
PRO-194 board and table instead of building a new left column. Each machine
session is projected into a `DashboardSession` (`MachineDashboardSession`,
`kind: "machine"`) from the machine catalog, the same way as cloud sessions
(`cloudDashboard.ts`). A saved wait still counts. A saved "working" does not,
so only a connected machine shows a session as Working. A finished turn
counts while it is unread. With a machine paired and Machines on:

- The table has a **Where** column after Project: This Mac, the machine's
  name with its icon, or Cloud (`WHERE_COLUMN`, `tableColumns(true)`).
  `TABLE_COLUMNS` itself is unchanged.
- The toolbar has an **All machines** menu with All machines, This Mac, each
  paired machine (icon, state mark and session count) and Cloud (only when
  cloud sessions exist). This menu replaces the design's "By machine" group.
- Machine projects appear in the Project filter as "name · machine".
  Opening a machine card or row selects its key, and AppShell shows it in
  its machine's view.

Without a paired machine, or with Machines off, the overview looks the same
as before.

**Badge, notices, stepping.** In the main window, the dock badge counts
machine sessions that are waiting or finished unread, the same way it counts
cloud sessions. `createMachineAttentionTracker` raises a notice when a tab
starts waiting, or when a working tab finishes unread. It only does this on
a machine that was also connected on the previous pass. As a result, the
first connected pass (at launch or after a reconnect) counts as already
known, and nothing comes from the save alone. A notice opens the machine
session. Next session and Next needs-you step through machine sessions too.
A custom sidebar order applies only to this Mac's sessions; cloud and
machine sessions follow by recent activity.

**Key guards.** On top of the sites decision 8 listed, these now use
`isLocalKey`: reporting the shown session, the idle sweep, row statuses, PR
linking, merged-cleanup local toggles, the environment and layered settings
project lists, and the Archive shortcut. The Archive shortcut sends a machine
session's archive to the machine (`updateMachineSession`). `CloudCollab` and
`CloudNewSession` read an organization only through `cloudKeyOrgId`, which
answers null for a machine key. `src/lib/machineGuards.test.ts` lists every
remaining `"cloud:"` / `isCloudKey(` site with the reason it is safe, and
fails on any new one.

### As built (PRO-350): the machine page

Settings → Machines opens a machine's page from its card (screen 21.10):
the header (name, state, system, route, key fingerprint, paired date and
Rename), the version banner (PRO-354), **Agents**, **Resources** and
**Remove this machine**. Projects on the page are PRO-351.

**Sign-in state.** `runtime.agents` (still `agents/1`; every field is
additive) gives each installed agent `version` (its CLI's, or null),
`signIn` (`signedIn`, `signedOut` or `unknown`) and `signInCheckedAt`, read
with the same probe Settings → Agents uses on this Mac
(`harness::readiness`: `claude auth status --json`, Codex's
`account/read`). A probe that fails or cannot tell is `unknown`, never
signed out. The result also lists `missing: { id, name, installable }[]`,
the agents the runtime knows with no CLI there. With agent accounts (#980)
the login read is the agent's default account's, the one new sessions
there start on: a subscription account's own directory, else the CLI's own
login. The probes start a process each, so the runtime keeps their answers
for a minute; `{ refresh: true }` from a manager asks again now (anyone
else is answered from the kept check), and a setup step's exit drops them. An older runtime sends
none of these fields: its agents show without a state, and nothing offers
Install.

**Install and Sign in on the machine (`machine/4`).** Only a runtime that
serves its machine grants it.

| Method | Authority | Params | Result |
| --- | --- | --- | --- |
| `machine.agentSetup` | `Manage` | `{ harness, step: "install" \| "login", cols, rows }` | the terminal, as `pty.create` describes one, with `setup: { harness, step }` |
| `machine.agentSetupRunning` | `Manage` | `{ harness }` | `{ run: { ptyId, step } \| null }` |

- The command is the runtime's, made from its harness registry
  (`harness::setup::command`), exactly as a setup pane on that computer runs
  it: the provider's official installer, then the CLI's own sign-in. The
  caller names only the agent and the step.
- A sign-in run for a computer that is not the machine uses the CLI's
  sign-in for a device without a browser where the CLI has one (Codex:
  `codex login --device-auth`); Claude Code's `claude auth login` prints its
  address and takes the code pasted back. The address opens in this Mac's
  browser; the login it makes stays on the machine. Nothing of this Mac's
  (no key, token, file or environment) is sent: the terminal starts with
  the machine's own environment, in the machine user's home.
- One step at a time per agent, whichever computer or the machine's own
  window asks (`harness::setup` notes the steps started for other
  computers, and the window's own setup counts them): a second start is
  refused with `setup_busy`. Its `data` is
  the run (`{ ptyId, step }`), which the caller attaches to instead, when it
  runs in a terminal of the connection; there is none when the machine's own
  window runs the step in one of its setup panes.
- The terminal is attached, typed into, sized and killed as any other
  (`pty.attach`, `pty.write`, `pty.resize`, `pty.kill`), by a manager
  only: a sign-in shows a device code or a login address, and whoever
  completes it chooses the account the machine's CLI signs in to. It is never in
  `pty.list`, and ends with `pty.exit`; its exit code is the setup wrapper's
  (`harness::setup::exit`, `SETUP_EXIT` in `src/lib/agentSetupFlow.ts`). The
  page then reads `runtime.agents` with `refresh` and says what the probe
  says; the exit code alone is never taken as signed in.
- The new-session form for a machine names an agent that is not signed in
  there and says to sign in from the machine's page.

**Resources.** `lifecycle.resources` adds `cpu: { cores, usage }`, where
`usage` (0 to 1) is how busy every core was since the previous call on that
runtime, null on the first. A Mac machine reports its memory too (it was
Linux only). The page asks every 5 seconds while it is open.

**Rename** (`machines_rename { machineId, name }`) changes the name this
computer shows for the machine, on its card, sidebar and page; the record
keeps `namedHere: true`, so the name the machine gives itself in
`machine.describe` no longer replaces it. Nothing on the machine changes.

**Remove** is `machines_remove`, as on the card (PRO-349).

### As built (PRO-351): a machine's projects from another computer

The machine's page lists its **Projects** (screen 21.10): each with its folder
and how many sessions it has, and a menu with "Remove project". "Add a
project" opens a dialog (screen 21.11) with two tabs: "Folder on <machine>"
browses the machine's folders, and "Clone from GitHub" clones a repository
there. Before this a machine's projects were the ones someone added while
sitting at it, and `fs/1` stays inside a project, so it cannot browse for one.

`machine/6` adds six methods. Only a runtime that serves its machine grants
it, and every method is the manager's: a paired computer has operating
rights (decision 5); a session-scoped participant has none of them. (PRO-357
takes `machine/5`.)

| Method | Params | Result |
| --- | --- | --- |
| `machine.browse` | `{ path? }` | `{ home, path, parent, entries, truncated }` |
| `machine.addProject` | `{ path }` | `{ project }` |
| `machine.removeProject` | `{ projectId }` | `{ removed: true }` |
| `machine.cloneProject` | `{ repository, parent }` | `{ clone }` |
| `machine.cloneStatus` | `{ cloneId }` | `{ clone }` |
| `machine.cloneCancel` | `{ cloneId }` | `{ clone }` |

**Browse.** `path` is absolute; without it, the home directory of the user
the runtime runs as. `home` is that directory, `path` the folder listed
(canonical), and `parent` the folder above it, or null at `home`.

- Only below `home`. The path is resolved (symbolic links followed) before
  it is checked, so a link that leads out is refused with `path_forbidden`,
  and so is any path outside `home`. A path that is missing or not a folder
  is `not_found`.
- Folder names only. `entries` are the folders directly inside `path`, in
  name order (case folded), each `{ name, path, git, projectId }`. A file is
  never listed and nothing is read from one. Hidden folders (a name starting
  with `.`) and links that lead outside `home` are left out.
- `git` is `{ branch, github }` for a Git repository, else null: `branch` is
  read from `HEAD` (null when detached), `github` says whether `origin` is on
  github.com. Both are read from the repository's own files, with no `git`
  process per folder.
- `projectId` is set when the folder already is a project (archived ones
  too), so the dialog can say "Already a project".
- At most 500 entries, so a reply fits the relay's frame; `truncated` says
  some were left out.

**Add.** `path` follows the same rules as `browse`. The folder becomes a
project (`store::projects::ensure`, as `projects.add` on the control socket)
and the runtime emits `projects_changed`, so `machine.changed` brings it to
the sidebar and the new-session form of every connected computer, and the
machine's own window shows it. A folder that already is a project is
returned as it is. `projectId` comes from the path, so a folder removed and
added again gets its old id back, and this computer's pins and order with it.

**Remove.** The project leaves the machine's store and `projects_changed` is
emitted. Its folder, its worktrees and its sessions' records stay on disk;
nothing is deleted. The page asks first when the project has sessions.

**Clone.** `repository` is `owner/name` on GitHub or a repository URL, as the
local clone takes it (`project_start::parse_source`); `parent` is an absolute
folder under `home` (rules as `browse`), and the clone lands in
`<parent>/<name>`. It runs on the machine with its own git sign-in and never
prompts (`project_start::clone_repository`): it is made in a staging folder
beside its place and moved in whole, so one that fails or is canceled leaves
nothing behind. Once it is whole the folder is added as a project, as Add
does. A clone takes longer than a call may, so `machine.cloneProject` answers
at once with the clone, and the page asks `machine.cloneStatus` every second
until it ends. `clone` is `{ cloneId, repository, path, state, stage,
percent, project, error }`:

- `state` is `cloning`, `done`, `failed` or `canceled`.
- `stage` and `percent` are git's progress while cloning.
- `project` is the added project once `done`.
- `error` is `{ code, message }` when `failed`, with the local clone's codes:
  `invalid-source`, `invalid-destination`, `destination-exists`,
  `access-denied`, `network`, `timed-out`, `disk-full` or `failed`. A folder
  already holding a clone of the same repository is added as it is.
- The runtime keeps a finished clone's status for ten minutes, so a page that
  reconnects can still read how it ended; an unknown `cloneId` is
  `not_found`.

**Errors** use the protocol's codes: `invalid_params` for a missing or
relative path, `path_forbidden`, `not_found`, and `invalid_project` when the
store refuses the folder (a local mirror of a cloud workspace).

**The page.** Projects show once the machine is connected; without
`machine/6` they are listed with no Add or Remove, and the page names the
machine and says to update it. A project's session count is the sessions of
that machine with its `projectId`. Like the rest of Machines, it stays behind
Settings → Experimental → Machines until PRO-360.

### Versions and updates (PRO-354)

The laptop and the machine update on their own, so two versions meet all the
time. The rule: **a feature is shown only when the machine's runtime grants
the namespace it needs**; a newer machine keeps serving the older namespaces;
and either side may be the one to update.

**Features.** `src/lib/machineFeatures.ts` lists every feature this desktop
uses on a machine, the namespace it needs, and the words for what is lost:
`{ id, label, capability, action }`, e.g. `{ id: "ports", label: "Port
forwarding", capability: "ports/1", action: "forward ports" }`. A feature
whose namespace was not granted is hidden where it would be, and that place
shows one line naming the machine: "ci-box runs TerminalX 0.2.27. Update it to
forward ports from here." (21.09). The machine's view shows the same line once
for everything it hides, under its "Runs on" strip, with Update beside it, so a
hidden control (adding agent tabs, interrupting, issue pipelines) is never gone
without a word. The machine's card in Settings → Machines,
its header chip and its page say **Needs update** whenever any listed feature
is missing; its page lists what is hidden (21.10). The machine stays
connected and usable meanwhile.

**Which side updates.** `rpc.hello` refused with `update_required` now carries
`data: { runtimeVersion, offered }` (the runtime's version and the namespaces
it serves). The connection state is `{ state: "needsUpdate", version, side }`:

- `side: "machine"`: the machine is older (its version is below this
  desktop's, or unknown). "Update" on the card, chip popover and page updates
  the machine (below).
- `side: "thisMac"`: the machine is newer. Nothing on the machine changes;
  the desktop offers its own update (`checkForUpdate` / `installUpdate` in
  `src/lib/updates.ts`).

An older runtime sends no `data`; the desktop then uses the version the
record last saw, else assumes the machine is older. A machine newer than the
desktop that still grants `machine/1` is connected as usual, nothing is
hidden by it, and its page says "TerminalX 0.2.35 there, 0.2.33 here" with
"Update this Mac".

**`machine/3`** adds to `machine/2`:

| Method | Authority | Params | Result |
| --- | --- | --- | --- |
| `machine.updateStatus` | `Participate` | `{ refresh?: boolean }` (`refresh` checks for a newer release now, else at most every 10 minutes) | `MachineUpdateStatus` |
| `machine.update` | `Manage` | `{ version, stop?: string[], confirmedOthers?: string[] }` | `MachineUpdateStatus` with the update under way |

and the notification `machine.updateChanged` `{ status: MachineUpdateStatus }`
to `machine/3` connections whenever any field changes. The shapes are in
`src/types/machines.ts`:

- `method`: `installer` (a runtime the installer put in
  `~/.terminalx/versions`, which `current` points at), `app` (the desktop app
  started the runtime, `hasWindow`), or `unmanaged` (anything else: built by
  hand, a package manager). An `unmanaged` machine refuses `machine.update`
  with `update_unavailable`; the page says to update it the way it was
  installed.
- `current`, and `available: { version } | null`: the newest signed runtime
  release (`installer`), or the update the app's own updater offers (`app`,
  reported by the window; null until it has checked).
- `blockers: { id, kind, title }[]`: what a handover cannot carry, from
  `runtime.handover.plan` (`unadoptable`). Shown before the person confirms;
  `machine.update` refuses with `update_confirm` (data: the status) unless
  `stop` names every one of them, and then stops only those, as the local
  handover does.
- `otherComputers: { id, label }[]`: the other paired computers connected
  right now (not the caller). `machine.update` refuses with `update_confirm`
  unless `confirmedOthers` names every computer in this list by id: a
  computer that connects after the person was asked is not named, so the
  update is refused again and the person sees it first. An update never
  replaces a runtime another computer is attached to without saying so first.
- `kept: string[]`: the versions on disk, newest first.
- `progress`: `idle`; `downloading`, `verifying`, `trial`, `handingOver`,
  `cleaningUp` (each with `version`, `since`); `appUpdating` (`version`,
  `since`, `step`); `updated` (`from`, `to`, `at`); `failed` (`version`, `at`,
  `message`, `running`, `rolledBack`). `machine.update` while one runs is
  `update_busy`.

**A headless (installer) update**, run by the runtime itself in a detached
helper (`terminalx-serve update --apply <version> --status <file>`), since the
runtime execs in place during the handover and its own threads stop there:

1. Download the release, check its SSH signature and hashes, and that the
   binary reports its version, exactly as `terminalx-serve update` does. It goes
   in `versions/<version>`; `current` is not moved yet.
2. **Trial**: start the new binary on a scratch data directory and wait for it
   to answer as ready (60 s). One that does not is removed; nothing changed.
3. **Hand over** the running runtime to it in place (`serve_cli::handover`,
   #765): the pid, agents, terminals and their scrollback carry over.
   Work named in `blockers` and not agreed to stop refuses here, nothing stopped.
4. **Ready**: the runtime now answering must report the new version within
   90 s. Then `current` moves to the new version.
5. **Roll back** otherwise: `current` stays on the old version; a runtime that
   is not answering is restarted by its service (`systemctl --user restart`,
   `launchctl kickstart -k`), which runs the old version. The status says
   `failed`, `running` the old version, and `rolledBack: true`; when the
   process had already exec'd, it says its agents and terminals restarted.
6. **Clean up**: keep `current` and the two versions before it in
   `versions/`, and in the data directory only the installed runtimes of
   those; remove the rest. No more than three versions stay on disk.

The helper writes the status to `<data>/run/machine-update.json` (owner
only); the runtime, the old one and the one that took over, reads it and
sends `machine.updateChanged`.

**A desktop-app machine** (`method: "app"`): `machine.update` asks the
machine's own window to run its updater. The runtime emits
`machine_update_requested { version }` on its event stream; the desktop
re-emits it to its web views as the Tauri event
`machines_app_update_requested`; the window runs `checkForUpdate` and
`installUpdate` (the same as Settings → About) and reports each step with the
Tauri command `machines_app_update_report { phase, step?, message? }`, which
the desktop forwards to its runtime's control call
`runtime.machineUpdate.report`. After the app restarts it hands its runtime
over as every app update does, and the machine reports the new version. A
window that is not running cannot update; `machine.update` then answers
`update_unavailable`.

**On the operating computer** the supervisor watches `machine.updateChanged`
on its link: from `handingOver` until the machine answers again (at most
3 minutes), a lost link is the state `{ state: "updating", version, since }`
("Updating · Back in under a minute", 21.09), not `reconnecting`.

**As built, the runtime (PRO-354).** `src-tauri/src/remote/machine_update.rs`
serves the two methods; `src-tauri/src/serve_cli/update.rs` is the helper.

- `machine/3` is in `protocol::served(true)` beside `machine/1` and
  `machine/2`; a client that does not ask for it is served as before.
  `update_required` from `rpc.hello` carries `data: { runtimeVersion, offered }`
  for every refusal, including a protocol mismatch.
- `machine.update` is not idempotent (no `clientRequestId`): it is decided
  against the moment's blockers, computers and progress. Besides the
  refusals above, an `installer` machine answers `update_unavailable` for a
  `version` other than `available.version` (checking first when it has not
  yet), and an `app` machine when no window is attached. Every refusal's
  `data` is the status.
- A blocker's `id` is `tab:<sessionId>/<tabId>` for an agent, `pane:<pane>`
  for a terminal, else `<kind>:<title>`; `title` is the work's own title,
  else `<harness> in tab <tabId>`. The helper names the plan's work the same
  way, so `stop` reaches `runtime.handover` as the work it names.
- `otherComputers` comes from the machine host: computers with a live
  connection, less the caller (its computer id on the direct route, its relay
  device id on the relay). The desktop app's own window is not a computer.
- The record `<data>/run/machine-update.json` (0600) is `{ progress, from,
  helperPid, appAvailable, appCheckedAt }`. A runtime reading it settles what
  is over: a helper phase whose helper is gone (or never started within a
  minute) becomes `updated` when this runtime runs that version, else
  `failed`; `appUpdating` becomes `updated` once the runtime runs the
  requested version, and `failed` after 30 minutes without it. Each phase's
  `since` is when that phase began. The runtime reads the record every 2 s
  and sends `machine.updateChanged` to each `machine/3` connection with the
  status as that connection sees it; a runtime that just took over sends
  only later changes, so a computer that reconnects asks once.
- `machines_app_update_report` takes an optional `available` (the version
  the app's updater offers, `null` when none), which becomes the `app`
  machine's `available` and `checkedAt`, and, while the app updates, the
  `appUpdating` version: the app installs what its updater found, which may
  not be the version the desktop asked for. An app update ends as `updated`
  once the machine runs any version other than the one it updated from.
  `upToDate` sets `progress` back to `idle`; `failed` records `failed` with `rolledBack: false`. The desktop
  forwards each report as `runtime.machineUpdate.report` with its window's
  attachment (`epoch`, `lease`), which the runtime checks.
- `terminalx-serve update` run by a person takes the same steps and writes
  the same record, and refuses while another update is under way.

**Compatibility matrix.** CI runs this build against the previous two
released runtimes (the two newest `v*` releases before this version): this
build's machine client against each, and each release's own `want` list
against this build's runtime. See `.github/workflows/ci.yml`, job
`machine-compat`.

### As built (PRO-352): connection states the person sees

Screen 21.09, behind Settings → Experimental → Machines like the rest.

- **Chip and popover.** The header chip (`MachineChip`,
  `src/components/machines/connectionStatus.tsx`) keeps its label and hover
  text per state and now opens a popover: Path (route and round trip, or the
  state's hover text while away), Encryption ("End to end" and the machine's
  key label, `keyLabel(machineId)`), TerminalX (version and system), Running
  (sessions working or waiting, and `lifecycle.resources` free memory) while
  connected, else Last seen; then Machine settings (the machine's view) and
  Disconnect, or Try again while it is away. The rows are
  `machineDetailRows`; a value not known yet is left out.
- **Disconnect** is this window's: `disconnectMachine` closes its
  connection (the native owner stops when no window holds it) and keeps the
  machine detached across list reads until Try again (`reconnectMachine`).
  The state reads Not connected, and the session says so with Try again. No
  protocol change: it is `cloud_remote_detach`.
- **Sidebar.** An offline machine's rows stay dimmed, and under them
  `MachineAwayCard` says it isn't reachable, when it was last seen, that its
  sessions keep running and the list catches up when it reconnects, with Try
  again and Machine settings. Access removed says the machine no longer
  allows this Mac, with Pair again (the Add machine dialog) and Machine
  settings.
- **Session.** Reconnecting names the routes being tried, from the state's
  `trying` ("Trying Relay."). Offline and access removed are the inline
  messages (`MachineMessage`, `src/components/machines/MachineMessage.tsx`),
  with Try again or Pair again. The composer takes the backend's
  `sendHeldReason`: the field stays editable, its placeholder says "Can't
  send until Mac mini is back", Send and Return do nothing; nothing is queued
  on this computer, and the prompt goes when the person sends it after the
  machine is back.
- **Inline messages**: unreachable, needs update (`MachineFeatureNotice`, as
  before), agent not signed in (the tab), project missing (the new-session
  form, when the project it was on here has no namesake on the machine:
  `MachineDraft.missingProject`), access removed, and the local-only line.
- **Toasts** (`src/lib/machineToasts.ts`, `MachineToasts`): "Connected to
  Mac mini" with the route and running sessions when a machine comes back
  from reconnecting, offline, updating, needs update or access removed, or
  after Try again (`machineCameBack`), never for the first link of a launch;
  it goes after 6 s or when the link drops. "Mac mini needs you" with Open is
  the machine session notice (`raiseMachineAttention`), with what the session
  waits for. "Couldn't pair with dev-server" with Try again (when the same
  code may be tried) is raised when a pairing fails while this window is not
  focused, since the dialog says it inline otherwise; the next attempt or
  closing the dialog takes it back.
- **On return** nothing new was needed: the reconnect resubscribes from the
  cursors and `applyLiveTabs` marks a tab that finished meanwhile unread, so
  the overview, sidebar and badge show it finished and unread.

## Trust model

What each party can see and do, then the threats PRO-357 reviewed: each has a
mitigation and a test, or is an accepted risk. The boundary tests run in CI
with the rest of the Rust tests (`src-tauri/src/machine_host/security_tests.rs`,
named `security_tests::…` below).

| Party | Can see | Can do | Cannot |
| --- | --- | --- | --- |
| The relay | The `machineId` (relay host id), IP addresses, timing and sizes, and the E2EE hello and ready frames (public keys, nonces) | Drop, delay or cut connections | Read or change any RPC, device token, transcript, terminal or file: frames are sealed and counted, so a change, replay or reorder closes the connection (`docs/MOBILE.md`, "E2EE framing v2") |
| The account server | The machine's name, public key, capabilities (including whether operating is on), online or last seen, and which installation asked to pair with which machine and when | Withhold or forge directory entries and grants | Read a pairing offer: it is sealed with HPKE to the requester's key. Complete a computer's pairing without "Allow" on the machine and a matching fingerprint on both screens (decision 5). See projects, paths, session titles or prompts: none are in any request (PRO-344) |
| A paired computer | Everything the runtime's user can read on the machine (decision 5) | Every method marked served or needs a project; through a shell, anything that user can do | Use a method that does not exist: pairing others, the operating switch, the browser, computer use, dictation, Local VM. Use its credential after revocation: its connections are closed and its token hash is removed. Revocation does not undo what it did through a shell before then, such as a registry entry it wrote, an SSH key or a launch agent (decision 5) |
| A phone | What its scope allows, as today | Its phone actions | Get workspace RPC: the runtime serves by the device's scope (decision 4) |

The pairing code is a secret until it is used. Whoever has it can ask to pair,
which is why every computer pairing waits for "Allow" and a fingerprint the
person compares on both screens.

### Threats

| Threat | Mitigation | Test |
| --- | --- | --- |
| **A stolen laptop** (the operating computer) | Its device token and client key are in its Keychain, never in a file. The token is bound to the client key: a copied token alone is refused (`4401`). The token rotates on every connection (`machine.rotateCredential`, `machine/5`). The new token replaces the old one when a connection is made with it, so a copy taken earlier, from a backup say, stops working once the owner's computer has connected twice more (once to be given a new token, once to use it), and not while one of its links stays up. A copy without the client key does nothing. One unused for 90 days, and not connected, expires. On the machine the person presses Disconnect or Revoke under "Computers that can operate this Mac", and the activity log shows what it did meanwhile. | `security_tests::a_credential_rotates_on_each_connection`, `…::a_credential_unused_for_ninety_days_expires`, `…::disconnect_closes_the_connection_and_holds_the_computer_off_until_it_is_let_back`, `pairing_tests::revoking_closes_the_connection_and_refuses_the_credential` |
| **A stolen laptop** (the machine) | The registry keeps token hashes only, mode 0600; the activity log has no prompts, commands, paths or file contents. Beyond that the machine is the user's own account and disk (FileVault), as for every local session. | `registry` tests (hash only), `security_tests::the_activity_log_records_what_a_computer_did_and_nothing_secret`, `activity` tests |
| **A stolen pairing code** | It works once and for five minutes. Using it only asks: the machine waits for "Allow", and the person compares a fingerprint that binds both keys and the code's token. Five wrong attempts in a minute pause pairing. | `security_tests::a_code_alone_adds_no_machine_without_allow_on_the_machine`, `pairing_tests::a_computer_pairs_by_code_once_the_machine_allows_it`, `…::decline_no_answer_and_closing_leave_no_record`, `…::five_wrong_attempts_pause_pairing_but_not_paired_computers` |
| **A hostile relay** | Everything after the E2EE hello is sealed and counted (E2EE framing v2); the device token travels inside it. A changed, replayed or reordered frame closes the connection. The relay can only drop or delay. | `relay_e2ee::tests::e2ee_frame_nonce_is_fixed_and_replays_fail`, `…::transcript_and_key_schedule_match_the_phone_fixture` |
| **A hostile account server** | It cannot read an offer (HPKE-sealed to the requester's key) and cannot pair a computer: an account grant still waits for "Allow" and the fingerprint (decision 5). A forged directory entry leads to a machine whose fingerprint does not match. Revoking a computer revokes its grant, best effort. | `pairing_tests::a_computer_paired_through_a_grant_still_waits_for_allow_and_its_revocation_removes_it` |
| **A hostile agent on the machine** | It has a shell (decision 5), so the boundary is letting someone else in. Making a code, Allow and Let back need a person's witness (`serve_cli::consent`): the kernel says which process asks, and the runtime refuses itself, its descendants and its terminals. The window's attachment is no boundary here: any process of the user can attach. Revoke and Disconnect are not guarded, since they only take access away (Accepted risks). | `security_tests::an_agent_on_the_machine_cannot_approve_pair_or_let_a_computer_back`, `serve_cli::consent` tests |
| **A hostile agent on the operating computer** | It drives what the person drives: the machine's projects with full rights (decision 5). It cannot add a machine: a code waits for "Allow" on the machine. No `terminalx` command adds or removes one; only the app's own windows do. No method pairs others, changes the operate switch, or reaches the browser, computer use, dictation, Local VM or runs; `fs.*` stays inside the projects. | `security_tests::a_code_alone_adds_no_machine_without_allow_on_the_machine`, `…::no_terminalx_command_adds_or_removes_a_machine`, `…::an_operating_computer_cannot_change_the_switch_or_reach_this_machines_own_controls`, `…::an_operating_computer_reads_only_inside_the_machines_projects`, `pairing_tests::a_paired_computer_has_no_pairing_browser_or_computer_methods` |
| **A listener on the public internet** (PRO-487) | A new install opens no port ("Relay only"); every other choice binds only the addresses of its kind (Tailscale; private and Tailscale), and "All interfaces" is never a default. Whatever is bound, a connection whose source address is public is closed before a byte is read, unless the person allowed public callers (`machines.allowPublic`); the first refusal each hour is logged. Withdrawing that closes the connections from public addresses that are already open, on the runtime's listener and the window's (PRO-495). An install from before the setting keeps its bind and refuses public callers until the person answers once. Codes and offers advertise bound addresses only. The phone listener follows the same setting. | `security_tests::a_caller_from_a_public_address_is_refused_under_every_listen_choice_unless_allowed`, `…::the_listen_choice_decides_what_is_bound_and_relay_only_opens_no_port`, `…::a_machine_from_before_the_setting_asks_once_about_its_public_address`, `listen::tests`, `pairing::direct::tests::the_listen_setting_decides_which_addresses_are_bound`, `security_tests::withdrawing_public_callers_closes_the_ones_already_in_and_late_handshakes_are_refused`, `…::the_window_and_the_runtime_close_the_same_callers_when_public_ones_are_withdrawn`, `pairing::approval_tests::turning_public_callers_off_closes_the_open_ones_on_the_windows_listener` |
| **A stolen pairing code used through the relay** (PRO-487) | The code's relay invite is for one relay device and works once; only that device, with the code's token, may ask, and it still waits for "Allow" and the fingerprint. Another relay device with the token is refused; an unused invite is revoked when its code ends. | `security_tests::a_computer_pairs_through_the_relay_only_with_the_codes_invite_and_allow`, `pairing::tests::a_code_with_a_relay_invite_pairs_only_its_relay_device_and_retires_an_unused_one`, serve `machine_routes::a_relay_only_machine_opens_no_port_and_is_paired_by_code_through_the_relay` |
| **A replayed message** | E2EE frames carry a counter: a replay closes the connection. A code works once. A rotated token replaces the old one once a connection is made with it, and a token whose answer was lost is never promoted. A consent witness answers its own nonce once. | `relay_e2ee::tests::e2ee_frame_nonce_is_fixed_and_replays_fail`, `security_tests::a_credential_rotates_on_each_connection` |

Data privacy mode turns off both sides: the runtime treats the operate switch as
off (no listener, no relay registration, no code), and this computer makes no
machine connection (`data_privacy::require_network`, the IPC gate in
`src/lib/dataPrivacy.ts`). Settings → Machines says so. Test:
`security_tests::data_privacy_mode_opens_no_listener_and_makes_no_machine_connection`,
which runs in a child process because data privacy is one switch per process.

### Accepted risks

- **The runtime's user decides what a paired computer is** (PRO-487). Every
  paired computer and every agent acts as the user the runtime runs as: root
  if it runs as root, root in effect if that user has passwordless `sudo` or
  is in the `docker` group. TerminalX does not sandbox them and the installer
  never creates a user; it says which user it is and whether it has
  passwordless `sudo` (`service status`, the machine's page), and
  `docs/HEADLESS-SERVER.md` ("Which user to run as") describes the set-ups.
- **The listen setting is a file the runtime's user can change**
  (`settings.json`, `machines.listen` and `machines.allowPublic`). An agent
  on the machine has a shell as that user, so it can widen the bind, as it
  could start a listener of its own. The setting protects against exposure
  by default and by mistake, not against a hostile process of the same user.
  A paired computer that manages the machine may change it too
  (`machine.setListen`): it already has a shell there.
- **A paired computer has a shell** (decision 5, confirmed). Revoking ends its
  credential, not what it already did; the UI says only that.
- **A shell on the operating computer can remove a machine** by editing
  `machines.json` or the Keychain. That loses this computer's own access and
  gains nothing, so no integrity key guards it.
- **Consent identifies the window on supported Mac desktops**
  (`serve_cli::consent`, PRO-369). Desktop runtimes without a pinned
  consent key refuse consent-guarded pairing actions. The key is pinned only
  in the environment of a runtime the window launches, and a handover keeps
  that environment, so a runtime launched without this window's key (by a
  build before the pin, while the Keychain write failed, by a build with
  another bundle identifier, or before its Keychain item was removed) cannot
  verify the window until it is relaunched. The window does that itself when
  a guarded command it sends fails this way (PRO-486,
  `local_runtime::window_consent`): once Keychain gives it the key (a
  Keychain that refuses stops nothing and keeps its own message), and if
  nothing the runtime runs would be cut short and no computer or phone is
  connected to it or waiting for Allow, it stops the runtime, launches a
  fresh one pinned to its key and sends the command again (Allow excepted:
  the computer must ask again). Otherwise nothing is stopped and Settings →
  Machines shows Restart runtime beside the error, naming what restarting
  stops; it stops only a runtime offered that way. An account pairing grant,
  which no one at the window asked for, never restarts the runtime: it only
  makes that offer, which reaches an open Settings → Machines at once and
  one opened later. The offer lists what restarting would stop when it is
  shown, and Restart runtime sends back the text the window displayed and
  reads the list again, asking once more when it would now stop more than
  that text names (counted by name, PRO-489). A status it cannot read counts
  as something connected. An offer is kept for the runtime it names: once
  another runtime is attached in its place (an update handed it over) the
  offer goes, and Settings → Machines no longer shows it. An update that
  hands the runtime over during the restart is relaunched the same way,
  once; when it cannot be, the message stays in place of the offer. Showing
  an offer change asks the runtime nothing. The key provisioned before the
  stop is the one every launch pins until that relaunch ends, then it is
  forgotten; any other launch that cannot read Keychain still starts an
  unpinned runtime, which the next guarded command repairs. That relaunch is
  the Mac's (`window_consent`): on Windows each launch pins the window's
  DPAPI-sealed key as it reads it, and no relaunch provisions or forgets one. Nothing pins or replaces a key over IPC. A separately launched headless runtime still
  permits an unrelated interactive terminal. A same-user process that opens
  its own pseudo-terminal can pass the terminal check on supported Mac
  desktops and headless runtimes.
- **A computer on a runtime before PRO-357** does not rotate its token (it
  does not ask for `machine/5`). Its token still expires after 90 days unused.
- **Whoever holds a computer's client key and token is that computer.** With
  both copied, someone can connect before the owner's computer uses its
  rotated token; connecting with the old token drops the rotated one, so the
  owner's computer is refused ("Access removed") while the copy keeps working.
  The machine cannot tell the two apart. The lockout is the sign: the person
  revokes the computer on the machine, checks the activity log, and pairs again.
- **An agent on the machine can Revoke or Disconnect a computer.** It attaches
  as any process of the user can. That takes access away and gives it none.
- **The runtime's copy of the account session is a file** (PRO-368). On a
  desktop the window keeps the desktop Cloud Session in the Keychain; with the
  switch on it also writes it to `<data dir>/account/session.json`, mode 0600
  in a 0700 folder, as a headless machine keeps its own. The runtime is a
  separate executable, and a Keychain item it reads with the window closed
  would need someone to answer a prompt after a reboot; a file the window and
  the runtime share under one lock is also what keeps a rotating refresh
  token from being presented twice. Any process of the same user can read it,
  as it can use the user's other credentials on disk; that includes the
  agents TerminalX starts, which run as the user and could mint access
  tokens for the account from it. The Keychain item is guarded by its access
  list, which makes macOS ask before another program reads it; the file has
  no such guard. That is the cost of a runtime that serves with the window
  closed: it cannot answer a Keychain prompt, and a second Keychain item it
  could read would need one after every reboot. The file exists only while
  the switch is on and someone is signed in, and signing out ends the
  session it holds on the server, so a copy taken earlier stops working.
- **An expired computer's account grant** ends when the operating computer
  removes the machine, as it is asked to on "Access removed"; the machine ends
  its connections and relay credential itself.
- **Agents on the operating computer can operate its paired machines** through
  the `terminalx` CLI (PRO-356), with the rights pairing gave the computer.
  That is the ticket's purpose (a lead session on one computer driving
  sessions on another). The control is pairing (owner decision, 2026-11-17,
  PRO-360, replacing the Experimental → Machines switch): an agent reaches only
  machines the person added in the app, each after Allow on that machine, and
  with none paired there is nothing to reach. Settings → Machines says agents
  can use them ("Your machines" description, and the guide). Data privacy mode
  refuses every `machine.*` command in native code before it reaches the
  window (`machines_disabled`). Unlike cloud control there is no second
  switch: nothing is billed, and the machines are the person's own. A run's worker may not pair a machine or start a session
  on one.

### As built (PRO-487): where a machine listens, and what it runs as

- **The setting.** `machines.listen` in `settings.json`: `relay` (no
  listener), `tailscale` (100.64.0.0/10 addresses), `lan` (RFC 1918 and
  Tailscale addresses) or `all` (the wildcard). Absent means nobody chose:
  an install that listened before the setting keeps every interface. A word
  this build does not know reads as `relay`, so a typo never opens a port.
  `machines.allowPublic` (absent: unanswered, refused) says whether callers
  from public addresses are answered. `src-tauri/src/listen.rs` holds the
  choices, the address classes, the plan read from settings and the
  admission check; both listeners use it.
- **Binding.** The runtime's listener (`machine_host/direct.rs`) and the
  window's phone listener (`pairing/direct.rs`) bind one socket per chosen
  address instead of the wildcard, and follow the setting and the
  computer's interfaces while running: a reconcile pass closes listeners
  that no longer belong (and the connections that came in on them) and
  opens new ones, with no restart. `Relay only` binds nothing. Loopback is
  bound only under `all`.
- **Public callers.** `MachineHost::answers(peer)` runs in the accept loop
  before the handshake; the window's listener does the same. A refusal is
  logged once an hour and its time kept in
  `<data dir>/machine-host/public-callers.json`, which is how the one-time
  question survives a restart.
- **The window follows the setting whoever holds the port.** While the
  runtime takes the phones' port, the window still reads the setting every
  few seconds, so its phone offers name only what is chosen now. A relay
  share needs no direct listener; only a local-network-only share is refused
  when the setting binds nothing.
- **The first choice.** Turning operating on with no choice made writes
  `relay` when signed in and nothing is paired, `lan` when signed out (the
  relay cannot reach a signed-out Mac), and nothing while a phone or computer
  is paired. Never `all`.
- **A plan change applies to connections already in.** Each direct
  connection keeps its listener and its peer address; withdrawing public
  callers closes the ones from public addresses at once, and a handshake
  that finishes after its listener closed, or from an address the plan no
  longer answers, is not let in.
  The window's own phone listener does the same (PRO-495,
  `pairing::direct::Callers`): it keeps every socket it accepted with its
  peer address, and the settings check that reads `allowPublic` off closes
  the ones from public addresses within that check (every 5 seconds, or at
  once when the setting is changed in this window), with the listeners left
  where they are. A socket still in its handshake, waiting for approval or
  serving a shared session is closed like a logged-in phone.
- **The one-time question** (decision 3). `ListenStatus.askPublic` is true
  while nobody chose and either the machine has a public address or a public
  caller was refused. `service status`, Settings → Machines and the
  machine's page show it with its two answers: keep (`all` and
  `allowPublic`) or close (`relay`, `tailscale` or `lan`; the page's button
  closes to `lan`). Any choice ends it.
- **Advertised endpoints** come from the bound sockets
  (`direct_endpoints::bound_endpoints`): a code, `machine.describe`, a
  phone's QR code and the account directory list only addresses that
  answer. With nothing bound a code carries no direct endpoint.
- **Pairing by code through the relay.** On a machine registered with the
  relay, `createCode` asks the relay for a single-use invite (`invite-create`,
  as `machine.relayAccess` does) and puts it in the code's `relay`, with the
  relay device id it is for. The operating computer, which must be signed
  in, tries the code's direct endpoints first and then connects with the
  invite (`machine_client::pair_through_relay`): E2EE pinned to the code's
  key, the code's token, the same wait for "Allow" and fingerprint, then a
  resume credential installed on that connection
  (`pairing.provisionRelay`). On the machine,
  `MachineRoutes::pair_computer` accepts only the invite's relay device and
  records it with the computer, so later connections are admitted as for
  any computer with relay access. An invite whose code ends unused is
  revoked (`device-revoke`); its device stays queued, retried each pass and
  never taken for a phone, until the relay answers `device-revoked`. With neither a listener nor a registration, `createCode` refuses
  (`not_reachable`) and says to run `terminalx-serve login` or choose a
  listener. A signed-out operating computer gets `sign-in-required`.
- **Commands.** `terminalx-serve pair` asks where to listen the first time
  hosting is turned on (default `relay`); `terminalx-serve hosting
  [--listen …] [--allow-public]` shows or changes it;
  `terminalx-serve service status` prints the choice, the bound addresses,
  the open question if any, the user, and its passwordless `sudo`. On a Mac
  the same setting is in Settings → Machines under the operate switch
  (`machines_set_listen`); turning the switch on for the first time writes
  `relay` unless a phone listener is already serving. From another
  computer: `machine.setListen` (`machine/9`).
- **What it runs as.** `listen::runs_as` reads the effective user and, for a
  hosting runtime that is not root, whether `sudo -n true` succeeds (once,
  5 s limit). `Status.runsAs` and `machine.describe` carry
  `{ user, root, passwordlessSudo }`. The runtime logs a warning at start
  when root; the installer and `service install` warn that every paired
  computer and every agent on the server will act as root, and carry on.
- **UI.** No Superdesign screen draws these, so "Listening and privileges"
  on the machine page and the block under the operate switch are built from
  the Machines board's parts (`MachineHosting.tsx`).

### As built (PRO-357)

- **Activity log.** `<data dir>/machine-host/activity.jsonl`, mode 0600, the
  last 200 entries (cut back from 400), read by a restarted runtime. Entries:
  paired, connected (with its route), disconnected, session created and
  terminal opened (with the project's name), project added or removed while a
  computer is connected (not put down to it: no method adds one), update (the
  version), revoked, expired, held (Disconnect) and let back. Each has the
  computer's name and the time; never a prompt, a command, a path or a file.
  `runtime.machineHost.activity` and `machines_activity` read it; Settings →
  Machines lists it under "Computers that can operate this Mac".
- **Rotation.** `machine.rotateCredential` (`machine/5`, Manage) answers a new
  device token; the host keeps its hash beside the current one. Admission with
  the new one promotes it and drops the old; admission with the old one drops
  the new. The client asks on every connection and keeps the new token in the
  Keychain before anything else.
- **Expiry.** A credential unused for 90 days (from the later of its approval
  and its last connection) is removed at admission, refused `code-inactive`
  ("Access removed"), and swept whenever the host reads its settings. A
  computer connected now never expires, however long its link has been up.
  Expiry ends its connections and relay credential as Revoke does.
- **Revoke with no runtime.** `terminalx-serve devices revoke` writes the
  "revoked" entry itself when it removes the record directly.
- **Disconnect.** `runtime.machineHost.disconnect` closes the computer's
  connections and refuses it with `pairing_refused` `disconnected` until
  `runtime.machineHost.letBack`, which needs a person like Allow. The operating
  computer shows Disconnected and does not retry until "Try again".

### As built (PRO-359): phones on a Mac with the window closed, and on a headless server

Why the protocol changed: a phone could not reach a Mac whose window was
closed, or a server with no window at all. The runtime that already holds the
direct port now answers phones too, with nothing new on the phone's wire.

- **Who serves a phone.** The direct listener (`machine_host/direct.rs`) and
  runtime relay pass a phone to the window while one has registered `phoneRoute`.
  Without one, the runtime serves it (`machine_host/phones.rs`). It uses the same
  E2EE v2 handshake with the machine's one host key, the same `devices.json`
  records and the same RPC. The RPC moved from the desktop-only `pairing` module
  into the shared `phone` module, so both builds compile it. When a window
  registers a phone route, the runtime closes the phones it serves; they
  reconnect and reach the window. An approved phone keeps the Mac reachable
  when its window closes, even with computer operation off. A first pairing
  can finish on the window's routes before the runtime takes over. The window
  hands over its host key and, if signed in, saves the session for Relay.
- **Writes.** A phone served by the runtime writes through the runtime's own
  owner operations (`local_runtime::mobile::execute`) under a lease the runtime
  holds for its phones (`Lifetime::hold`), as a window holds one for its own. It
  is taken when the first phone connects and released when hosting stops or a
  window takes phones. While it is held the runtime is not idle.
- **`devices.json` is shared.** The window and the runtime both read and write
  it. Nothing is cached: every change reads, changes and writes the file under
  `devices.lock` (`phone/registry.rs`), so neither process undoes the other's
  change. A phone revoked by the window or removed at sign-out is refused at its
  next request. Each tick, the runtime also closes such phones and ends their
  grants, and it fences by the account mirror's binding generation, as the
  window does. It reads that generation once a tick, not on every message, and
  judges no phone while `account.json` cannot be read. With the window detached,
  the runtime checks account-pairing revocations directly with the account
  service, including when Relay is unavailable. It removes affected devices
  and ends their grants before acknowledging revocation. Account-paired phones
  need a recent successful check. Explicit pairings can still use the LAN when
  the account service is unavailable.
- **Notices stay in their process.** The runtime's phone host publishes its
  `mobile_notification` events on a sink that keeps them in the runtime
  (`phone/sink.rs`). Every runtime event also streams to the window, so the
  window's phones would otherwise get each notice twice.
- **`host.describe`** answers `{ name, hasWindow, platform }`. `hasWindow` is
  false on a runtime no desktop app launched (`TERMINALX_LOCAL_DESKTOP`), and
  the phone shows such a machine with the server icon. Older phones read only
  `name`; older computers send only `name`, and the phone keeps what it had.
- **Relay discovery and provisioning.** `pairing.getEndpoints` returns
  `{ v: 1, directEndpoints, relay }` to an authenticated phone. While the
  runtime has a registered relay, `relay` describes its current director, cell,
  assignment, host id and E2EE framing; otherwise it is `null`. Registration
  depends on hosting being enabled, a ready host key, a signed-in account and
  a working relay link, with the debug-build restriction and failure states
  described under PRO-368 above. Direct endpoints remain available when the
  relay is absent; a phone can retain an existing relay bundle for later.
  `pairing.provisionRelay` installs a phone's resume-token hash through the
  current registration, authorized by its authenticated direct connection or
  an invite-based relay connection. It is unavailable on other relay
  connections or without active relay control. Control requests fail if the
  registration changes during the request or the relay refuses or fails to
  answer. Endpoint requests can also ask for install status or, on a resume
  connection, resume confirmation (`machine_host/phones.rs`).
- **`terminalx-serve pair --phone`** prints a version-2 `terminalx://pair`
  link. With a live Relay registration it includes a one-time invite, and
  the phone installs a resume credential after approval. With a direct
  listener it includes nearby endpoints, even if Relay could not issue an
  invite. It prints the link as a
  half-block QR and as text, then asks "Allow? [y/N]" with the fingerprint the
  phone shows. If hosting is off it asks to turn it on first, since phones use
  the same listener. While a TerminalX window is open (`Status.phones.windowOpen`)
  it sends the person to Settings → Devices before asking anything, and the
  runtime refuses the code (`window_takes_phones`) while a window serves phones.
- **Runtime IPC** (`machine_wire.rs`): `runtime.machineHost.phoneCode`,
  `phoneApprove` and `phoneDecline`. The first two are consent-guarded like
  `createCode`/`approve`. `phoneRevoke` is refused while a window serves phones,
  since the window holds their connections and grants. `Status.phones`
  (`connected`, `code`, `pending`) is `#[serde(default)]`, so a window reading
  an older runtime sees none.
- **`terminalx-serve devices`** lists paired phones after the computers, and
  `devices revoke <id>` removes either.
- **Discovery.** A standalone runtime with hosting enabled and a signed-in
  account creates its directory entry once the relay registers its host key.
  It sends a live heartbeat every 30 seconds while that registration is
  active. The Machines screen uses `headless-phone-pairing.v1` to show a
  server icon and open the QR scanner from that row. Scan the server's
  `terminalx-serve pair --phone` QR over Relay or on a network that can reach
  the server, then compare the fingerprint and allow the phone in the terminal.
  After pairing, the phone lists the server once under its paired machines.
  Signing out refreshes an expiring account session before removing the
  listing and stops heartbeats.

## Session feature parity

PRO-347 completes this list. It names every local session feature and whether it
works on a machine, is hidden, or is a follow-up with its ticket. A machine
session (`machine:<m>:<p>:<s>`) opens in `SessionView` with the cloud views,
fed by the machine's one connection (`src/lib/machineSession.ts`).

| Feature | On a machine | Where |
| --- | --- | --- |
| Transcript replay, live events, tool rows, images | Works | `session.subscribe` on the machine |
| Composer: `/` commands, `@` files, model, effort, mode | Works; lists come from the machine (`composer/2`, `session.files`) | PRO-347 |
| Image attachments | Works; uploaded to the machine by session | PRO-347 |
| Other file attachments | Works; uploaded to the machine (`composer/4`), stored in the session's attachments folder there, and the agent is handed those paths | PRO-407 |
| Send, steer, stop, interrupt, approvals, questions | Works, live over `agent-commands/1`; nothing is queued on this computer while the machine is away | PRO-343, PRO-347 |
| Settings chosen before a send (model, effort, mode) | Works; sent with the next `session.send` | PRO-347 |
| Agent tabs: add, close, switch | Works (`session.addTab`, `session.close`) | PRO-347 |
| Terminal view of an agent tab | Works (`agent-pty/1`) | PRO-347 |
| Shell terminals | Works; created in the session on the machine, docked in the side panel as "{machine} terminal N" | PRO-347 |
| Setup and Run scripts, Run menu, restart offer | Works: read and run on the machine (`machine/7`); the dock's Setup and Run tabs, each action's run a dock tab; previews open through a forward | PRO-403 |
| Changes, diffs, staging, commit, push | Works on the machine through `git/1`; commits carry this computer's git identity, push uses the machine's git sign-in | PRO-347 |
| The branch's PRs in the side panel | Works through the machine's `git/1` (`git.prs`) | PRO-347 |
| Header branch button: diff size, Create PR, push, pull, mark ready, merge, agent steps | Works; read from the machine's `git/1` (`git.status`, `git.prs`, the branch's diff against its base) as files change there, and run there with its Git sign-in; Merge is pinned to the head that was read (`git.prMerge` `head`). A cloud workspace session keeps the branch chip only | 21.08, PRO-404 |
| Files, editor, file search | Works, rooted at the session's worktree: the repository Changes shows, inside the project or in an absolute worktree folder | PRO-347, PRO-405 |
| Remove the session's worktree once its PR merged | Manual Delete workspace works on the machine (`workspace/1`); automatic cleanup is machine-owned and depends on its own running cleanup passes and settings | PRO-406, [#1212](https://github.com/terminalx-ai/terminalx/issues/1212) |
| Rename, archive, pin | Works | PRO-346 |
| Header chip (machine, state, route), "Runs on" strip | Works; the chip opens the connection popover | 21.08, 21.09, PRO-347, PRO-352 |
| Reconnecting and unreachable states in the session | Works; the composer keeps what is typed and sends nothing until the machine is back and the person sends it | 21.09, PRO-347, PRO-352 |
| Agent sign-in notice | Works; names the machine ("Sign in from its page") | 21.09, PRO-350 |
| Cost chip | Works; the totals come with the machine's session list, and the popover reads them again, how each agent signs in and the usage windows on the machine (`session.usage`) | PRO-408 |
| Agent account label and tab mark | Works; the account the tab runs on as the machine lists its agent's accounts (`accountLabel`), only when that agent has several there | PRO-408 |
| Continue in a new tab | Works; a new agent tab in the session on the machine, handed the tab's context read there (`session.prepareContinuation`) | PRO-408 |
| Second opinion, Retry in a new chat, composer's agent handoff | Works with `handoff/1`: the machine adds the tab and sends its first prompt in one call (`session.handoff`); the handoff's context is read there (`session.handoffContext`). An older machine runtime shows them off with why | #1327 |
| Fix check errors | Works; the PR from the machine's `git/1`, its failed logs read with the machine's `gh` (`session.checkFailures`), the prompt sent to the tab on the machine | PRO-408 |
| Built-in browser | Hidden; the "+" menu says once that it stays on this computer | Decision 7 |
| Computer use | Hidden | Decision 7 |
| Dictation into a terminal | Hidden; dictation into the composer works | Decision 7 |
| Local VM | Hidden | Decision 7 |
| Orchestration runs | Hidden | Decision 7 |
| Sharing, presence, driver leases, notes | Hidden | Decision 1, method table |
| Wake and sleep, price, mirror, cloud resource notices | Hidden | Decision 1 |
| Dropping files into a terminal | Refused with a message: the path is this computer's | Decision 7 |
| Forwarded ports and previews | Ports tab where the machine grants `ports/1`; forwarding and previews on this computer | PRO-355 |
| New session on a machine | Works: the new-session form's "Where it runs" menu, issue start and handoff | PRO-348 |

### As built (PRO-347)

- **Project scope.** `fs.*` and `git.*` need `projectId` on a machine.
  `WorkspaceRpcClient.forProject(projectId)` is a view of the one connection
  that adds it to every `fs.*`/`git.*` call, to `fs.watch`, and to `pty.create`
  without a `sessionId`. The machine session uses it for Files, Changes and the
  repository list; session-scoped calls (`session.*`, `pty.create` with a
  `sessionId`) need no project.
- **Worktree root.** The session's `cwd` relative to its project's `path`
  (compared as strings, never opened here) is the base of `cloudFileSource`;
  Changes uses the repository `git.repositories` lists for that worktree.

### As built (PRO-405)

- **A worktree outside the project.** The runtime discovers linked
  worktrees from the project's Git registry. Existing checkouts keep their
  scope when the creation setting changes. Every external path lookup checks
  the live checkout and its registration through `WorkspaceFiles`.
- **Files and Changes agree.** The runtime returns the enclosing checkout as
  `fileRoot` and its exact Git name as `fileRepository`. Both are resolved
  against the project and its live worktrees before being sent. Files, the
  editor, search and the default Changes view use this checkout, including
  for sessions in a subdirectory and checkouts beyond the repository list
  limit. When a saved starting subdirectory is missing or has become a
  file, the runtime can recover the checkout from the session's verified saved root. The panel
  reports when the checkout is unavailable. A machine's project-relative
  paths use `/` as their only separator, so a backslash in a Unix checkout
  or file name stays literal (`..` between backslashes is still refused).
- **Live commands.** The machine's agent scope (no organization) sends
  `session.send/steer/stop/decide` with a `clientRequestId` when
  `agent-commands/1` is granted. A decision keeps one id per request across
  retries, so a resend after a dropped link is answered `id-reused` or
  `request-not-pending`, which the tab shows as already answered. Without the
  capability only prompts are taken, as before.
- **Paths.** The session's display root is `machine://<m>:<p>[/<worktree>]`,
  which `assertLocal` refuses; PR associations skip `machine:` keys like
  `cloud:` ones, so nothing of the machine is looked up on this computer.

### As built (PRO-403): Setup and Run in a machine session

A local session's Run menu, Open button, restart offer and the dock's Setup
and Run tabs read the project's scripts from this computer's settings and run
them here. A machine session (screen 21.08 shows Setup and Run beside the
machine's terminal) has all of them, and everything is the machine's.

`machine/7` adds four methods. Only a runtime that serves its machine grants
it; reading is open to whoever sees the session, running is the manager's.

| Method | Params | Result |
| --- | --- | --- |
| `machine.sessionActions` | `{ sessionId }` | `{ actions, previewUrls, setupScript, setupApplies, available, ports, setup }` |
| `machine.runAction` | `{ sessionId, actionId, restart? }` | `{ started, run: { actionId, name, ptyId, state, exitCode }, terminal }` |
| `machine.setupRerun` | `{ sessionId }` | `{ setup }` |
| `machine.setupStop` | `{ sessionId, paneId }` | `{ setup }` |

- **Read on the machine.** `actions` and `previewUrls` are the project's in
  the machine's `projects.json`; `setupScript` is what the machine would run
  (its project store, or the repository layers it trusts). Nothing is read
  from this computer's settings, and the empty states say to save scripts on
  the machine. `ports` is the session's port block there: a preview's `$PORT`
  is the machine's port.
- **Run on the machine.** `machine.runAction` and the setup calls go through
  the machine runtime's own `action_runner` and `workspace_setup`, exactly as
  its own window's Run menu does: in the session's folder there, with its
  environment layers, `TERMINALX_PORT`/`TERMINALX_PORTS` and
  `TERMINALX_ACTION_ID`. A non-concurrent action already running answers
  `started: false` with that run; `restart` stops it and starts it again.
  Its own "Run after setup" starts there too. Nothing runs on this computer.
- **Runs are terminals.** Each run is the runtime's pane
  (`<session>:action-…`, `<session>:workspace-setup-…`). The machine's
  protocol server records it from its first byte, as an agent's terminal, and
  `pty.list` lists it with its session and a `run`
  (`{ kind: "action", actionId, name }` or `{ kind: "setup" }`); `pty.attach`,
  `pty.write`, `pty.resize` and `pty.control` work on it as on any terminal.
  The caller who started a run controls it. A run found already exited is
  given what the runtime kept of its output; one still running that started
  before the server existed shows its output from when it was first seen. It
  is never counted against `MAX_PTYS` and an eviction drops only this record,
  not the runtime's pane; `pty.kill` on an action's run ends it, and on the
  setup's is refused (`machine.setupStop` stops it).
- **The desktop.** `useMachineSessionRuns` (`src/lib/machineRuns.ts`) reads
  `machine.sessionActions` on each connect, again whenever a run starts or
  ends, and every 2 s while setup is going. The header's Run menu and Open
  button are the local `RunControls` over that source; the restart offer is
  the same strip. The dock (`MachineTerminalDock`) has Setup and Run first,
  then the machine's shells, then each action's run as a tab named by its
  action; the setup's terminal shows inside Setup. A machine without
  `machine/7` shows no Run menu, and Setup and Run say in one line to update
  it ("Setup and Run scripts" in `MACHINE_FEATURES`).
- **Previews.** A preview URL on the machine itself (a loopback host) opens
  in TerminalX's built-in browser through a forward of that port (`ports/1`,
  PRO-355), made when there is none; with Forwarding off, or a machine
  without `ports/1`, it is not opened and says why. Any other URL opens as
  it is. No path of the machine is opened on this computer.
### As built (PRO-408): cost, account, Continue and Fix check errors

`machine/8` adds three methods for a session the caller may see, and each tab
of `session.list` and `session.sessions` carries the account it runs on
(`src-tauri/src/remote/machine_session.rs`). A machine that does not grant
`machine/8` (an older TerminalX) shows the cost its tabs' `usage` carries and
none of the rest.

- **Cost chip.** A machine tab's `usage` is in the session list, so the chip
  draws from it as a local session's does. Opening the popover asks
  `session.usage`: the machine reads every tab's transcripts again (a move
  goes out as `session.sessions`), and answers how each agent there signs in
  (`loginMethods`, from the tab's account: an added key is "API key", an added
  subscription the agent's account kind, the machine's own login what its CLI
  says) and the machine's usage windows of those agents. The copied command
  names the session's id on the machine and says to run it there; Open Stats
  is left out, as Stats counts this computer's sessions.
- **Account label.** `accountLabel` is the label of the account the tab runs
  on, or last ran on (its `launchedAccount`, else `account`, else the
  machine's own login), and only when that agent has two or more accounts on
  the machine, and is sent only to a connection that manages the machine,
  since a label can be an email address. The header's label and the tab's
  mark read it, and never this
  computer's accounts (`TabAccountLabel`, `TabAccountMark`).
- **Continue in a new tab.** The title-bar button reads "Continue in a new
  tab…" where the machine grants `machine/8` and `session/2`. The dialog
  (`MachineContinueDialog`) reads `session.prepareContinuation`, offers the
  machine's agents and models starting from the source tab's settings, and
  Recent context or Full transcript (only when the machine has the transcript).
  Continue adds the tab (`session.addTab`) and sends it the handoff as any
  message; a send that fails keeps that tab and the next try sends to it,
  never adding a second.
- **Fix check errors.** The Branch tab's Fix errors and the shortcut find the
  session's PR through the machine's `git/1` (`sessionPrs` on its
  `cloudGitSource`), ask `session.checkFailures` for the logs, and send the
  same prompt as on this computer, naming the machine's file. Nothing of this
  computer's `gh` is used; a participant cannot ask for logs.

### As built (PRO-406): removing a machine session's worktree

- **The host.** `machineWorkspaceHost` (`src/lib/machineWorkspaceHost.ts`) is
  the session's `RemovableWorkspace` host while this Mac manages the machine,
  the machine grants `workspace/1` and the session has a worktree. It calls
  `workspace.disposition` and `workspace.remove` named by the session, so the
  machine runs the checks a local removal runs (uncommitted work, unpushed
  commits, the pull request, the second confirmation's digest). Nothing on
  this computer is read or removed; the machine's path is only shown.
  Repositories with an archive script require removal from the machine's
  own workspace dialog. The remote removal refuses before stopping sessions.
- **Where it is offered.** The machine session's Git actions menu opens the
  standard removal dialog through the machine host. The chat and the merged
  PR's What next section also offer Delete workspace once the machine verifies
  the worktree is clean and its PR has merged.
  The sessions that went with the worktree leave the sidebar at once
  (`forgetMachineSessions`); a lost answer counts as removed only when the
  machine no longer lists the session.
- **Left out.** Keeping the conversations (`keepSessions`) is refused, as on a
  cloud workspace: `workspace.remove` deletes the worktree's sessions. This
  desktop does not run merged clean-up passes on a machine (`workspace/2`).

**Parity disposition ([#1212](https://github.com/terminalx-ai/terminalx/issues/1212)).**
Automatic merged-workspace cleanup is owned by the machine, using its own
settings and local cleanup driver. PRO-406 does not require a separate desktop
control or desktop-driven passes for paired machines. No implementation remains
in this scope; a future remote control would need an explicit product and
authorization decision, including its settings and safeguards. Connecting a
machine does not turn cleanup on or copy this Mac's preferences.

This is conditional parity, not a promise of unattended cleanup on every
machine: `src/lib/mergedCleanup.ts` drives passes in the main app window for
the local host and connected cloud workspaces, and does not select paired
machines. A machine with no local driver running will not get automatic passes
from this desktop. The local `mergedSweep` in
`src-tauri/src/local_runtime/workspaces.rs` reads that host's enabled projects,
grace period and conversation setting. The `workspace/2` RPC is a separate
manager-authorized operation whose caller supplies its scope settings
(`src-tauri/src/remote/server.rs`); its availability is not itself a scheduler
or an instruction to apply this Mac's settings.

Acceptance evidence for this disposition:

- `src-tauri/src/store/settings.rs` tests the default-off setting and project
  overrides; `src-tauri/src/merged_cleanup_tests.rs` covers disabled cleanup,
  grace periods, dirty and active work, and branch outcomes.
- `src-tauri/src/remote/cleanup_tests.rs` covers manager/capability gating,
  held and dirty worktrees, removal records and restore, and verifies that an
  unconfirmed stop is not reported as removed.
- `src/lib/machineSession.removableWorkspace.test.ts` covers the manual machine
  host and its availability; `src/lib/mergedCleanup.ts` defines the current
  local/cloud host selection. These are source and test evidence, not a claim
  that a headless machine runs its own timer.

### As built (PRO-348): a new session on a machine

- **Where it runs.** Once a machine is paired (before PRO-360, with Settings →
  Experimental → Machines on), the new-session header has a "Where it runs" chip (01.07, 21.07). Its menu lists
  This Mac, each paired machine, the organization cloud entries, then "Add a
  machine…" (the pairing dialog). A machine's second line is the route, the
  sessions running there, then one reason it may not start a session (no agent
  installed or signed in, the form's project missing, no projects) or else its
  free memory (`machineWhereRow`, `src/lib/machineNewSession.ts`). An offline
  machine says when it was last seen; one that needs an update, is updating or
  no longer allows this Mac says so. None of those can be chosen.
- **The form on a machine.** Projects come from `machine.projects` (archived
  ones left out), branches from `git.branches` on that project, and agents,
  models and efforts from the machine's `runtime.agents`. The button reads
  "Create on <name>", and a line under the form says whether the agent is
  signed in there and the project exists there. The sign-in and the memory are
  read from `runtime.agents[].signIn` and `lifecycle.resources` where the
  machine reports them (PRO-350); a machine that does not is shown without
  them. Choosing This Mac again clears the machine draft
  (`machineSessionPreset`) and the create id.
- **Create.** `session.create` with the project's `projectId` and
  `useWorktree: true`: the runtime cuts the worktree beside the project on the
  machine and sends the first prompt itself, so the prompt is part of the one
  idempotent create. The form keeps one `clientRequestId` per request
  (`CreateAttempt`): the client resends it across a dropped connection, and a
  Create pressed again after the client gave up is answered from the runtime's
  idempotency cache with the session already made. A refusal or a success
  starts a new id. The session then opens in the machine session view.
- **`session-base/1`.** New namespace: `session.create.baseRef` names the
  branch the new worktree is cut from (`check_base_ref` refuses option-like,
  `..`, `@{` and other non-ref text). Without it a worktree starts from the
  project's default branch, as before. It is not one of `MACHINE_FEATURES`: a
  machine without it still creates sessions, so it does not make the machine
  "Needs update"; the branch menu says to update it instead.
- **Issue start.** Beside an issue's Start session, a "Start on" menu lists the
  paired machines with the same rows. Choosing one opens the form on that
  machine with the issue in it; the session starts with the issue's prompt,
  worktree name and, where the machine grants `pipeline/1`, its pipeline.
- **Handoff.** The Continue dialog has "Runs on". For a machine the context is
  prepared without any path of this Mac (`prepareContinuation` with
  `portable`): the bounded recent capture instead of the saved transcript's
  path. The form opens on the machine with that handoff as its prompt.
- **Left out.** Docker and Local VM targets are PRO-312. The cloud entry's
  second line shows the organization's project count, not a price: a price
  needs a create quote, which the cloud form asks for when it is chosen.

### As built (PRO-355): forwarded ports and previews

A machine session has the same Ports tab and header popover as a cloud
session (14.10, 14.11, 21.08), with the machine's name where they say cloud.
The tab and the header's forward chip appear where the machine grants
`ports/1`; without it the "Runs on" strip's update line names "forward ports"
(PRO-354) and neither appears. Hosted preview links (PRO-135) are never
offered for a machine: a machine's ports reach this Mac only.

**`ports.list` names the listener.** Each entry may carry
`process: { name, pid, cwd? }`, additive within `ports/1` (an older desktop
ignores it; an older runtime sends none, and the row shows the port alone).
`name` is a short label for the command: the executable's file name, or for
an interpreter (`node`, `bun`, `deno`, `python`, `python3`, `ruby`) running a
script, the script's file name (`vite`, not `node`). `cwd` is the process's
working directory on the machine; the UI shows its last component beside the
name when it differs ("vite · console"). The runtime lists what it can see as
its own user:

- Linux: `/proc/net/tcp` and `tcp6` as before, each socket inode matched to a
  process through `/proc/<pid>/fd`, its argv from `/proc/<pid>/cmdline`, its
  directory from `/proc/<pid>/cwd`.
- macOS: listening TCP sockets of the user's processes through libproc
  (`proc_listallpids`, `PROC_PIDLISTFDS`, `PROC_PIDFDSOCKETINFO`), argv from
  `KERN_PROCARGS2`, directory from `PROC_PIDVNODEPATHINFO`. Before PRO-355 a
  Mac answered `detected: false` and listed nothing.

The runtime's own listeners (its pid) are left out of the list. `ports.list`
stays a driver's call (`Role::Driver`, as before): naming the processes adds
nothing a terminal on the machine would not show the same person.

**Forwards on this Mac.** Every listener binds `127.0.0.1` only, as for a
cloud workspace (docs/CLOUD-PREVIEWS.md): nothing on the network can reach a
forwarded port. The desktop keeps, per connection, the forwards the person
asked for and two switches (`CloudPortSettings` in `src/lib/api.ts`):

- **Forwarding** (`enabled`, on by default): off closes every listener and
  keeps each forward as `waiting`; on opens them again.
- **Forward new ports automatically** (`auto`, off by default): while on and
  connected, the desktop reads `ports.list` every 2 s (request ids under
  `ports-`, never shown to the web view) and forwards each port that starts
  listening after the switch was turned on, skipping 32768–60999, on the same
  local port when free (a random one for a port below 1024), at most 16 at
  once per connection. Ports already listening when it was turned on, and a
  port the person stopped, are left to the person while they keep
  listening; one that stops and starts again is new and is taken. While Forwarding is off a
  new forward is refused with `cloud_port_forwarding_off`.

A machine's forwards **end with the connection and return with it**: when the
link drops (`reconnecting`, `offline`) the listeners close and the forwards
stay as `waiting`; on `connected` they open again, on the same local port when
it is free, else on a new one (`reassigned`). A cloud workspace's forwards do
not return (docs/CLOUD-PREVIEWS.md): they are dropped with the connection.
Everything is forgotten when the last web view lets go of the connection
(`cloud_remote_detach`), so a closed session view leaves nothing listening and
nothing to come back.

| Command | Params | Result |
| --- | --- | --- |
| `cloud_port_forwards` | `connectionId` | `CloudPortForward[]`, with `state` (`open`, `waiting`) and `auto` |
| `cloud_port_settings` | `connectionId` | `CloudPortSettings` |
| `cloud_port_set_settings` | `connectionId`, `enabled?`, `auto?` | `CloudPortSettings` as they now are |

The event `cloud_port_forwards_changed` (`CloudPortForwardsChanged`) carries a
connection's forwards and switches whenever either changes, with `opened`: the
forwards that opened without a click (auto, or returned after a reconnect), for
the "Port 5173 forwarded to 127.0.0.1:5173" toast.

**Open** opens the address in this Mac's built-in browser (decision 7); the
browser runs here, and only the stream crosses.

### As built (PRO-356): the command line

`terminalx machines list|status|add|remove` and `--machine <name or id>` on
`projects list`, `sessions list|create|rename|archive|unarchive`, `tabs list`,
`send`, `read`, `wait`, `permissions` and `worktrees list|delete`. A session's
`machine:` key (decision 8) routes `send`, `read`, `wait`, `tabs`, `rename`
and `archive` without `--machine`. `sessions list --all-machines` lists this
computer's sessions (`machine: null`) and every paired machine's. Without any
of these, every command sends the request it sent before. The full guide is
`skill-guides/terminalx-cli.md`, "Paired machines".

**No new protocol.** The CLI never opens a network connection. It sends
`machine.<action>` over the control socket; the runtime hands it to the
attached desktop (`local_runtime::window::supported`), and a runtime with no
desktop answers `unsupported`.

- **Native first** (`src-tauri/src/machine_control.rs`): the desktop refuses
  everything with `machines_disabled` while data privacy mode is on (until
  PRO-360: while Experimental → Machines was off).
  `list`, `status`, `add` (`Machines::inspect` and `pair`, waiting for Allow)
  and `remove` (as Settings → Machines → Remove) are answered here. `add`
  takes two calls: the first shows the fingerprint and contacts nothing
  (`fingerprint_confirmation_required`); the second names it with
  `--fingerprint` and pairs, so the person compares it with the machine's
  approval before pressing Allow, as with the dialog. For every
  other action it resolves the machine (id, `machine:` key, or a name in any
  case: `machine_unknown`, `ambiguous_selector`) and refuses at once by the
  owner's state: `reconnecting` and `offline` are `machine_offline`, and
  `needsUpdate`, `updating`, `accessRemoved` and `disconnected` have codes of
  their own. `idle` and `connecting` go on. A `machine:` key in the params
  must name the same machine.
- **Then the window** (`machine_control_request`, answered through
  `cloud_control_reply`; `src/lib/machineControl.ts`) runs it over the
  machine's one connection with the code the machine views use: the catalog
  for lists, `createMachineSession` for a new session (one
  `clientRequestId` per `--idempotency-key`), live `session.send` and
  `session.decide` (`agent-commands/1`), a replayed `session.subscribe` for
  `read` and `wait` (the cloud wait's `settledReason`), `session.update` for
  rename and archive, and `cleanup.scan` / `cleanup.remove` for worktrees. A
  machine this window does not hold yet is attached and given 10 s; a
  machine still not connected is `machine_offline`. A namespace the machine
  did not grant is `machine_unsupported`, naming its version.
- **Waits** are asked in calls of at most 30 s, as cloud waits are, so a
  caller that goes away leaves nothing running.
- **Limits.** A run's worker is refused `machines add|remove` and
  `sessions create --machine` (`forbidden`; also in `orchestration::guard`
  `RULES`): a session it starts locally is marked a worker as it is made, and
  one on a machine cannot be. Orchestration runs with workers on another
  machine stay out of scope (decision 7). Issue starts from the CLI, renaming
  a machine's worktree, and `sessions report|usage|status|show` stay on this
  computer.

### As built (PRO-358): two machines end to end in CI

Every Machines ticket changes how two processes on two computers talk, and a
unit test on one side passes while the pair is broken. So CI runs the pair.

**The world** (`src-tauri/serve/tests/common/world.rs`) starts three machines,
each its own process with its own data directory:

- **This Mac**: the operating computer's own local runtime, one project,
  "Let other computers operate this Mac" off. It must end the run untouched:
  not hosting, nothing paired, no session, no commit, the same project list.
- **Mac mini**: a second `terminalx-serve` on the same host in machine mode
  (no `--project-root`) with two projects and hosting on, started as its app
  starts it (`TERMINALX_LOCAL_DESKTOP=1`, the key in a file). The test is its
  window: `createCode`, `approve`, `decline` and `revoke` over the runtime
  IPC with a fresh attachment, and a consent witness for what only a person
  may do (`serve_cli::consent`).
- **dev-server**: `terminalx-serve` in a Linux container
  (`scripts/machine-e2e/Dockerfile`, ubuntu:24.04 for the runner's glibc),
  headless, one project added with `terminalx-serve projects add`, paired as
  a person pairs a server: `terminalx-serve pair` in a terminal on it
  (`docker exec -it` inside a pseudo-terminal), answered `y`. The container
  sees the test's directories, the binary and `scripts/remote-runtime` at the
  same paths, runs as the runner's uid and gid with a passwd entry for it, and
  publishes its port on 127.0.0.1, so its socket, token and project ids are
  the same on both sides. It runs only when `TERMINALX_E2E_LINUX_IMAGE` names
  the image; with `TERMINALX_E2E_REQUIRE_LINUX=1` (CI) a missing image is a
  failure, never a skip. On a Mac it cannot run (the binary is a Mac's), so
  the Linux scenarios are left out there with a message.

The operating computer is the desktop's own code: the pairing client
(`src-tauri/src/machines/pair.rs`, compiled at the crate root as
`machine_pair` so headless builds and these tests have it; the desktop still
reaches it as `machines::pair`) and `MachineSupervisor`, with the web view's
frames sent and answered through it.

**The scenarios** (`src-tauri/serve/tests/machines_e2e.rs`), against Mac mini
and the dev-server:

- pair by code and Allow (the window; the server's terminal);
- `machine.describe` (name, OS family, `hasWindow`) and `machine.projects`;
- a session in a project and a prompt the fake agent answers (`echo:`);
- a shell: `pty.create`, type, `pty.resize` (checked with `stty size`), drop
  the connection and make it again, then `pty.attach` from an offset replays
  only what came after it;
- `fs.write` and `git.commit`, then the file and the commit (hash, message,
  author) read on that machine's own disk with its own git (inside the
  container for the dev-server);
- refusals: a wrong code, a used code from another computer, a paired token
  with another client key (4401), a declined approval (window and
  terminal), Mac mini's credential on the dev-server; another machine's
  `projectId` (`not_found`), a path leaving the project (`path_forbidden`),
  a `projectId` that is not the session's (`invalid_params`), Mac mini's
  sessions unknown to the dev-server and the reverse, and this Mac
  untouched. Each machine sees at most four wrong attempts, under the five
  that pause pairing;
- a running turn interrupted with `session.interrupt` (`slow:`) and an
  approval answered with `session.decide` (`ask:`), last, since a refusal
  leaves the tab busy. A refusal is collected and fails the test at its
  end, after everything else has been checked on both machines;
- revoke (the window's `revoke`; `terminalx-serve devices revoke` on the
  server): the supervisor ends in "access removed" and retries nothing.

**Found by these scenarios, and fixed with them.**

- *A machine reached only directly served no agent commands.* A runtime
  started its agents layer (`start_cloud_agents` in `src/serve.rs`, which
  `session.interrupt` and `agent-commands/1` need) only with a relay link,
  and only the relay route's RPC got it (`WorkspaceRpc::set_agents` in
  `remote::host::serve_machine`). A machine with no link (every desktop
  until PRO-344, a server paired with `terminalx-serve pair`) builds its own
  RPC in `MachineHost::rpc`, which had none: a computer could send prompts
  but not stop a turn (`unavailable`) or answer an approval
  (`method_not_found`). The machine host is now given `Parts::agents`, which
  opens the agent tabs (no mailbox: live calls with receipts kept here,
  decision 3) the first time it builds its RPC, so a runtime hosting no one
  opens nothing more. With a link, the direct listener serves the relay
  route's RPC as before.
- *A paired computer was two peers.* The direct route serves a paired
  computer as its registry id; the relay route served it as its relay device
  id. After a move from the direct route to the relay, the computer no longer
  controlled the terminals it had opened (`pty.write` refused
  `not_controller`, and the desktop never sends `pty.control` after a route
  change), and its write numbering and command receipts started over, so a
  resend could be applied twice. The relay route now serves a paired
  computer under its registry id too (`RelayHost`, `remote/host.rs`);
  `machine_routes.rs` checks the terminal keeps working through the relay and
  a resent write is dropped.

**The job.** `machines-e2e` in `.github/workflows/ci.yml`, on ubuntu-latest,
required by `check`. `check` fails on a skipped job, so it always runs and
decides in a step (`scripts/machine-e2e/relevant.py`): every push, schedule
and dispatch, and a pull request whose files (from the API, else the merge
commit's diff, else assumed relevant) touch `src-tauri/src/remote`,
`pairing`, `serve.rs`, `machine_host`, `machines`, `machine_wire.rs`,
`relay_e2ee.rs`, `src-tauri/serve`, the scripts, `src/components/machines`,
`src/lib/machine*`, any other file under `src/` named for machines
(`MachineNewSession.tsx`, `src/types/machines.ts`, ...) or the workflows. `scripts/machine-e2e/run.py tests
machines_e2e machine_routes` builds the image, the runtime and the tests,
checks the binary loads in the image (`ldd`), runs each test on its own and
writes each test's time, each phase's and the total to the job summary. The
cargo cache is the job's own (CI's cache policy, `infra/ci-runners`, allows
no other job's), saved only from main, schedule and dispatch runs; a pull
request restores main's. The job may run 25 minutes, so a cold build (the
first after a `Cargo.lock` change) can finish and be saved, and its last step
checks the budget: over ten minutes with a warm cache fails the job, and every
run writes its time to the summary.

**The break check.** `.github/workflows/machines-e2e-breaks.yml` (nightly and
by hand) runs `run.py breaks`: for each `scripts/machine-e2e/breaks/*.patch`
the patch must apply, the runtime and tests must still build, `machines_e2e`
must then fail, and its output must hold the patch's `.expect` marker, the
message of the assertion that guards that check.

| Patch | Removes | Fails |
| --- | --- | --- |
| `pairing-check.patch` | `MachineHost::paired_with_key` pinning a paired token to its client key (rule 2 above) | `pairing_refuses_a_wrong_or_used_code_another_key_and_a_declined_approval`: the used code from another computer is let in, and the paired token with another key is admitted (`PAIRING CHECK BROKEN`) |
| `project-scoping.patch` | `Projects::get` refusing a `projectId` the machine does not have | `a_computer_pairs_with_two_machines_and_operates_each_in_its_own_projects`: this Mac's project is served by Mac mini (`PROJECT SCOPING BROKEN`) |

The workflow fails when a patch no longer applies, no longer builds, or the
scenarios pass (or fail for another reason) with it applied. A change that
moves either check updates its patch in the same pull request.

Previous-release compatibility is the `machine-compat` job (PRO-354,
`tests/machine_compat.rs`); this job does not repeat it. The relay route is
`tests/machine_routes.rs` with the relay in `tests/common/relay.rs`.

### As built (PRO-360): Machines for everyone

- **No switch.** Settings → Experimental has no Machines row, the setting
  (`experimental.machines`) is gone from `ExperimentalSettings` in Rust and
  TypeScript, and `set_experimental_settings` no longer takes it. A settings
  file that still has it reads, and loses it on the next save.
- **Shown once a machine is paired.** Every place the switch gated now asks
  whether a machine is paired: the sidebar's machine sections
  (`MachinesSection`), the sidebar filter's machine rows, the overview's Where
  column and All machines menu, the new-session form's Where it runs (and its
  Add a machine dialog), the handoff's Runs on, Start on a machine, the badge,
  notices and attention stepping (`machineDashboard.ts` has no `enabled` any
  more). With none paired the app looks as it did before the epic; Settings →
  Machines is always there.
- **Nothing listens, nothing connects.** "Let other computers operate this
  Mac" stays off by default (decision 9), so the runtime opens no listener and
  registers nothing with the relay. AppShell holds `startMachineConnections`
  for every window; with no machine paired it reads `machines_list` (a local
  file) and attaches nothing (`machineConnections.test.ts`, "with no machine
  paired reads the empty list and attaches nothing").
- **The command line.** `machine.*` is gated by pairing, and refused with
  `machines_disabled` in data privacy mode (Trust model, Accepted risks).
- **First run.** With no machine paired, Settings → Machines → Your machines
  shows three steps (get the other computer ready, add it here, start a
  session there) and the guide. No 21.xx screen shows this state: it is
  21.02's bordered card with 21.06's numbered steps. The guide is
  [MACHINES-GUIDE.md](MACHINES-GUIDE.md), linked under the page's lead
  (`MACHINES_GUIDE_URL`).

## Release and verification (PRO-338)

TerminalX 0.2.35 made Machines available in Settings and kept hosting opt-in.
That release includes account relay registration (PRO-368), runtime phone
access (PRO-359) and the security controls from PRO-357. PRO-369 added proof of
window identity for macOS pairing consent. PRO-403 through PRO-408 subsequently
merged the machine session follow-ups for project scripts, branch and PR
controls, files and changes, worktree removal, attachments, cost, account
labels, continuation and check failures. [Release notes](../CHANGELOG.md#0235)

On 2026-11-18, the two-machine CI job passed on main at `ef16107d5`, including
the Linux container scenarios and relay fallback. The job runs the desktop
pairing client and supervisor against a desktop-mode runtime on Ubuntu and
a second runtime in a Linux container. The separate `machine-compat` job
runs on macOS against previous runtime releases.
[Two-machine CI run](https://github.com/terminalx-ai/terminalx/actions/runs/44326914428/job/134880556994)

### In scope

| Item | Desktop-mode runtime | Headless Linux container | Other evidence |
| --- | --- | --- | --- |
| Pair by code, fingerprint, Allow | Two-machine CI (the window approves) | Two-machine CI (`terminalx-serve pair`, answered `y`) | `pairing_tests`, `security_tests` |
| Pair through the account | Host grant test | First pairing uses a direct code | `pairing_tests::a_computer_paired_through_a_grant…`; PRO-368 registers signed-in hosts for relay access |
| Sessions and chat (create, send, read) | Two-machine CI | Two-machine CI | |
| Approvals, stop | Two-machine CI (`session.decide`, `session.interrupt`) | Two-machine CI | |
| Terminals (create, resize, reconnect, replay) | Two-machine CI | Two-machine CI | |
| Files | Two-machine CI (`fs.write`, read back on the machine's disk) | Two-machine CI | |
| Git (status, commit) | Two-machine CI (commit read with the machine's own git) | Two-machine CI | |
| Push and pull requests | Not in two-machine CI | Not in two-machine CI | `remote/git_tests.rs` (the code cloud workspaces use) |
| Forwarded ports | Not in two-machine CI | Not in two-machine CI | `remote/ports.rs`, `cloud_ports.rs` tests (PRO-355) |
| Projects (add, remove) | Not in two-machine CI | `terminalx-serve projects add` in CI | PRO-351 tests (`machine.addProject`, folder browser) |
| Agents and sign-in state | Not in two-machine CI | Not in two-machine CI | PRO-350 tests (`remote/machine.rs`, `harness/setup.rs`) |
| Updates and version differences | `machine-compat` (each previous release against this build, both directions, on macOS) | Same | `remote/machine_update.rs` tests (PRO-354) |
| Relay route and fallback | `machine_routes` (direct drops, relay answers; both drop, recovery) | Not covered | |
| Revoke | Two-machine CI | Two-machine CI (`terminalx-serve devices revoke`) | |
| The command line | Not in two-machine CI | Not in two-machine CI | `machine_control.rs` tests (PRO-356) |

### Out of scope, hidden

| Item | How it is kept out |
| --- | --- |
| Built-in browser, computer use, Local VM, orchestration runs on a machine | Hidden in a machine session (Session feature parity); no protocol method reaches them (decision 7); `pairing_tests::a_paired_computer_has_no_pairing_browser_or_computer_methods` |
| Dictation into a machine's terminal | Hidden; dictation fills the composer only |
| Moving a session between machines | No control offers it; a session's key names its machine (decision 8) |
| Sharing a machine with other people | `collab/1` not served; sharing, presence and notes hidden |
| A Windows host | The runtime builds and serves the local desktop on Windows (`docs/LOCAL-RUNTIME.md`, "Windows"); serving paired computers from one is not yet verified |

### Remaining coverage and route limits

- The two-machine job uses simulated machine roles. A manual pairing and
  session run from the macOS desktop to another Mac and to a Linux server
  still needs separate verification.
- Pull requests, ports, project management from the desktop, agent sign-in,
  account pairing and CLI operations have focused tests. The two-machine
  job exercises the paths listed in the table.
- A headless host needs a direct route for first pairing. Once paired and
  signed in, it can reconnect over the relay. Headless hosts do not appear
  in the account picker.
