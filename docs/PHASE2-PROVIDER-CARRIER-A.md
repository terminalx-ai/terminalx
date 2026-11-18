# PRO167 shared provider authority carrier A

Source-only, unvalidated checkpoint. No test, build, Cargo, rustc, formatter,
verifier, commit hook, collection, or activation has been run for this source.
The focused grant marker is not an allocation. Validation requires both a fresh
lead slot and the marker; source readiness is not completion or support.

The source baseline is 26080f13d9b1e1426a3754ef2a5bb774f9aef312. This slice
implements only the shared native carrier described in the reviewed
A-internal-carrier-contract.md. The ACP/OpenCode send and settings V2 entry
blocks remain. Everyone still has no supported ACP/OpenCode witness. V1
capabilities, advertisements, ordinary explicit-grant association semantics,
and the separate local-sharing by-hand rule are unchanged.

## Native carrier

`session_provider_authority.rs` is registered from `session.rs`, without a
lib.rs change. `SenderAuthority` retains the original native Permit clone and
its ingress-admitted action. Its privacy, mobile and local-sharing permits are
independent constraints; explicit Local does not erase them. MissingRemote is
a refusal. Checks call the original Permit methods, including its attachment,
revision, policy generation and process epoch fences. No queue/callback
constructor calls current(), stamp(), or Permit::new. The ingress-admitted
action is supplied by the trusted native owner, never by decoded caller data.
Derived operations retain that action and cannot upgrade Drive to Configure
or Approve.

`ProviderBinding` separately fences session/tab, a weak exact LiveChild and
its immutable epoch, and an engine incarnation token. Reset/launch replacement
retires the native owner state. PID, port, saved provider ID and successful
localhost responses cannot reconstruct it. There is no production adopted ACP
or OpenCode association constructor in this slice. The helper's associated-token
test fixture demonstrates that explicit rights themselves do not require an
Everyone owned/safe-mode witness; it does not add an adopted-provider route.

`OperationContext` carries its own native UUID, binding, original sender,
explicit action, exact request correlation, shared lifecycle and parent fences.
Prompt seq, per-setting request ID plus adapter request, approval ask plus answer
attempt, opening parent, and control request are distinct correlations. Clones
share consumption/cancellation. Pending -> DispatchStarted -> AwaitingCallback
-> CallbackStarted -> Delivered is one attempt. Withdrawn and UnknownOutcome
are terminal; uncertain/in-flight operations are never reset to Pending. A
retired parent cannot create a continuation. Children already derived from a
successful callback retain their own lifetime and original sender; cancellation
or uncertain outcome of any parent invalidates them.

The short synchronous dispatch/callback helpers try policy admission when
called with runtime held. Contention returns Deferred without mutation or
consumption. Caller-owned sender/session/attachment gates must already be held
in their established order; an explicit admission closure receives the original
sender. Native lifecycle locks are released before invoking the mutation so a
callback can derive a continuation; reservation and policy admission remain in
effect, and late success cannot overwrite cancellation's UnknownOutcome.
No guard crosses await and no unsafe Send implementation is used.

## Queue and restore boundary

The generic non-PTY queue stores a native operation sidecar keyed by seq AND
opaque queue operation ID. `PendingMessage` has manual serde to preserve the
existing Rust literal layout used by independently owned native stdio/tests.
Its serialized `provider_authority` is only Legacy, Local or NeedsOriginalCarrier.
New generic queue IDs reserve `provider-local:` and `provider-original:`
namespaces, allowing the durable requirement to remain part of the record
without adding a Rust field to those other constructors. IDs remain opaque
list/cancel tokens. A restored NeedsOriginalCarrier tag prefixes an untagged
ID; a conflicting Local/Legacy tag cannot downgrade an already required ID.
Nothing serialized contains a Permit or authorizes an association.

A generic dequeue moves its original OperationContext. Restoring a required
record without the native sidecar produces MissingRemote and withdraws before
adapter actions. Explicit Local and historical v1 records retain their original
privacy-ticket contract. A completing callback's collaboration TLS never
supplies missing authority. Cancel, queue-clear, Stop and engine retirement
remove exact entries and share cancellation with callback clones. The manager's
sidecar stores a weak runtime identity and is pruned on access and watcher
passes; it is not a process-global forever registry. This also preserves the
existing TabRuntime literal layout.

On admission contention the queue reinserts the same operation/ID and schedules
a wakeup outside runtime. That worker waits on policy with no runtime/session
or sender guards, drops that wakeup admission, then rechecks the original queue
operation. No ready token is carried into later dispatch.

