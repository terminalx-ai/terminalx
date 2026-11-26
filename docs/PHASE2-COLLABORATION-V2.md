# Native collaboration v2 (production held)

The coordinated contract is `collaboration: {v:2, revision, members}` on the
existing bootstrap refresh response. The request remains `{}`. Revision is a
canonical nonnegative decimal bigint string in `0..=9223372036854775807`,
ordered and bounded without numeric conversion.
Members contain `userId`, `role`, independent `canApprove`, and required nullable
`writeSource` (`explicit`, `everyone`, `implicit`). No prepare/ack protocol,
endpoint, or client-supplied generation is introduced.

Production continues to advertise `collaboration-v1` and `collab/1` only.
The host refresh path preserves and installs the complete v2 response under
its captured authenticated runtime generation before processing attachments,
only when native request context records collaboration-v2 negotiation. Production
request context comes from the unchanged v1-only capability header: unsolicited
v2 fails closed. There is no activation setting or response-supplied negotiation.
Tests inject negotiated request context through the same bootstrap/host path.
V1 manager approval coercion is preserved at its parsing boundary. V2 managers
without approval keep lifecycle/Manage report authority but cannot configure or
approve an agent. Everyone drive provenance does not erase independent approval.

The internal policy stores a durable revision floor, rejects reversed and
same-revision conflicting maps, and poisons conflicts until a newer revision.
Rebinding a store never restores authorization by itself. Stamps include the
revision, authenticated runtime generation, local incarnation epoch, and exact
member/provenance. Queued work keeps its original stamp rather than acquiring a
new one at delivery. Generation changes and legacy responses invalidate active
v2 authorization.

Admission is per tab. Everyone prose requires an owned supported engine, a
stored Ask mode (`manual`, `plan`, or `acceptEdits` and their aliases), an
Ask mode for any pending change, and a compatible raw current provider stance.
Auto, Claude `dontAsk`, bypass, unknown modes, Codex `never`, unknown
approval/sandbox combinations, shells, and hand-started or adopted engines fail
closed. Refused drives return `everyone-tab-read-only` as direct RPC
`error.data.reason` or mailbox receipt category. Tab creation and raw
terminal input return `everyone-explicit-access-required` to participants
whose drive authority comes from Everyone. Approval counts do not prove safety. A raw terminal write taints that PTY launch until managed replacement;
a delayed safe provider report cannot clear that latch.

Mailbox judgment/application and follow-up dispatch serialize against policy
replacement. Native permits carry provenance into delayed PTY prompt and native
Codex frame writers. PTY body, attachments and submit recheck the tab under its
runtime lock; automatic Enter retries retain the original permit. Native Codex
rechecks original authority before every physical attempt, including after partial
progress, and releases policy admission during capacity waits. A refused partial
frame retires its original connection without replaying its remainder. Raw RPC terminal queues retain policy and process
identity. Port-stream writes also retain their opener's revision/source and
check it at each nonblocking socket write. A handed-over v2 echo retains a
durable provenance-required marker, so losing its in-memory permit cannot
turn an automatic Enter retry into trusted local input. Local desktop/mobile raw input taints the corresponding launch at its
actual write. Trusted local desktop operations retain their existing control.

Legacy ACP/OpenCode v2 remote prompt delivery and settings are explicitly
unsupported and refused before input. Native Codex reads the resolved tagged sandbox policy
from thread/start or thread/resume responses. Unknown shapes, extra writable
roots outside the checkout, granular approval policies and automatic approval
reviewers remain unsafe for Everyone. A missing complete raw approval/sandbox
report remains unknown. These are fail-closed exclusions, not
provider compatibility or production acceptance evidence. Capability activation
requires lead review of all apply paths and race tests.

## Accepted lease Actor contract (server implementation pending)

The additive v2 lease Actor has `collaborationRevision` and required nullable
`writeSource`. Native checks its generation, bounded canonical revision, user,
role, independent approval and drive source against the installed snapshot
before decrypting/applying input. Missing, stale, future or conflicting fields
fail closed with `collaboration-provenance-unavailable`; a role-only Actor
cannot inherit local explicit authority. Explicit null is distinct from a
missing source, including viewer approvals. V1 Actor behavior is unchanged.

The existing lease request uses the same capabilities header as refresh, whose
production value still advertises v1 only. There is no new endpoint or ack.
Encrypted-lease regressions exercise both matching admission and refusal of a
fresh Everyone Actor against stale explicit bootstrap authority. The server
implementation and production availability remain pending; design acceptance
and local tests do not authorize activation.

## Focused validation

