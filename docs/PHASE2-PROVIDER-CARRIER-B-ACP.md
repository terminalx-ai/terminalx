# PRO167 ACP carrier B — source checkpoint, ALL UNRUN

This is disjoint adapter source, not activation, completion, compilation evidence,
or support for ACP collaboration. Only the adapter, a new unregistered session
ACP test file, and this document belong to B. No shared source was copied into
this worktree. No Cargo, rustc, test, build, formatter, verifier, install, commit,
hook, or doneCheck was run. The focused grant marker is not a current allocation.
An integrated A prerequisite, root-owned test registration, and a fresh explicit
serial slot plus marker are required before any later check.

Baseline: `26080f13d9b1e1426a3754ef2a5bb774f9aef312`. Read reference:
`~/phase2-orch/pro167-provider-continuation/B-A-interface-reference/manifest.json`.
That manifest records A helper SHA256
`d449ea8f0ff37e6e8426510e76ae91c0ddbb7cdeb892fc71b61694cb26180f76`,
shared harness `6044302df6a8a2819f5f5a609d21e3f246f781fa02bb0db36b8efbe032fcefd3`,
session `986322cbdf0f81aef66cefda714b62eb29da3d6933f89f7f161f3b4684ee9458`,
and settings `1a0eaa328778e40a4805a50748a05e953cfb32265bc1e20fc497e697a548007d`.
These are reference manifest values, not a B hash validation claim. Actual root
source at the `phase-2-pro-120-orchestration-lead` worktree was also read.
Root-reported `provider_authority: 12 passed, 0 failed, 0 ignored, 4495 filtered`
(`~/phase2-orch/wave6/provider-A-focused-cargo.log`) is A evidence only; B has not
run or independently reproduced that result.

## Adapter surface and attribution

The adapter imports actual A `OperationContext` / `Correlation` and shared
`ProviderAction`. It does not construct a SenderAuthority, Permit, binding, or
operation. It preserves native opaque clones and uses available
`derive_follow_on`; no visibility widening, copied authority, serde carrier,
callback TLS capture, permit remint, or Drive-to-Configure/Approve conversion.
The baseline without integrated A cannot compile these imports.

`start_carried` retains the original stashed prompt and derives exact numeric
request correlations through initialize/authenticate/load/new. Load failure uses
the admitted load callback as parent of its new-session fallback. `prompt_carried`
uses its own explicit ingress context. A second opening is refused: the manager
must keep successors in A's per-item queue. After a revoked/retired opening,
retire the original association and start the queued Local/remote successor
with that item's own context on a fresh association. Never fall back to legacy
`handle` for a missing response carrier. This avoids replaying initialize or
borrowing a retired opening for an independent Local prompt.

`retain_setting`, `set_model_carried`, and `set_mode_carried` keep separately
admitted Configure contexts. Wire correlation retains the native pending
settings request ID AND numeric ACP adapter request. The legacy model-refusal
request ID remains in Pending/Action and is a third, independent identity.
Opening-generated model/mode writes without their own Configure context are
suppressed and removed from pending; Drive never upgrades itself. Launch
configuration itself still needs the root's separately captured Configure
provenance: these adapter hooks do not authorize process launch defaults.

`response_context` peeks without consuming adapter state.
`handle_carried_response` accepts that exact operation/request and derives
follow-ons while the owner is inside its one admitted callback closure. Settings
success becomes exact model Accepted rather than a value-only Current settlement.
A mode ACK has no generic Setting enum variant: root must settle the exact mode
request from the admitted correlation and parsed success, described below.
Errors retain the exact legacy model-refusal ID. Replacing a retained setting
withdraws its older operation, invalidating already-derived/deferred writes.
`retire_request` removes only the exact denied request/operation; settings
retirement does not clear an unrelated prompt timer.

`answer_carried` retains the ask until physical delivery, including provider
request ID and the separately admitted answer-attempt operation. A newer answer
withdraws the older one. `answer_current` / `answer_delivered` require exact
operation identity; a stale allow cannot settle a newer deny. A repeated inbound
ask invalidates any older retained answer. There is no physical-human assertion.
`interrupt_carried` requires an explicit Control correlation; native Stop remains
owner cancellation. `defer_carried` / `take_deferred_carried` move the entire
native envelope, separate from the legacy privacy tuple queue. Never unwrap a
carried action into that legacy queue or recapture authority on wakeup.

