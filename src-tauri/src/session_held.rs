//! Reader-owned follow-ups. Hold only during a running turn; idle prompts
//! send immediately. Mutations and delivery use send admission.
use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub items: Vec<Item>,
    pub paused: bool,
    #[serde(default)]
    pub sending: Option<String>,
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub text: String,
    pub images: Vec<ImageRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Change {
    Enqueue { text: String, #[serde(default)] images: Vec<ImageInput>, #[serde(default)] send_now: bool },
    Edit { id: String, text: String },
    Delete { id: String },
    Move { id: String, before_id: Option<String> },
    Pause { paused: bool },
    SendNow { id: String },
}

#[derive(Debug, thiserror::Error)]
pub(super) enum Block {
    #[error("Waiting for the agent's earlier messages to finish.")]
    WaitingForCli,
    #[error("{0}")]
    NeedsAttention(String),
}

impl Queue {
    pub fn replay(events: &[AgentEvent]) -> Self {
        let mut queue = Self::default();
        for event in events.iter().filter(|e| e.subagent.is_none()) {
            match &event.payload {
                Payload::HeldQueue { queue: saved } => queue = saved.clone(),
                // Admission excludes other senders until this delivery publishes
                // its prompt. A crash between that and the final queue snapshot
                // must not offer the already-published message a second time.
                Payload::UserMessage { text, images, .. } if queue.items.iter().any(|item|
                    Some(&item.id) == queue.sending.as_ref() && &item.text == text && item.images.len() == images.len()) => {
                    let id = queue.sending.take().unwrap();
                    queue.items.retain(|item| item.id != id);
                    queue.next = None;
                }
                _ => {}
            }
        }
        queue
    }

    pub fn restore(path: &Path) -> Result<Self> {
        let mut queue = Self::replay(&store::read_lines(path)?);
        let interrupted = queue.sending.take().is_some();
        if queue.next.take().is_some() || interrupted {
            queue.paused = true;
            queue.error = Some("Delivery was interrupted. Check whether the agent already received this message before resuming; delete it if it did.".into());
        }
        Ok(queue)
    }

    fn position(&self, id: &str) -> Result<usize> {
        self.items.iter().position(|item| item.id == id).context("That follow-up has already left the queue.")
    }

    fn enabled(&self) -> bool {
        !self.items.is_empty() && (!self.paused || self.next.is_some()) && self.sending.is_none()
    }

    pub(super) fn keeps_runtime_busy(&self) -> bool {
        self.sending.is_some() || self.enabled()
    }

    pub(super) fn blocked(&self, rt: &TabRuntime) -> Option<Block> {
        let reason = if rt.stopping || rt.stop_in_flight {
            "Stop has not finished. Retry Stop, then resume the queue."
        } else if rt.restart_claim.is_some() || rt.stdio_starting {
            "The agent is starting. Resume the queue once it is ready."
        } else if !rt.pending.is_empty() {
            "The agent needs a response. Answer its pending request, then resume the queue."
        } else if matches!(&rt.engine, Engine::Cli(cli) if cli.awaiting_delivery.is_some() || !cli.held.is_empty()) {
            // A Stop can arrive before the CLI echoes its next prompt. That
            // is ordinary queue ordering, not a reason to pause app delivery.
            // An explicit retry or recovery still needs an actionable error.
            if rt.recovery.is_none() && self.next.is_none() { return Some(Block::WaitingForCli); }
            if matches!(&rt.engine, Engine::Cli(cli) if cli.awaiting_delivery.is_some()) {
                "The agent has not confirmed an earlier message. Check its terminal or stop the agent, then use Send now to retry."
            } else {
                "Earlier messages are still in the agent's queue. Let them finish, or stop the agent, then resume this queue."
            }
        } else {
            let kind = rt.recovery.filter(|_| self.next.is_none())?;
            return Some(Block::NeedsAttention(format!("{} Held follow-ups are paused. When ready, use Resume or Send now to retry.", kind.message())));
        };
        Some(Block::NeedsAttention(reason.into()))
    }
}

impl SessionManager {
    /// Archive sweeps need only membership, not a transcript. Prefer a live
    /// runtime; unchanged unopened logs are parsed once across sweeps.
    pub(crate) fn has_held_queue(&self, session: &str, tab: &str) -> Result<bool> {
        let live = self.tabs.lock().unwrap().get(&key_of(session, tab)).cloned();
        if let Some(rt) = live { return Ok(!rt.lock().unwrap().held_queue.items.is_empty()); }
        type Stamp = (u64, std::time::SystemTime);
        type PendingLogs = std::collections::HashMap<PathBuf, (Stamp, bool)>;
        static CACHE: std::sync::OnceLock<Mutex<PendingLogs>> = std::sync::OnceLock::new();
        let cache = CACHE.get_or_init(Mutex::default);
        let path = store::log_path(session, tab)?;
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let stamp = (metadata.len(), metadata.modified()?);
        if let Some((cached_stamp, pending)) = cache.lock().unwrap().get(&path) {
            if *cached_stamp == stamp { return Ok(*pending); }
        }
        let pending = !Queue::restore(&path)?.items.is_empty();
        let mut cache = cache.lock().unwrap();
        if cache.len() >= 1024 { cache.clear(); }
        cache.insert(path, (stamp, pending));
        Ok(pending)
    }

    pub(super) fn held_event(rt: &TabRuntime, queue: Queue) -> AgentEvent {
        AgentEvent {
            id: uuid::Uuid::now_v7().to_string(), session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(),
            harness: rt.harness.clone(), seq: rt.seq + 1, ts: index::now(), message_ts: None, subagent: None,
            payload: Payload::HeldQueue { queue },
        }
    }

    /// Unlike transcript previews, a queue edit is acknowledged only after its
    /// durable record is written. A failed write leaves the old queue intact.
    pub(super) fn save_held(&self, rt: &mut TabRuntime, queue: Queue) -> Result<AgentEvent> {
        let event = Self::held_event(rt, queue.clone());
        // Queue edits are durable before they are acknowledged, including a
        // claim made before typing. Roll back a partial append on disk-full.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&rt.log_path)?;
        let before = file.metadata()?.len();
        let line = format!("{}\n", serde_json::to_string(&event)?);
        if let Err(error) = file.write_all(line.as_bytes()).and_then(|()| file.sync_data()) {
            let _ = file.set_len(before);
            return Err(error.into());
        }
        rt.seq = event.seq;
        rt.held_queue = queue;
        self.sink.emit("agent_event", &event);
        Ok(event)
    }

    /// Once a prompt was accepted or delivered, a failed outcome write must
    /// not put it back in the composer or leave the tray showing a live claim.
    fn record_held_outcome(&self, rt: &mut TabRuntime, mut queue: Queue) -> AgentEvent {
        match self.save_held(rt, queue.clone()) {
            Ok(event) => event,
            Err(error) => {
                log::warn!("persist held delivery outcome: {error:#}");
                queue.paused = true;
                queue.next = None;
                queue.error = Some("Could not save the queue state. Check whether the agent received the message before resuming; delete it if it did.".into());
                self.show_held(rt, queue)
            }
        }
    }

    fn show_held(&self, rt: &mut TabRuntime, queue: Queue) -> AgentEvent {
        let event = Self::held_event(rt, queue.clone());
        rt.seq = event.seq;
        rt.held_queue = queue;
        self.sink.emit("agent_event", &event);
        event
    }

    pub fn change_held(&self, session: &str, tab: &str, change: Change) -> Result<SendOutcome> {
        self.accepting_work()?;
        let admission = crate::issue_pipeline::admission::lock_for(session, tab);
        let rt_arc = self.runtime(session, tab)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.stopping || rt.stop_in_flight { bail!("Wait for Stop to finish before changing the queue."); }
        if let Change::Enqueue { text, images, send_now } = change {
            if text.trim().is_empty() && images.is_empty() { bail!("Write a message or attach an image first."); }
            if !rt.turn_open_for_prompts() {
                // A fresh idle prompt is a normal send, even when an older
                // queue is paused or the previous turn needs recovery.
                drop(rt);
                return self.send_held_admitted(&admission, session, tab, text, images, Some(send_now));
            }
            return self.enqueue_held(session, tab, &rt_arc, rt, text, images, send_now);
        }
        let mut queue = rt.held_queue.clone();
        let mut interrupt = false;
        let mut deliver = false;
        match change {
            Change::Enqueue { .. } => unreachable!("new follow-ups are routed above"),
            Change::Edit { id, text } => {
                let pos = queue.position(&id)?;
                if text.trim().is_empty() && queue.items[pos].images.is_empty() { bail!("A follow-up needs text or an image."); }
                queue.items[pos].text = text;
            }
            Change::Delete { id } => {
                let pos = queue.position(&id)?;
                queue.items.remove(pos);
                if queue.next.as_deref() == Some(&id) { queue.next = None; }
            }
            Change::Move { id, before_id } => {
                let pos = queue.position(&id)?;
                if before_id.as_deref() != Some(&id) {
                    if let Some(before) = &before_id { queue.position(before)?; }
                    let item = queue.items.remove(pos);
                    let target = before_id.as_deref().map(|id| queue.position(id)).transpose()?.unwrap_or(queue.items.len());
                    queue.items.insert(target, item);
                }
            }
            Change::Pause { paused } => {
                queue.paused = paused;
                queue.error = None;
                if paused { queue.next = None; }
                else if !rt.turn_open_for_prompts() { queue.next = queue.items.first().map(|item| item.id.clone()); }
                deliver = !paused;
            }
            Change::SendNow { id } => {
                queue.position(&id)?;
                queue.next = Some(id);
                interrupt = rt.turn_open;
                deliver = true;
            }
        }
        let event = self.save_held(&mut rt, queue)?;
        drop(rt);
        // Keep admission until Escape is sent: an automatic dispatch cannot
        // overtake the selected item while the interrupted turn settles.
        if interrupt && !self.interrupt(session, tab).unwrap_or(false) && rt_arc.lock().unwrap().turn_open_for_prompts() {
            let mut rt = rt_arc.lock().unwrap();
            let mut queue = rt.held_queue.clone();
            queue.next = None;
            queue.paused = true;
            queue.error = Some("Could not interrupt the agent. Stop it, then use Send now to retry the held follow-up.".into());
            let failed = self.record_held_outcome(&mut rt, queue);
            return Ok(SendOutcome { queued: true, events: vec![event, failed], in_input: false });
        }
        drop(admission);
        if deliver { self.schedule_held(&rt_arc.lock().unwrap()); }
        Ok(SendOutcome { queued: true, events: vec![event], in_input: false })
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn enqueue_held(&self, session: &str, tab: &str, rt_arc: &Arc<Mutex<TabRuntime>>,
        mut rt: MutexGuard<'_, TabRuntime>, text: String, images: Vec<ImageInput>, send_now: bool) -> Result<SendOutcome> {
        let (images, _) = Self::archive_images(session, &images)?;
        let mut queue = rt.held_queue.clone();
        let id = uuid::Uuid::now_v7().to_string();
        queue.items.push(Item { id: id.clone(), text, images });
        if send_now { queue.next = Some(id); }
        let event = self.save_held(&mut rt, queue)?;
        drop(rt);
        // The caller keeps admission until Escape is sent and the worker
        // cannot overtake this selection.
        let interrupted = if send_now { self.interrupt(session, tab) } else { Ok(true) };
        let mut rt = rt_arc.lock().unwrap();
        if !interrupted.unwrap_or(false) && rt.turn_open_for_prompts() {
            let mut queue = rt.held_queue.clone();
            queue.next = None;
            queue.paused = true;
            queue.error = Some("Could not interrupt the agent. Stop it, then use Send now to retry the held follow-up.".into());
            let failed = self.record_held_outcome(&mut rt, queue);
            return Ok(SendOutcome { queued: true, events: vec![event, failed], in_input: false });
        }
        self.schedule_held(&rt);
        Ok(SendOutcome { queued: true, events: vec![event], in_input: false })
    }

    /// The host's normal send semantics, including takeover of a shared tab.
    #[allow(clippy::too_many_arguments)]
    fn send_held_admitted(&self, admission: &crate::issue_pipeline::admission::Admitted,
        session: &str, tab: &str, text: String, images: Vec<ImageInput>, hold_if_busy: Option<bool>) -> Result<SendOutcome> {
        let mut sharing = self.sharing.lock().unwrap();
        let author = sharing.sessions.get_mut(session).map(|share| {
            share.host_takeover(tab, chrono::Utc::now().timestamp_millis());
            self.sink.emit("session_share_changed", &serde_json::json!({"sessionId": session, "state": share.snapshot(chrono::Utc::now().timestamp_millis(), true)}));
            share.host.clone()
        });
        let prompt = PromptText { hold_if_busy, mobile: None, agent: text.clone(), display: text, author, shared_connection: None };
        // As send_pressed does, hold sharing through admission for a shared tab.
        if prompt.author.is_none() { drop(sharing); }
        self.send_admitted(admission, session, tab, prompt, images, None, crate::recovery_log::Origin::Composer)
    }

    pub(super) fn schedule_held(&self, rt: &TabRuntime) {
        if !rt.held_queue.enabled() || (rt.turn_open_for_prompts() && rt.recovery.is_none()) { return; }
        if matches!(rt.held_queue.blocked(rt), Some(Block::WaitingForCli)) { return; }
        let (manager, session, tab) = (self.clone(), rt.session_id.clone(), rt.tab_id.clone());
        std::thread::spawn(move || {
            if let Err(error) = manager.deliver_held(&session, &tab) {
                log::warn!("deliver held follow-up {session}/{tab}: {error:#}");
            }
        });
    }

    pub(super) fn pause_held_for_stop(&self, rt: &mut TabRuntime) {
        if rt.held_queue.items.is_empty() { return; }
        let mut queue = rt.held_queue.clone();
        queue.paused = true;
        queue.next = None;
        if let Err(error) = self.save_held(rt, queue.clone()) {
            // A full disk must not prevent Stop. Keep the in-memory fence.
            log::warn!("persist queue pause before Stop: {error:#}");
            queue.error = Some("The queue is paused, but its pause could not be saved. Check the queue after restarting the app.".into());
            self.show_held(rt, queue);
        }
    }

    pub(super) fn deliver_held(&self, session: &str, tab: &str) -> Result<()> {
        self.accepting_work()?;
        let admission = crate::issue_pipeline::admission::lock_for(session, tab);
        let rt_arc = self.runtime(session, tab)?;
        let mut rt = rt_arc.lock().unwrap();
        if !rt.held_queue.enabled() { return Ok(()); }
        match rt.held_queue.blocked(&rt) {
            Some(Block::WaitingForCli) => return Ok(()),
            Some(Block::NeedsAttention(reason)) => {
                let mut queue = rt.held_queue.clone();
                queue.paused = true;
                queue.next = None;
                queue.error = Some(reason);
                self.record_held_outcome(&mut rt, queue);
                return Ok(());
            }
            None => {}
        }
        if rt.turn_open_for_prompts() { return Ok(()); }
        let mut queue = rt.held_queue.clone();
        let pos = queue.next.as_deref().map(|id| queue.position(id)).transpose()?.unwrap_or(0);
        let item = queue.items[pos].clone();
        queue.sending = Some(item.id.clone());
        if let Err(error) = self.save_held(&mut rt, queue) {
            let mut queue = rt.held_queue.clone();
            queue.paused = true;
            queue.next = None;
            queue.error = Some("Could not save the delivery claim. The follow-up is still held. Free disk space, then use Resume or Send now to retry.".into());
            self.show_held(&mut rt, queue);
            return Err(error);
        }
        drop(rt);
        let outcome = item.images.iter().map(unsent::image_input).collect::<Result<Vec<_>>>()
            .and_then(|images| self.send_held_admitted(&admission, session, tab, item.text, images, None));
        let mut rt = rt_arc.lock().unwrap();
        let mut queue = rt.held_queue.clone();
        queue.sending = None;
        queue.next = None;
        match outcome {
            Ok(_) => { queue.items.retain(|held| held.id != item.id); queue.error = None; }
            // The final send lock checks blocked() again. If earlier CLI
            // input appeared after the claim, release it and wait for the
            // next boundary, without dropping the item or pausing delivery.
            Err(error) if matches!(error.downcast_ref::<Block>(), Some(Block::WaitingForCli)) => {}
            Err(error) => {
                queue.paused = true;
                let reason = recovery::detail(&error.to_string()).unwrap_or_else(|| "Could not deliver the follow-up.".into());
                queue.error = Some(format!("{reason} The follow-up is still held. Use Send now to retry, or delete it."));
            }
        }
        // Keep consumption visible even when the final snapshot cannot be
        // saved. Replay also consumes the logged user_message after a crash.
        self.record_held_outcome(&mut rt, queue);
        // A very short turn can finish before its send call returns. Its
        // boundary saw the claim; continue now that the claim has settled.
        if rt.status == TabStatus::Completed { self.schedule_held(&rt); }
        Ok(())
    }
}
