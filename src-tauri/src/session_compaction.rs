//! Scoped admission into the existing AgentEvent log. No producer is enabled.
//! This is callback identity, not a second provider owner or physical lease.
use super::*;

const MAX_SAFE_SEQUENCE: u64 = (1_u64 << 53) - 1;

#[derive(Default)]
pub(super) struct Admission {
    owners: HashMap<CompactionScope, Owner>,
    degraded: bool,
}
#[derive(Clone)]
struct Owner {
    tail: Arc<tui::Tail>,
    launch: u64,
    connection: u64,
}

/// Only a current runtime/launch can mint this token. No provider contract is
/// inferred from the existence of a token or from a schema's item_started.
pub(crate) struct Token {
    runtime: std::sync::Weak<Mutex<TabRuntime>>,
    scope: CompactionScope,
    owner: Owner,
}
impl Token {
    pub(crate) fn generation(&self) -> u64 { self.owner.connection }
}

/// Uncertain is not rejection-before-write: append may have partially succeeded.
/// Never retry provider input on either outcome. Reconcile history instead.
pub(crate) enum Publication { Committed(AgentEvent), Uncertain(AgentEvent) }

fn current(rt: &TabRuntime, scope: &CompactionScope, owner: &Owner) -> bool {
    if scope.session_id != rt.session_id || scope.tab_id != rt.tab_id || scope.provider != rt.harness { return false; }
    if !matches!(&rt.engine, Engine::Cli(cli) if cli.generation == owner.launch && Arc::ptr_eq(&cli.tail, &owner.tail)) { return false; }
    index::get(&rt.session_id).ok().and_then(|entry| entry.tab(&rt.tab_id).map(|tab| {
        tab.follow.conversation == scope.conversation_id && tab.provider_session_id.as_deref() == Some(scope.thread_id.as_str())
    })).unwrap_or(false)
}

fn generation(observation: &CompactionObservation) -> Option<u64> {
    match observation {
        CompactionObservation::ConnectionOpened { generation }
        | CompactionObservation::ContinuityLost { generation, .. }
        | CompactionObservation::ItemStarted { generation, .. }
        | CompactionObservation::ItemCompleted { generation, .. }
        | CompactionObservation::TurnError { generation, .. }
        | CompactionObservation::TurnEnded { generation, .. } => Some(*generation),
        CompactionObservation::CompletionReconciled { .. } => None,
    }
}

fn stamp(rt: &mut TabRuntime, evidence: CompactionEvidence, confirmed_start: bool, persisted: bool) -> AgentEvent {
    rt.seq += 1;
    AgentEvent {
        id: uuid::Uuid::now_v7().to_string(), session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(), harness: rt.harness.clone(),
        seq: rt.seq, ts: index::now(), message_ts: None,
        subagent: evidence.scope.subagent_id.clone().map(|id| SubagentRef { id, label: None }),
        payload: Payload::ContextCompactionLifecycle { evidence, confirmed_start, persisted },
    }
}

impl SessionManager {
    /// Future verified producer entry. Binding itself never confirms compaction.
    /// Generation comes from the serialized tab log sequence, not a local launch
    /// counter. The old connection loses continuity before replacement opens.
    pub(crate) fn bind_compaction(&self, scope: CompactionScope, tail: Arc<tui::Tail>, launch: u64) -> Result<Token> {
        let runtime = self.runtime(&scope.session_id, &scope.tab_id)?;
        let mut rt = runtime.lock().unwrap();
        let mut owner = Owner { tail, launch, connection: 0 };
        anyhow::ensure!(current(&rt, &scope, &owner), "compaction owner is no longer current");
        anyhow::ensure!(!rt.compaction.degraded, "compaction publication is uncertain");
        if let Some(old) = rt.compaction.owners.remove(&scope) {
            let evidence = CompactionEvidence { scope: scope.clone(), observation: CompactionObservation::ContinuityLost { generation: old.connection, reason: CompactionLoss::Restarted } };
            anyhow::ensure!(matches!(self.commit_compaction(&mut rt, evidence, false)?, Publication::Committed(_)), "compaction replacement append uncertain");
        }
        // Reconcile an earlier backend's open connections before a new binding.
        let mut history = store::read_lines(&rt.log_path)?;
        self.reconcile_compactions(&mut rt, &mut history)?;
        anyhow::ensure!(!rt.compaction.degraded, "compaction reconciliation uncertain");
        owner.connection = rt.seq.checked_add(1).context("compaction sequence exhausted")?;
        let evidence = CompactionEvidence { scope: scope.clone(), observation: CompactionObservation::ConnectionOpened { generation: owner.connection } };
        anyhow::ensure!(matches!(self.commit_compaction(&mut rt, evidence, false)?, Publication::Committed(_)), "compaction binding append uncertain");
        rt.compaction.owners.insert(scope.clone(), owner.clone());
        Ok(Token { runtime: Arc::downgrade(&runtime), scope, owner })
    }