The generic queue admission is NOT a physical-send authorization: all V2
provider entries remain blocked, including the drain. Local/v1 adapters retain
the legacy dispatch path. A physical native envelope currently has an explicit
refusal path until B/C provide reviewed writers. The opaque `ProviderAction`
wrapper lets those adapters carry a context without changing legacy Action
constructors or serializing authority.

## Callback/settings boundary

`apply_provider_envelope` is the explicit native callback entry. It validates
the original operation, current association and exact reply before mutation;
duplicates cannot consume an operation twice. Physical actions are refused.
Setting envelopes require a matching per-setting correlation and supported
exact settlement rather than calling a value-only report handler. The model
refusal additionally checks its existing model request ID. A stale/mismatched
request does not consume a newer same-value intent or unrelated local edit.
Unsupported callback forms remain refused pending adapter integration.

Settings model/effort/mode ingress wrappers capture current() once and pass
explicit original Permit/privacy parameters to native helpers. Callback owners
must call those explicit helpers, including None for Local, after operation
admission. Existing request-id -> original Configure Permit storage in session
remains authoritative. Restored collaboration requirements without those
original permits retain the existing withdrawal behavior. Legacy read-only
provider reports, SSE and value-report semantics are untouched; future SSE
association fencing and output-derived action attribution belong to C.

## Authored behavioral tests — all unrun

The helper's inline tests use actual native Permit checks, durable policy
fixtures, the real queue sidecar/serde, recording mutation closures, and channels
at prewrite/admission boundaries. Their focused names contain provider_authority:

- queue_originals_survive_unrelated_callback_tls
- serialized_requirement_withdraws_without_native_sidecar
- prewrite_barrier_rechecks_revision_generation_attachment_and_association
- old_association_callback_cannot_settle_replacement
- cancelled_opening_cannot_spawn_and_local_successor_proceeds
- setting_ack_requires_original_permit_and_exact_request
- explicit_association_does_not_upgrade_everyone_or_action
- callback_defers_policy_contention_without_holding_runtime_wait
- unknown_dispatch_and_queue_cancel_are_never_replayed
- local_preserves_independent_privacy_and_local_share_constraint
- wrong_approval_attempt_does_not_consume_new_deny
- callback_derives_original_follow_on_once_without_reentrant_lock

These are shared-boundary tests, not evidence of ACP pipe or HTTP wire safety.
The owned helper tests are authored but have not been compiled or executed.

## Remaining gates

A needs allocated focused compilation/testing with a positive test count and
lead review. No passing result, source collection or completion is claimed.
B must preserve contexts through actual ACP opening/stash/deferred/control and
per-chunk final pipe writes, retaining privacy barriers and exact partial-frame
cleanup. C must preserve contexts through HTTP/session fallback/retry/approval,
implement bounded cancellable physical dispatch, and fence launch/event-stream
callbacks. A precheck followed by today's blocking perform is not an atomic
writer, and revocation cannot retract bytes already dispatched. Native
mobile/local-share sender gates must be integrated before those envelope routes
can be used; the refusal paths intentionally do not bypass them.

Held/source-restoration paths outside the generic non-PTY queue remain outside
this slice (held.rs, handover producers, native stdio are separately owned).
Their existing contracts are not a newly supported remote provider route.
B/C real wire races, full restore-site audit, serialized final integration,
remaining native coverage and explicit lead acceptance must precede selective
entry-block removal. No endpoint, prepare/ack, capability, Everyone witness,
canonical refresh/Actor, physical-human assumption or adapter activation is
introduced here.

## D source-only continuation

D selectively ported this original A source before adding session-owned ACP
streaming and whole-batch callback integration. The additive owner-private
reserve_stream/StreamReservation/try_chunk/finish/try_confirm lifecycle preserves
A's original opaque OperationContext and sender gates; the one-shot try_dispatch
API remains for existing A tests/callers. See
[PHASE2-PROVIDER-INTEGRATION-D.md](PHASE2-PROVIDER-INTEGRATION-D.md) for concrete
signatures, queue handoff sealing, independent sender gates, exact mode/approval
settlement, root B prerequisites and ALL UNRUN D tests. This checkpoint does not
activate ACP/OpenCode V2 or supersede the held allocation/acceptance gates.

E source-only continuation consumes the same D nonclone reservation for actual
OpenCode NativeHttp final writes and whole-response callbacks. A session-private
association_current helper exposes only exact binding identity for post-callback
staging/retirement; retired is also a non-authorizing lifecycle read for
preparation cancellation. Neither grants physical or callback authority. See
PHASE2-PROVIDER-INTEGRATION-E.md for routing, thirteen UNRUN owner regressions and
remaining coverage. Public V2 blocks and unsupported Everyone remain retained;
no production availability or acceptance is asserted.
