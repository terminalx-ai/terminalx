# Machines: operating TerminalX on another computer (PRO-338)

Status: architecture note for the Machines epic. The nine decisions below were
confirmed by the owner on 2026-11-13. Written against `main` at `46c6250f`
(TerminalX 0.2.32) on 2026-11-14.

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
- **Paired computers are kept apart from phones.** They go in their own registry
  file in the runtime's data directory, never in `devices.json`. `DeviceScope`
  is a strict enum (`src-tauri/src/pairing/model.rs:73`), and `devices.json`
  is read with `?` (`src-tauri/src/pairing/registry.rs:298`). One unknown scope
  value would make an older build fail to load every phone pairing.
- The runtime stays alive while a computer is connected, as for an attached
  window (`docs/LOCAL-RUNTIME.md`, "Lifetime and honest recovery").

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
- Data privacy mode forces it off (PRO-357).

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
| `session.create` | `session/1` | Needs a project | `projectId` names where it runs; `repository` (`session-repository/1`) is not used |
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
| `runtime.agents` | `agents/1` | Served | Machine-wide; PRO-350 adds each agent's sign-in state as a field |
| `session.commands` | `composer/1` | Served | |
| `session.files` | `composer/2` | Served | |
| `session.attach` | `composer/3` | Served | Needs its store without the cloud agents layer (decision 3) |
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
| `git.prAssociations` | `git/1` | Needs a project | |
| `git.prLanded` | `git/1` | Needs a project | |
| `git.checkout` | `git/1` | Needs a project | |
| `git.commit` | `git/1` | Needs a project | |
| `git.stage` | `git/1` | Needs a project | |
| `git.unstage` | `git/1` | Needs a project | |
| `git.fetch` | `git/1` | Needs a project | With the machine's git sign-in |
| `git.push` | `git/1` | Needs a project | With the machine's git sign-in |
| `git.pull` | `git/1` | Needs a project | With the machine's git sign-in |
| `git.prCreate` | `git/1` | Needs a project | With the machine's `gh` |
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
| `lifecycle.resources` | `lifecycle/1` | Served | Measures the disk of the root it is given (`src-tauri/src/remote/server.rs:1064`); a machine measures its data directory's disk |
| `collab.state` | `collab/1` | Not served | Sharing with other people is out of scope (PRO-338) |
| `presence.update` | `collab/1` | Not served | As `collab.state` |
| `notes.list` | `collab/1` | Not served | As `collab.state` |
| `notes.post` | `collab/1` | Not served | As `collab.state` |
| `lease.acquire` | `collab/1` | Not served | As `collab.state`; two operating computers on one tab are not arbitrated in the first version |
| `lease.release` | `collab/1` | Not served | As `lease.acquire` |
| `lease.takeOver` | `collab/1` | Not served | As `lease.acquire` |
| `ports.list` | `ports/1` | Served | The machine's loopback |
| `ports.open` | `ports/1` | Served | A forward ends with the connection (PRO-355) |
| `ports.write` | `ports/1` | Served | |
| `ports.ack` | `ports/1` | Served | |
| `ports.close` | `ports/1` | Served | |

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

## Trust model

PRO-357 adds the threat model and its tests here. What each party can see and do:

| Party | Can see | Can do | Cannot |
| --- | --- | --- | --- |
| The relay | The `machineId` (relay host id), IP addresses, timing and sizes, and the E2EE hello and ready frames (public keys, nonces) | Drop, delay or cut connections | Read or change any RPC, device token, transcript, terminal or file: frames are sealed and counted, so a change, replay or reorder closes the connection (`docs/MOBILE.md`, "E2EE framing v2") |
| The account server | The machine's name, public key, capabilities (including whether operating is on), online or last seen, and which installation asked to pair with which machine and when | Withhold or forge directory entries and grants | Read a pairing offer: it is sealed with HPKE to the requester's key. Complete a computer's pairing without "Allow" on the machine and a matching fingerprint on both screens (decision 5). See projects, paths, session titles or prompts: none are in any request (PRO-344) |
| A paired computer | Everything the runtime's user can read on the machine (decision 5) | Every method marked served or needs a project; through a shell, anything that user can do | Use a method that does not exist: pairing others, the operating switch, the browser, computer use, dictation, Local VM. Use its credential after revocation: its connections are closed and its token hash is removed. Revocation does not undo what it did through a shell before then, such as a registry entry it wrote, an SSH key or a launch agent (decision 5) |
| A phone | What its scope allows, as today | Its phone actions | Get workspace RPC: the runtime serves by the device's scope (decision 4) |

The pairing code is a secret until it is used. Whoever has it can ask to pair,
which is why every computer pairing waits for "Allow" and a fingerprint the
person compares on both screens.

## Session feature parity

PRO-347 completes this list. It names every local session feature and whether it
works on a machine, is hidden, or is a follow-up with its ticket. Settled here:

| Feature | On a machine | Where |
| --- | --- | --- |
| Built-in browser | Hidden | Decision 7 |
| Computer use | Hidden | Decision 7 |
| Dictation into a terminal | Hidden; dictation into the composer works | Decision 7 |
| Local VM | Hidden | Decision 7 |
| Orchestration runs | Hidden | Decision 7 |
| Sharing, presence, driver leases | Hidden | Decision 1, method table |
| Forwarded ports and previews | Works | PRO-355 |