    /// Called only for evidence authenticated by a supported current producer.
    /// confirmed_start means verified after-gates work, never /compact/pre-hook.
    /// CompletionReconciled requires positive source history, not a busy status.
    pub(crate) fn publish_compaction(&self, token: &Token, observation: CompactionObservation, confirmed_start: bool) -> Result<Publication> {
        let runtime = self.runtime(&token.scope.session_id, &token.scope.tab_id)?;
        anyhow::ensure!(token.runtime.upgrade().is_some_and(|old| Arc::ptr_eq(&old, &runtime)), "stale compaction runtime");
        let mut rt = runtime.lock().unwrap();
        let lost = matches!(observation, CompactionObservation::ContinuityLost { .. });
        // A departing owner may retire only its own still-bound connection,
        // even after the engine has already removed its physical launch.
        anyhow::ensure!(lost || current(&rt, &token.scope, &token.owner), "stale compaction launch/scope");
        anyhow::ensure!(!rt.compaction.degraded, "compaction publication is uncertain; do not retry provider input");
        anyhow::ensure!(rt.compaction.owners.get(&token.scope).is_some_and(|owner| owner.connection == token.owner.connection), "stale compaction connection");
        anyhow::ensure!(!matches!(observation, CompactionObservation::ConnectionOpened { .. }), "binding owns connection admission");
        anyhow::ensure!(generation(&observation).is_none_or(|g| g == token.owner.connection), "wrong compaction generation");
        anyhow::ensure!(!matches!(observation, CompactionObservation::ItemStarted { .. }) || confirmed_start, "start is not confirmed after provider gates");
        let result = self.commit_compaction(&mut rt, CompactionEvidence { scope: token.scope.clone(), observation }, confirmed_start)?;
        if lost { rt.compaction.owners.remove(&token.scope); }
        Ok(result)
    }

    /// A narrow append-result path, leaving legacy publication semantics alone.
    /// Same runtime lock orders append and fanout as the existing manager. Store
    /// append is not fsync/atomic replacement: no power-loss durability claim.
    fn commit_compaction(&self, rt: &mut TabRuntime, evidence: CompactionEvidence, confirmed_start: bool) -> Result<Publication> {
        anyhow::ensure!(rt.seq <= MAX_SAFE_SEQUENCE - 2, "compaction sequence exceeds portable safe integer");
        let fallback_generation = generation(&evidence.observation).or_else(|| rt.compaction.owners.get(&evidence.scope).map(|o| o.connection)).context("missing compaction connection")?;
        let scope = evidence.scope.clone();
        let event = stamp(rt, evidence, confirmed_start, true);
        let appended = if rt.compaction.degraded { Err(anyhow!("compaction continuity already uncertain")) } else {
            (|| -> Result<()> {
                // A failed old append must not join a new record onto its tail.
                match std::fs::read(&rt.log_path) {
                    Ok(bytes) => anyhow::ensure!(bytes.is_empty() || bytes.last() == Some(&b'\n'), "incomplete event log tail"),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                    Err(e) => return Err(e.into()),
                }
                store::append_line(&rt.log_path, &serde_json::to_string(&event)?)
            })()
        };
        let (event, committed) = match appended {
            Ok(()) => (event, true),
            Err(error) => {
                log::error!("compaction append uncertain: {error:#}");
                rt.compaction.degraded = true;
                // Never fan out an optimistic success after an append error.
                let loss = CompactionEvidence { scope, observation: CompactionObservation::ContinuityLost { generation: fallback_generation, reason: CompactionLoss::Disconnected } };
                (stamp(rt, loss, false, false), false)
            }
        };
        self.observer.agent_event(&event);
        self.sink.emit("agent_event", &event);
        Ok(if committed { Publication::Committed(event) } else { Publication::Uncertain(event) })
    }

    /// Existing load/reconnect path: read under the same gate as admission.
    /// No second snapshot or provider action. Loss is appended before returning
    /// the history; on append failure the returned/fanned-out loss is explicitly
    /// uncertain and the runtime refuses further positive publication.
    pub(super) fn reconcile_compactions(&self, rt: &mut TabRuntime, events: &mut Vec<AgentEvent>) -> Result<()> {
        if !events.iter().any(|e| matches!(e.payload, Payload::ContextCompactionLifecycle { .. })) { return Ok(()); }
        let mut open = HashMap::new();
        for event in events.iter() {
            if let Payload::ContextCompactionLifecycle { evidence, persisted: true, .. } = &event.payload {
                if evidence.scope.session_id != rt.session_id || evidence.scope.tab_id != rt.tab_id { continue; }
                match evidence.observation {
                    CompactionObservation::ConnectionOpened { generation } => { open.insert((evidence.scope.clone(), generation), ()); }
                    CompactionObservation::ContinuityLost { generation, .. } => { open.remove(&(evidence.scope.clone(), generation)); }
                    _ => {},
                }
            }
        }
        let mut open: Vec<_> = open.into_keys().collect();
        open.sort_by_key(|(_, generation)| *generation);
        for (scope, generation) in open {
            let continuous = !rt.compaction.degraded && rt.compaction.owners.get(&scope).is_some_and(|owner| owner.connection == generation && current(rt, &scope, owner));
            if continuous { continue; }
            rt.compaction.owners.remove(&scope);
            let evidence = CompactionEvidence { scope, observation: CompactionObservation::ContinuityLost { generation, reason: CompactionLoss::Restarted } };
            let event = match self.commit_compaction(rt, evidence, false)? { Publication::Committed(e) | Publication::Uncertain(e) => e };
            events.push(event);
        }
        Ok(())
    }
}
