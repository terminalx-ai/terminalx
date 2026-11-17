# PRO-167 final writer continuation (verification held)

This source continuation starts at `26080f13d9b1e1426a3754ef2a5bb774f9aef312`.
The two actual changed source files from the preserved
`codex-frame-pro167-native-codex-partial` worktree were copied selectively;
that worktree and the saved `~/phase2-orch/wave6/codex-frame-preserved*`
artifacts remain untouched. No other worktree or historical checkpoint was reset.

## Native Codex

The dedicated FIFO worker remains the sole frame writer. Each Delivery captures
its original collaboration permit at enqueue. Prompt deliveries take that permit
from their original Authority, including an explicit absence for local input;
they do not inherit the caller that happens to dispatch a queued successor.
Non-prompt controls capture the initiating caller's permit, or the existing
startup permit for asynchronous initialization. ThreadReady clears that startup
permit as before. The physical writer never reads collaboration TLS or wraps a
frame in another caller's TLS.

Each physical nonblocking attempt acquires collaboration admission, checks the
original permit against the current runtime witness, verifies frame validity,
selected tab, engine launch, exact original child Arc and the Host's current
child, and performs one syscall. The witness still enforces owned safe current
and pending modes only for Everyone-derived Drive. Actor, source, revision,
generation, epoch and native attachment are retained in the original permit;
Everyone input cannot become explicit when a newer member map arrives.

All per-attempt policy/runtime locks drop before sleeping for stdin capacity,
including when a prefix has already reached the pipe. The independent privacy
lease retains its previous whole-frame lifetime. Mobile/share/owner attachment
checks retain their existing first-byte admission and lock ordering.

After partial delivery, invalid authority, mode, frame validity, cancellation,
child association or launch is an uncertain frame failure. It cannot take the
unsent-withdrawal path or finish a JSON suffix under new authority. The original
child's stdin is closed and its original PID/group uses existing Host retirement.
Only a matching engine launch AND child Arc receives runtime failure handling.
Queued unsent successors and their authorities survive this frame's retirement.
A typed error prevents the outer worker from applying generic tab failure a
second time to a successor. The worker exits; no uncertain frame is replayed.

## Raw PTY

The original input Arc and owned group are captured with the expected PID before
waiting for the input mutex. That mutex remains held for the complete write and
flush, preserving frame order. Classification of legacy/v2 happens under policy
admission, so the first v2 installation cannot race a legacy classification.

V2 raw input, including explicit Configure, uses a separate admitted-attempt
loop. Every write and flush retry reacquires the original permit and checks its
peer, PID, exact input Arc, exact owned group and liveness while keeping the pane
map stable through that nonblocking syscall. Capacity polling owns no policy
admission. Polling uses short slices so revocation is observed even if an old
pipe stays full. The privacy lease remains independent and held as before.

A partial error removes only the matching original pane and signals only its
captured owned group; a reused pane ID cannot redirect the remaining bytes or
retire a replacement. There is no automatic uncertain replay. Explicit/implicit
actors acquire no new Everyone-only mode requirement. The legacy Input::write
implementation, including its original write/flush behavior, is unchanged.

## Authored regressions — UNRUN

`phase2_collaboration_v2_native_partial_capacity_wait_rechecks_and_retires_only_original_launch`
uses a real child that initially reads nothing and a real JSON request larger
than pipe capacity. Its barrier runs only after actual partial progress followed
by WouldBlock, outside the writer locks. Another thread must complete revision,
Everyone-to-explicit source, generation, native disconnect, pending-mode,
current-report, Stop or replacement changes while stdin remains undrained.
Rejected frames must write exactly the byte count recorded at that barrier.
The replacement's independent active local request stays unconsumed; an unsent
local queued successor also stays queued. Valid Everyone, explicit, implicit and
v1 controls release the child and compare the exact complete single frame.
Explicit/implicit controls change to unsafe pending mode and an unknown report
to guard their existing independent semantics.
`phase2_collaboration_v2_native_queued_local_frame_does_not_borrow_dispatcher_tls`
checks the actual enqueue and real child writer under stale unrelated caller TLS.

The inline `pty.rs` tests
`phase2_collaboration_v2_raw_configure_releases_admission_after_partial_write_and_flush`
and
`phase2_collaboration_v2_raw_real_full_pipe_rechecks_explicit_permit_and_valid_retry`
exercise the actual remote writer. A fake nonblocking writer forces a prefix,
WouldBlock and flush WouldBlock with exact byte accounting; a real raw PTY
forces actual progress and full input capacity. They cover revision, provenance,
generation, observed attachment disconnect, replacement launch, valid retries,
flush retries and legacy behavior. Policy replacement must finish on a separate
thread before the real child is released. Existing empty-write, mobile/share and
real v1 writer regressions are retained.

No test, build, typecheck, install, verifier or hook was run for this continuation.
The required serial cargo filter remains UNRUN pending fresh explicit allocation
and `~/phase2-orch/wave6-final-writers-checks-granted`.
This is source readiness, not verified native acceptance or provider availability.
Production v2 advertisements remain OFF; no ACP/OpenCode activation is included.

## Outside ownership

`docs/PHASE2-COLLABORATION-V2.md` still describes the old Codex full-frame policy
lease. Its owner should reconcile that paragraph after validation; this worker
is not authorized to edit it. Shared session, harness, remote and host sources
were inspected only. Existing Host PID/group termination and lifecycle cleanup
are reused; no broader process-identity redesign is claimed here.