`withdraw_input` withdraws opening/prompt carriers only, preserving independent
settings/approval work. `withdraw_carriers` is the full Stop/association-retirement
hook. Owner cleanup must call it before replacing/dropping an ACP engine and
withdraw any already-taken envelopes too. Registries are per-engine; requests
are consumed on admitted reply or exact retirement, settings are replaced per
key, answers are retired per attempt, and Stop drops remaining sidecars.

## Root session-owner additions required; B does not implement them

All listed edits belong to root/shared ownership, not this diff. Keep A's
constructors, `try_dispatch`, `try_callback`, sender gates and binding ownership
session-private. No new adapter constructor or broad pub(crate) admission API
is needed.

1. Integrate the actual A helper, session registration, harness ProviderAction,
   and settings helpers first. Register tests DIRECTLY at session module scope:

   ```rust
   #[cfg(test)]
   #[path = "session_acp_collaboration_tests.rs"]
   mod provider_acp_collaboration;
   ```

   No lib.rs edit. The focused filter is `provider_acp_collaboration`. The tests
   need session's existing pub(super) access to A; do not nest them under an
   adapter module or widen constructors to make them accessible.

2. At synchronous send ingress and `drain_provider_queue`, move A's ORIGINAL
   queue context into `start_carried` / `prompt_carried`; direct sends must also
   capture before scheduling. `provider_binding(rt)` owns the native weak
   LiveChild, child epoch and engine incarnation. Preserve privacy, mobile and
   share independently from original ingress. Explicit Local means only no
   collaboration permit. Do not infer Local from a lost sidecar. Continue
   A's NeedsOriginalCarrier restore refusal. Existing associated/adopted routes
   are not subject to a new blanket owned/safe-mode requirement; A has no
   production adopted ACP route to activate here.

3. `prepare_acp_opening_settings`, setting ingress and stopped/launch settings
   must construct Configure contexts from the exact current native settings
   ID and `rt.collaboration_settings[id]`, not the opening Drive permit or TLS.
   Preserve original privacy/mobile/share gates as well. Retain each context
   before opening emits settings. Local defaults also need explicit Local
   Configure contexts when they generate an ACP mutation. Existing pending
   settings provenance and launch authorization still apply independently.

4. In `on_line_from`, first verify the reader's captured exact child/epoch and
   engine incarnation, including requests/notifications without response IDs.
   For a response, peek `response_context`, acquire original gates in the
   established order, recheck adapter `request_current`, and call
   `context.try_callback` ONCE for the whole batch. INSIDE that closure invoke
   `handle_carried_response`, apply exact metadata/settings mutations and stage
   returned follow-on envelopes. On Deferred leave the response and all native
   state intact for retry outside runtime. On Withdrawn call `retire_request`;
   for a failed opening retire the old association/input before a successor.
   Schedule physical follow-ons only after all owner locks have been dropped.
   Do not feed each result separately through A's current
   `apply_provider_envelope`: it consumes the callback once per action and
   currently refuses physical writes. Do not call `handle` first and then try
   to authorize the mutations it has already performed.

5. Add exact settlement in the admitted callback batch: Settings
   `collaboration_requests()[setting] == request_id`; model refusals additionally
   require `model_request_id() == legacy_model_request`. Success calls
   `settle_provider_request` for that ID only. For mode, parsed ACK success plus
   exact mode correlation settles that pending mode ID; there is no
   `Setting::Mode` and no current A mode callback envelope support. A no-wire
   `AcpMode { line: None }` confirmation requires a separately admitted exact
   Configure settlement; it is not a free callback on a Pending context. Late
   Current reports may describe provider reality but cannot settle a newer
   same-value intent. Read-only provider output and new permission asks use
   current association admission, not the previous remote prompt's Drive permit.
   Existing provider-origin fs request handling must stay behind its existing
   owner rules; the carried response entry explicitly rejects provider requests.

6. For approvals construct a NEW Approve context per answer attempt from its
   own original native approval permit. Before every physical chunk recheck
   `answer_current`, then on successful delivery call `answer_delivered` once
   under exact original admission. Interrupted/unknown attempts never consume a
   newer answer. For controls retain their original Control context through
   `defer_carried` even if another prompt owns the pipe at wakeup.

## Physical writer support and remaining lifecycle gap

