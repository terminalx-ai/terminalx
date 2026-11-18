# PRO167 OpenCode C: dormant bounded writer, source only

This is a partial adapter integration, NOT provider availability or activation.
No C tests, build, compiler, formatter, hooks, verifier or doneChecks have run.
The focused command is UNRUN: fresh serial allocation plus the C grant are
required first. A's separate focused result is not C/integration acceptance.

Read the actual five-file A source in the root worktree
`phase-2-pro-120-orchestration-lead`, including `session_provider_authority.rs`
and `apply_provider_envelope`, rather than coding against the illustrative
contract names. This source-only worker remains on baseline 26080f13; it does
not copy A files outside C ownership. Integration must supply A first. Root's
CLAUDE.md and this worktree's CLAUDE.md were absent; the preserved source-ready,
internal carrier contract and coordinated contract were readable.

## What C supplies

`NativeHttp::from_envelope` consumes the actual A `ProviderAction` and keeps its
opaque original `OperationContext`. Neither the worker nor callback recaptures
TLS, constructs a Permit, or borrows a newer local caller. `NativeHttpReply`
returns that same original context, generation, tag and classified result.
Session-open, prompt, settings/control and approval HTTP actions use the same
carrier shape. The wrapper cannot be cloned to replay the exchange.

The physical loop uses the existing socket2 dependency, a nonblocking loopback
socket, 4096-byte maximum syscall chunks, 8 MiB payload/response limits and a 30-second
exchange deadline. Connect/read/capacity/defer waits own no admission guards.
Each attempted syscall is supplied synchronously to the owner's final gate;
there is no ready-token precheck followed by ureq. Actual byte count is taken
from the syscall, not from a gate's claimed count. Duplicate calls to the
one-use syscall closure retire the exchange as unknown. Revocation after a
partial write closes that socket; no remainder goes to another connection.
There is no network or uncertain-mutation replay or new-session fallback.

The `current` poll is for prompt cancellation and exact association/request
currentness during network waits, NOT authorization. Physical authorization is
still reacquired at EACH write through final admission. Read response waits
can cancel without holding policy/session/runtime locks. Reply framing is
conservative HTTP/1.0 or 1.1 with close delimiting and optional single exact
Content-Length. Transfer-Encoding, duplicate Content-Length, malformed or
partial response, read failure or cancelled post-send operation are UNKNOWN;
unsupported framing never selects another client or resubmits a mutation.

The final admission hook defaults to absent. `dispatch(None, ...)` withdraws
and returns Refused without opening a socket. It does NOT fall through to
legacy `perform`, produce a synthetic status=0 callback, or create follow-ons.
No unsafe Send or guards across await are used. This code is synchronous.

## Exact owner hooks still REQUIRED / UNIMPLEMENTED

1. Root must route original admitted queue/session-open/prompt/settings/approval
   operations into `ProviderAction`/`NativeHttp`; the legacy `Action::Http`
   worker remains the unchanged V1 path. It is not a V2 writer.
2. D now supplies an UNVALIDATED per-chunk lifecycle primitive (interface
   milestone below). Root still needs to bridge C's FinalWrite to that private
   reservation API. A's older `try_dispatch` consumes Pending -> DispatchStarted
   -> AwaitingCallback for ONE synchronous mutation and cannot re-admit the
   second chunk. The primitive remains intentionally unavailable to this harness:
   root must implement admission in the owner, without exposing fields or tokens.
   Required check: original operation/parent, exact correlation AND generation,
   native association/engine incarnation, original Permit action/source/revision/
   runtime generation/process epoch and attachment, privacy/mobile/local-share.
   Acquire short gates in existing lock order. Try contention returns Deferred
   with guards released. `current` is only a cancellation poll, not this hook.
3. Root must classify zero-write refusal versus post-write Unknown on the SAME
   operation lifecycle, and reserve exact once-only callback application under
   `try_callback`. Do not settle permission cards by tag alone; bind answer
   attempt separately from ask id. Do not settle a setting by equal value;
   bind original Configure and exact request id. `NativeHttpReply` deliberately
   has no method that directly calls legacy `settle_answer` or `handle`.
4. During an admitted opening/resume callback, derive follow-on original
   contexts with actual `derive_follow_on` BEFORE the parent becomes Delivered.
   This preserves the stash's original authority through permitted fallback
   and prompt. Never fallback on Unknown. A retired parent must not derive.
   C does not yet wrap the engine stash or automatically derive these contexts.
5. Root must install an exact native association/launch check around SSE reads
   and callback delivery, including a check immediately before emitting a line.
   Do NOT require an old prompt's Drive right for all output: independent local
   B output must remain visible after remote A revocation. Output-derived
   mutations need their exact original pending parent authority and request.
   The unchanged legacy pump is not a certificate of those V2 properties.
6. A callback sender gates currently explicitly refuse mobile/local-share;
   root must acquire those original independent gates before runtime, rather
   than drop them or apply Everyone owned-mode restrictions to explicit actors.

No owner hook is invented or bypassed here. All existing ACP/OpenCode V2
entry blocks, Everyone unsupported witness, capability advertisements and
V1/privacy behavior remain unchanged. This writer must remain dormant until
root integrates and validates every prerequisite. No server endpoint, ack,
public collab/2, dependency, installed client or service was added.

## Authored coverage, ALL UNRUN

