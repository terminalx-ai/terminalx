# Dormant compaction Admission bridge: proposed publication boundary

Status: source proposal, not an implemented adapter or approved live transport.
Baseline: `571a7195cbd169f2ef1597e17fcc853f4a3811c6` (J1 accepted).
The existing journal and transport drafts remain unexecuted. No provider,
SessionManager publisher, reader, UI or default PTY behavior changes here.

## Why the current APIs are insufficient for a direct bridge

`Journal::commit` releases the stable storage transaction lock before returning
its receipt. `Journal::begin` on another handle can then persist a new backend
generation before the first caller emits. A bridge-local mutex serializes only
that bridge: it does not fence the second handle/process. A separate generation
check after commit has the same check-to-emission window. The storage receipt
is still valid historical evidence; it is not current ownership authorization.

`Journal::snapshot` likewise returns after releasing that lock. It supplies a
watermark, not an atomic subscriber-registration boundary. Subscribe/buffer
before snapshot can address missing updates, but still requires explicit epoch
fencing and an ordered publication owner; simply adding a listener afterward
can miss the first post-snapshot commit.

`Admission::accept` runs inside the transport's ownership mutex and forbids
reentry. `EventSink::emit_raw` returns unit, and `BroadcastSink::emit_raw`
synchronously calls arbitrary listeners before sending its broadcast message.
A listener requesting a transport status/snapshot can reenter a held gate.
Thus calling the existing sink directly from Admission cannot serve as a safe
ordered delivery acknowledgement. Moving that call outside the gate removes
the immediate reentry problem but loses the ownership/publication ordering.

These are concrete boundary gaps, not evidence that a bridge is impossible.
They require a small supporting API and an explicit subscriber contract before
claiming the requested bridge. Do not weaken them with undocumented single-owner
assumptions or describe a plain `commit(); emit()` wrapper as authoritative.

## Smallest proposed supporting API change

Extend the existing batch journal, retaining its current methods and J1 checks.
Provide internal ordered variants which invoke a **nonblocking enqueue-only**
callback after successful replacement and before releasing the transaction
lock. Provide an analogous snapshot callback under that same lock. Factor the
existing implementation rather than reacquiring the lock around public methods:
`store::transaction` explicitly refuses nested transactions.

Illustrative signatures for review, not implemented declarations:

```rust
// Pre-commit failure is Err. Post-commit enqueue failure retains the receipt.
struct Accepted<T> {
    receipt: Batch<T>,
    publication: Result<(), PublicationFailure>,
}

fn commit_ordered(
    &mut self,
    changes: Vec<T>,
    enqueue: impl FnOnce(&Batch<T>) -> Result<(), PublicationFailure>,
) -> Result<Accepted<T>>;

fn snapshot_ordered<R>(
    &mut self,
    install: impl FnOnce(&Snapshot<T>) -> R,
) -> Result<R>;
```

The callback must not call EventSink, user handlers, transport, store operations
or a blocking send. Use an owned bounded queue from existing channel facilities;
no new dependency or generic event framework. Queue-full/disconnected is a
distinct post-commit publication failure, never an append failure or permission
to replay the provider request. If a callback panics after replacement, the
coordinator must become unusable/degraded and recover only from the journal;
it must not roll back a committed record. A separate result prevents conflating
“accepted, delivery unavailable” with “not persisted.”

The existing commit API can retain its return contract via an internal no-op
publication closure. The existing snapshot API can retain its owning result.
The precise private helper split and panic boundary require source review;
the signatures alone do not provide either implementation or validation.

Lock order: transport ownership gate -> bridge state gate -> journal transaction
-> existing atomic-writer lock. Only nonblocking queue insertion may occur
before unwinding those locks. Reader subscription takes bridge state then the
journal transaction; it never takes the transport gate. Delivery handlers run
after all these gates are released.

## Typed mapping using the existing lifecycle model

Reuse transport Owner/Scope/Observation identity and the portable reducer's
normalized evidence vocabulary. Do not create an independent Rust state machine
with subtly different completion precedence. Define a concrete derived-Serde
journal change type, not arbitrary Value or a custom serializer. A normalized
evidence snapshot can be folded by the existing portable reducer; a future
backend state projection needs a separately reviewed shared representation.

Distinguish three identities:

- Backend generation B: the accepted persistent journal owner barrier.
- Launch fence L: the existing transport's process-local token, valid only in
  this adapter instance and B. Never use L alone as a durable generation.