Final-source validation with the Xcode macOS SDK passed the required serial
filters: `phase2_collaboration_v2` (31 passed, 145.60 seconds),
`session::mobile_admission_tests` (2 passed), and `local_sharing::tests`
(12 passed), each exit 0. The v2 filter includes real pending-settings launches
and both negotiated refresh/attachment regressions. Production capability
activation remains held for lead review.
The v2 cases include actual encrypted lease application, durable RPC journal
admission, real PTY body/submit and capacity waits, native child-stdin writes
from parsed provider reports, async native startup, shell adoption, handover
Enter retries, and loopback socket writes. These are local stand-ins at the
physical apply boundary, not production/provider availability acceptance.

## Continuation: physical retries and observed attachment revocation

Legacy/local prompt bodies, Enter submissions and automatic Enter retries use
exactly the existing retrying terminal writer. V2 prompt bodies and Enter
submissions retry nonblocking attempts while rechecking the original permit,
process, current mode, pending mode and ownership. They release policy/runtime
locks during capacity waits. Tests fill a real PTY input buffer before a legacy
Enter, and pause the asynchronous composer at Enter to verify both successful
retries and refusal after revision, mode, provider-report or attachment changes.

A direct RPC stamp also contains a native connection id within its existing
local epoch. Its liveness is held weakly by the policy, and the same marker is
serialized with durable direct follow-ups. The retained Permit also checks its
originating Peer. Native disconnect publishes cancellation before waiting for
admitted physical writes. A raw PTY queue acquires policy admission after its
input-lock wait, so disconnection can complete while queued input is blocked.
Tests observe disconnect without installing a newer policy snapshot, then
release queued blocking RPC work, raw PTY input, composer Enter and native
Codex stdin work. None may apply. Reconnecting the same user does not revive
the original connection's durable follow-up.

Mailbox leases remain independent of a transient direct connection: their
accepted authoritative Actor revision/source and runtime generation determine
admission. This fence enforces revocation the native runtime has observed;
it does not claim visibility of a server commit before refresh/revocation arrives.

Pending remote settings have durable opaque request markers, bound to their
original native permits in memory. Each setting retains its own authority.
Before an idle restart and at the final PTY launch, stale requests are withdrawn;
missing permits after restart/adoption fail closed. An unrelated local request
survives. A test enters the real idle-restart reservation and inspects arguments
received by a stand-in Codex process after revision/source/approval changes,
observed disconnect, loss of the in-memory permit, and revocation after restart
reservation but before replacement spawn. A completed native Codex
handshake releases its startup permit: later prompts and decisions carry their
own authority, including trusted local control.

## Negotiated refresh and attachment admission

BootstrapLink retains the complete collaboration payload and the native request's
capability context. The host binds installation to its captured registered runtime
generation and checks the response token against that generation. The policy's
own generation must agree as well, so a mailbox generation advance fences late
host refreshes. No generation or negotiation field is accepted in collaboration.

A refused snapshot cannot create pending attachments. Successful source/role/
approval changes retire saved credentials and observed connections for both
workspace and session scopes before new attachments are answered. Attachments
retain their original member, source, local epoch and generation through invite
creation and reconnect admission; a late invite cannot revive a retired grant.
On restart, saved v2 attachments without current native provenance are retired
conservatively and must be paired again. V1 reconnect behavior is unchanged.

Independent device revocations are applied and durably acknowledged even when
the accompanying policy is malformed, unsupported or unnegotiated. Policy
rejection still prevents new pairing; it never postpones revoking an old token.

The refresh-route tests fetch through RuntimeLink, apply the same host method as
the refresh loop, create invites through the relay control channel, persist device
credentials, and exercise actual device admission/cancellation. They include an
invite paused across generation retirement. A second regression carries the
bootstrap conversion and host installation into durable session RPC application,
including independent manager approval and stale follow-up rejection. Relay and
provider counterparts are local test stand-ins; no production service was enabled.


## Dormant provider integration continuation

The shared native owner now carries original operation identity through ACP
opening, queues, settings, approval attempts, whole-response callbacks and
nonblocking frame writes. OpenCode uses the same reserve-once streaming lifecycle
for its actual HTTP writer and exact association fencing for SSE output. These
internal paths retain the public ACP/OpenCode v2 entry blocks and unsupported
Everyone witness; they do not advertise provider availability or activate v2.

Lead integration checks passed serially on the combined source: shared carrier
12, ACP owner 9, ACP adapter 9, OpenCode transport 10 and OpenCode owner 13 tests.
The earlier no-wire mode-test timeout was traced to a fixture reply omitting its
mode identifier; the fixture now supplies that report and asserts that a repeated
known mode emits no extra RPC. Full privacy regressions, all local gates and
independent review remain required. Local subprocess/loopback fixtures are not
production or cross-device certification.