`write_carried_frame` captures an Arc<LiveChild>, serializes one newline frame
with that child's existing `input_frame`, and calls an owner-provided short
nonblocking chunk closure. The owner MUST invoke this support on the writer
thread outside policy/session/runtime/sender locks. The frame mutex may span
chunks. Capacity/Deferred waits occur only after the closure returns and every
admission/runtime/sender/attachment guard has been released. A stall is bounded
at five seconds without progress. The owner wait closure must yield/sleep with
no admission guards; cancellation may wake it early.

The owner chunk closure must acquire gates in established order (policy before
session, then original sender/share/mobile/attachment, then runtime), obtain a
current binding, and verify original context, exact child Arc+epoch/incarnation,
adapter numeric request, pending settings ID or approval attempt as applicable,
and non-stopping/current state immediately before ONE `try_write_stdin`. It
returns Written/Capacity/Deferred/Withdrawn only after releasing gates. Never
substitute a PID, cached Ready token, successful earlier precheck, callback TLS,
or a new permit. Independently enforce EVERY original privacy/share/mobile
constraint, and preserve the existing privacy acknowledgment/cleanup ordering.

A's current `try_dispatch` is one-shot Pending -> AwaitingCallback. It cannot
wrap a whole blocking frame or be called again for every chunk of the same
context. Root must add a reviewed session-owned streaming lifecycle operation:
reserve the exact frame attempt once; check the SAME original operation during
each short physical syscall; leave it in DispatchStarted across capacity waits
without keeping guards; transition to AwaitingCallback only after the entire
newline reaches the original pipe (or terminal delivered for no-response
control/approval). Denial/cancel/partial failure is terminal Withdrawn or
UnknownOutcome, never reset/replayed. No API for this exists in actual A yet.
The blocked-wire test demonstrates a constrained current-A alternative using
short children derived from the same parent per syscall; it does not implement
or validate that production streaming lifecycle or its final callback commit.

On any error after partial progress, adapter support withdraws the context and
closes ONLY its captured original stdin. Root must retire only that original
association/prompt, preserve a replacement and its Local successor, publish
withdrawal with correct delivery uncertainty, and perform privacy cleanup before
acknowledgment. Successful prompt delivery must call `delivered(id)` and publish
PromptWrite.started/ModelRequestStarted exactly once under final original
admission; follow-on draining must use each queued context independently.
The manager's existing `write_acp_prompt` and deferred tuple path remain legacy;
this adapter source alone does not connect or repair their final admission.

## Authored regressions — ALL UNRUN

The dedicated file uses Host::spawn, real Python subprocess stdin/stdout,
LiveChild nonblocking writes, actual A native contexts and real V2 policy.
Barriers pause actual replies or stop the child reading until its pipe fills.
No type mirror or reimplemented admission predicate stands in for A. Tests
construct their own policies/native associations as session-owned test code;
production adapter code cannot construct them.

- `provider_acp_collaboration_explicit_wire_auth_load_fallback_stash_and_no_drive_upgrade`
- `provider_acp_collaboration_everyone_denied_before_real_pipe_and_local_successor_keeps_local`
- `provider_acp_collaboration_real_opening_barriers_revision_generation_disconnect_stop`
- `provider_acp_collaboration_wire_same_value_setting_ids_mode_and_deferred_originals`
- `provider_acp_collaboration_real_approval_new_deny_survives_old_allow_attempt`
- `provider_acp_collaboration_blocked_partial_pipe_revocation_stop_replacement_original_only`
- `provider_acp_collaboration_old_real_child_callback_cannot_write_replacement`
- `provider_acp_collaboration_frame_wait_revocation_has_no_admission_lock_or_bytes`
- `provider_acp_collaboration_explicit_local_keeps_privacy_and_share_denials_on_real_pipe`

These are source-authored regression cases, not manager integration evidence.
Small fixture frames use A's one-shot dispatch around exactly one nonblocking
syscall, with frame acquisition outside admission. Partial cases exercise the
adapter's physical support and explicitly described per-chunk test glue. Source
has not been compiled; further interface/type/fixture corrections may be needed
once root registers the file and obtains the fresh serial check slot.

ACP/OpenCode V2 entry blocks, Everyone witness restrictions, capability ads,
endpoints, physical-human semantics, and separate local-sharing by-hand denial
remain unchanged. No native partial-frame patch, UI, SaaS, cloud, Admin, shared
A source or Cworker edits occur here. Full gates and review are outstanding;
there is no acceptance claim.
