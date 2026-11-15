# Native collaboration v2 (production held)

The coordinated contract is `collaboration: {v:2, revision, members}` on the
existing bootstrap refresh response. The request remains `{}`. Revision is a
canonical nonnegative decimal bigint string in `0..=9223372036854775807`,
ordered and bounded without numeric conversion.
Members contain `userId`, `role`, independent `canApprove`, and required nullable
`writeSource` (`explicit`, `everyone`, `implicit`). No prepare/ack protocol,
endpoint, or client-supplied generation is introduced.

Production continues to advertise `collaboration-v1` and `collab/1` only.
Unsolicited v2 responses fail closed through the existing version parser. The
internal v2 installer is dormant and has no production activation setting.
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

Admission is per tab. Everyone prose requires an owned supported engine, known
stored and pending modes, and a raw current provider stance. Claude `dontAsk`,
bypass, unknown modes, Codex `never`, unknown approval/sandbox combinations,
shells and hand-started/adopted engines fail closed. Approval counts do not prove
safety. A raw terminal write taints that PTY launch until managed replacement;
a delayed safe provider report cannot clear that latch.

Mailbox judgment/application and follow-up dispatch serialize against policy
replacement. Native permits carry provenance into delayed PTY prompt and native
Codex frame writers. PTY body, attachments and submit recheck the tab under its
runtime lock; automatic Enter retries retain the original permit. Native Codex
rechecks before empty write retries, and keeps policy admission through a frame
once physical delivery begins. Raw RPC terminal queues retain policy and process
identity. Port-stream writes also retain their opener's revision/source and
check it at each nonblocking socket write. A handed-over v2 echo retains a
durable provenance-required marker, so losing its in-memory permit cannot
turn an automatic Enter retry into trusted local input. Local desktop/mobile raw input taints the corresponding launch at its
actual write. Trusted local desktop operations retain their existing control.

Legacy ACP/OpenCode v2 remote prompt delivery is explicitly unsupported and
refused before input. Native Codex reads the resolved tagged sandbox policy
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

The worker ran the three required serial filters with Xcode's macOS SDK:
`phase2_collaboration_v2` (24 passed), `session::mobile_admission_tests`
(2 passed), and `local_sharing::tests` (12 passed), all exit 0.
The v2 cases include actual encrypted lease application, durable RPC journal
admission, real PTY body/submit and capacity waits, native child-stdin writes
from parsed provider reports, async native startup, shell adoption, handover
Enter retries, and loopback socket writes. These are local stand-ins at the
physical apply boundary, not production/provider availability acceptance.