- Connection generation C: the journal sequence of the accepted Bound batch,
  scoped by the stable session/tab/conversation/thread/subagent identity. This
  is monotonically ordered across same-backend replacements and restarts.

Retain the binding mapping `(B, owner, L) -> (scope, C)` only after acceptance.
The journal header's generation must equal B for every admission. On replay,
reconstruct the mapping from accepted typed Bound records, not live callbacks.
Enforce the portable schema's safe-integer boundary when exporting numbers;
never silently narrow arbitrary u64 values or use timestamps as watermarks.

Bound must validate `replaces` against the currently accepted binding. One
journal batch contains old-scope continuity loss and new binding; projection
cannot expose only half. Item start/completion retain exact turn/item IDs and
map through C. Exit/release close continuity for that binding without changing
completion evidence. Retry/error/terminal signals remain turn-scoped. Starts
after a gap stay refused; buffered completion is admitted only as allowed by
the existing sink. History reconciliation is a separate authorized input.

A restart barrier makes all unfinished older-generation bindings unknown while
retaining completed evidence. It must never silently restore a running flag.
Reopening a viewer subscribes to the existing owner; it never calls begin,
launches a provider, resumes a thread or resends a prompt.

## Snapshot and subscriber contract to implement with the bridge

One backend coordinator owns the adapter, typed journal and subscriber registry
for the chosen journal namespace. Explicit owner transfer must fence the old
stream before installing a replacement; a journal-generation check is not a
substitute for physical process ownership. The existing activity collector has
a lifetime file-lease precedent, but it is private and not currently a reusable
compaction-owner API. Do not steal or reuse its stats lock.

Subscribe under the bridge gate, buffer before reading, and install a snapshot
at watermark W through the ordered snapshot boundary. Drop buffered records at
or below W and deliver later whole batches in sequence. Frames carry B, C where
applicable, watermark and stream identity. A consumer cannot accept an old
stream's frame after adopting a new owner's snapshot. If the queue overflows,
closes or has a sequence gap, stop continuous projection and require a new
snapshot; never silently skip a lifecycle frame.

Journal failure returns Admission Err and latches degraded continuity for both
the prior and proposed scopes, without advancing the committed watermark.
Publish that degradation as an explicitly volatile control state, not a fake
durable journal event. If even that notification cannot be queued, invalidate
the subscription; its API must expose loss as unknown. Restart synthesizes
unknown from the old generation rather than relying on a failed control write.
Post-commit publication failure preserves the receipt and authoritative replay,
but reports unavailable continuity until resynchronization. No provider action
is a recovery mechanism for notification delivery.

## Bounded next diff and discriminating regression drafts

First review the ordered journal callback/result boundary and subscription
ownership contract. A subsequent implementation can then be limited to:

1. `store/batch_journal.rs`: ordered internal commit/snapshot operations;
   preserve the twelve existing journal drafts and J1 validation.
2. `harness/codex/owned_transport.rs`: only concrete serialization/type support
   if needed; preserve the twelve transport drafts and default path.
3. A dormant typed admission module and narrowly scoped boundary drafts, with
   its module declaration. No Engine launch path or legacy publisher rewrite.
4. A portable projection adapter only if required to fold authoritative evidence
   with the existing reducer; do not edit its historical thirteen-test bytes.

Draft schedules, not tests already added or run:

- Commit start, pause at the ordered enqueue boundary, attempt a second begin:
  its barrier cannot pass the first enqueue. The old `commit(); emit()` wrapper
  admits the opposite schedule and is the negative reference.
- Force the real atomic writer to fail on a replacement: no committed success,
  unchanged W, both affected scopes unknown/degraded, no prompt/provider retry.
- Commit successfully, reject enqueue: the result retains a replayable receipt
  and reports publication loss rather than an uncommitted transaction.
- Register/buffer, snapshot at W, commit the next batch: the subscriber sees
  exactly the snapshot prefix plus later batches, or an explicit resync state.
- Restart with launch L reused: new B/C reject the old callback and old stream;
  unfinished work is unknown while positive completed evidence is retained.
- Deliver exit before buffered start/completion: only completion may reconcile
  under the existing transport rule. Subagent/turn/item scopes stay separate.

None authorizes an execution matrix. Retain trusted private paths, stable
sidecars, 8 MiB journal limit, no parent-directory fsync/power-loss promise,
non-universal serializer semantics and existing native-lane requirements.
The ordered callback alone does not complete the bridge or guarantee delivery.