The owned test file is included directly under the owned OpenCode module;
no outside test registration edit is needed. Ten focused tests use actual
TcpListener/TcpStream peers and inspect raw bytes (not provider field mirrors):

- original real Permit revoked at physical barrier -> zero observed bytes;
- partial syscall prefix then real revision/source change -> no remainder;
- deferred admission waits outside policy, retries original revoked Permit;
- explicit original Permit under unrelated Everyone TLS -> real correct body;
- cancellation while real peer holds response -> Unknown;
- actual truncated HTTP response -> Unknown, no fallback;
- unsupported destination -> refusal before physical gate;
- actual full TCP receive window -> observed WouldBlock, policy revision update
  completes outside guard, next physical attempt rejects original Permit.

These are physical transport and actual collaboration-policy regressions;
NOT an integrated native-context/callback/association proof. Native callback
identity/replacement races, direct-peer disconnect, runtime-generation change,
restored queues, stale settings/approval attempt, original stash/fallback,
read-only local B after A revocation, independent sender privacy/mobile/share,
and existing V1/privacy regressions remain UNIMPLEMENTED or UNRUN at C scope.
No exact test count/pass or full provider support is claimed.

## Interface handoff to shared integration owner D

D is sole owner of shared session/A helper/harness mod/settings. C does not edit
or copy any of those files. The following is a REQUESTED interface shape,
not a claim these functions already exist:

- Reserve exact original operation ONCE for a stream/exchange. Reservation
  prevents cloned envelopes from starting a second HTTP mutation, while leaving
  the SAME reserved operation eligible for repeated per-chunk validation.
- `try_http_chunk(&OperationContext, generation: u64,
  syscall: &mut dyn FnMut() -> io::Result<usize>) -> WriteAdmission` is the
  concrete shape already consumed by C's `FinalWrite` alias. Root's closure
  captures runtime/expected request handles; the original context is passed in
  for every invocation. Perform ordered try-admission and exact current request,
  correlation, association, incarnation, generation and independent sender
  checks; execute the syscall zero or one times. Deferred/Refused MUST call it
  zero times. Admitted MUST call it exactly once, even if it returns WouldBlock.
  Every guard drops before return. Do not transition to AwaitingCallback after
  the FIRST chunk; WouldBlock/partial progress stay on the reserved stream.
- `current(&OperationContext, generation: u64) -> bool` is C's separate
  cancellation/current-request/association poll at connect/write/read waits.
  It never grants physical admission or transitions the operation phase.
- Finish/retire exact reserved dispatch from `PhysicalOutcome`: Refused is
  zero-byte withdrawal; Unknown retires operation and blocks callback/derivation
  without automatic replay; Response enables the one exact callback batch.
- Admit the WHOLE response callback batch once with original context and exact
  request/association/generation, not once per emitted Action. Inside that
  batch, settle exact approval attempt/settings request and derive each opening
  -> prompt/fallback child before completing parent. Dispatch any child AFTER
  dropping callback/runtime/policy guards. This avoids both duplicate callbacks
  and trying to reconsume A's one-shot callback gate for each response action.
- For SSE, use an association/launch-only read gate, distinct from the prompt's
  context permission check. Resolve each output-derived mutation to its real
  exact pending operation before invoking any mutation callback batch.

The gate MUST NOT be implemented as a precheck, as `try_dispatch` wrapped around
blocking `perform`, or as independent one-shot contexts per chunk. This is the
same reserve-once/per-chunk/whole-batch prerequisite identified for ACP B.

D published additive source milestone (UNVALIDATED), read directly in D's owned
`session_provider_authority.rs`: `OperationContext::reserve_stream()` returns
nonclone `StreamReservation`; its `try_chunk(live, exactCorrelation, witness,
originalSenderCheck, syscall)` returns `(Attempt, Option<io::Result<usize>>)` and
retains DispatchStarted across partial/WouldBlock/Deferred. `finish` takes
`StreamOutcome::{Refused, Unknown, Response, Complete}`; Response enables the
whole callback batch, Complete delivers a no-response operation.
`OperationContext::stream_current(live)` is cancellation/association polling
ONLY. These functions are session-owner private, as required: C's existing
FinalWrite closure can map Applied+Some -> Admitted, Deferred -> Deferred,
Withdrawn/error -> Refused; C does not import or bypass owner methods. Root
still has to collect D and implement the OpenCode owner routing described above.

Two additional UNRUN wire regressions hold actual SSE connections across
revocation of a real old Drive Permit. They observe local B output still emitted
when the pump is live, and zero emit callbacks when that pump retires before the
held line is released. These cover transport-level read separation, not native
association/callback identity. C now
also checks `alive` immediately after a blocking event line read and before
emit. The actual root owner still supplies PID-only alive and unfenced on_line;
that MUST be replaced by exact native child/association/incarnation checks and
atomic callback currentness in the owner before any V2 support claim.

Lifecycle alignment with D: when a final hook is supplied, its owner holds the
nonclone stream reservation and MUST call `finish` on the returned classified
outcome before applying callbacks. C does not eagerly `withdraw()` that reserved
context: doing so would turn a known zero-byte connect/cancellation refusal into
UnknownOutcome before D can `finish(Refused)`. Reservation Drop retires on unwind.
The absent-hook path still immediately withdraws and refuses without a socket.
No callback/fallback is automatically applied by C in either path.
