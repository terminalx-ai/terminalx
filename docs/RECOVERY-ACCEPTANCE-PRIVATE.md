# Private #643 recovery overlay — partial, disarmed

Base: 3d73b0a40d29d5c55f22fdf89bd3de775d4bdc53. This derived source has
NOT been compiled or tested. Baseline439 results confer no overlay credit.

Only macOS debug desktop builds with `--cfg terminalx_recovery_acceptance`
compile the overlay. The owner has no desktop feature, so it contains no driver
or faults even if that cfg is mistakenly inherited. Ordinary builds contain
neither module, setup call nor fault/evidence methods. build.rs registers the
cfg name only; it does not enable it. Do not put the cfg in shared RUSTFLAGS;
a later separate desktop-only invocation needs review and source/tool pins.

Runtime identity must be exactly
`com.terminalx.next.dev.recovery643.private3d73b0a4`, with canonical root
`/Users/Shared/tx643-private-recovery-3d73b0a4`, HOME `<root>/home`, store
`<root>/state`, and `TERMINALX_RECOVERY_ACCEPTANCE=fixed-local-v1`.
These are NEW paths, not the prior baseline recipe's paths. No launcher/build
is authorized by this document. Output uses create_new,0600,O_NOFOLLOW at
`<root>/recovery-observations.jsonl`; existing evidence is never overwritten.

Implemented source:

- Fixed read-only main/floating observation of exactly one visible
  `textarea[data-composer]`, the notice, timeOrigin and two named storage keys.
  Main sentinel is `tx643-main-unsent`; floating sentinel is
  `tx643-floating-unsent`. No script/control endpoint or storage write.
- Listener-free private sink allocates an existing terminal_perf pending id.
  Eval is dispatched onto Tauri's event loop; only a separate named worker
  waits. Dispatch and reply share a three-second deadline. RAII zero-duration
  wait retires on every early return/unwind; normal wait removes the id on
  reply/timeout BEFORE validation. Late queued eval/reply cannot retain an id.
- R2 test drafts exercise delayed valid reply, timeout plus late reply,
  early drop (dispatch/destroyed-window analogue), invalid reply retirement
  and inability of a supplied receipt to arm faults. They are UNRUN.
- Fixed read-only owner status on the current Desktop's pinned client;
  only two local sessions in `<root>/fixture`, one claude fixture tab each.
  Native pane output/running/PID and canonical payload.user_message counts
  are recorded. This counts canonical messages, NOT transport sends/starts.
- Guarded EOF closes the real Bridge stream without intentional-detach flag;
  reader performs ordinary close/event. Current Desktop is resolved anew at
  EACH fault. The shared-reader variant does not revoke the owner. No lock is
  retained during GUI dispatch/wait. No new native/CLI/owner production RPC.

Concrete remaining prerequisite and deliberate stop:

The existing authenticated status and runtime.pty.output paths supply PID,
epoch and retained output, but no process start identity or fixture executable/
launch-count proof. Matching a claude harness string/private path does NOT
prove it is the no-account fake executable. The retained fixture does not emit
a source-bound start receipt. The canonical user_message count is not an
exact invocation counter. Therefore verify_fixture_provenance ALWAYS returns
an explicit GAP before issuing ANY fault. No receipt file or JSON flag can
bypass it. Native reads also retain existing120s control timeouts; only webview
observation has the new3s bound. This is not a complete bounded runtime packet.

The worker is one-shot on setup: missing/unready windows or fixture sentinels
stop, rather than polling/creating sessions. A future full scenario needs
reviewed fixture provisioning and an explicit ready trigger bound to actual
fixture identity. It must not resume or create a real provider session.

Remaining source needed, not pretended implemented: bind trusted disposable
fixture startup/PID-start/executable identity and exact send/start counters,
then implement the post-fault oracle comparing NEW output sequence, unchanged
PID/start/epoch, document change, restored draft and consumed checkpoint.
Only after this may the permit become constructible and main/shared/repeated
fault phases run. Saturated attempts=3 does not prove retry counts. Native
reconnect-count observation, per-window budget/manual fallback and clear/no-
resurrection phases are still gaps. No cloud fixture is supplied.

This partial code is retained for independent review rather than inventing
an unsafe identity interface or declaring a failed prerequisite a pass.
Neither the previous exact-source runtime recipe nor this overlay is ready
for live643 acceptance. All failures and merge/cleanup holds remain.
